import { deserializeAccount, Network, U64Utils } from "@orca-so/sdk";
import { AccountMetaReadonly, jsonInfo2PoolKeys, Liquidity, LiquidityPoolJsonInfo, TokenAmount, WSOL } from "@raydium-io/raydium-sdk";
import { MAINNET_SPL_TOKENS } from "./common/src/raydium-utils/tokens";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction, TransactionInstruction } from "@solana/web3.js";
import Decimal from "decimal.js";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { get, getDatabase, onChildChanged, onValue, ref, set, update } from "firebase/database";
import { addDoc, collection, getFirestore, serverTimestamp } from "firebase/firestore";
import { readFile } from "mz/fs";
// ~~~~~~ firebase configs ~~~~~~
import config from "./common/src/config";
import BN from "bn.js";
import base from "base-x"
const base58 = base("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
import { parseLogForPoolInfo, getRaydiumPoolInfoFromLogs, parseMsg } from "./common/src/on-chain-rate-instruction-utils/utils";
import { CONNECTION_COMMITMENT, CONNECTION_ENDPOINT_LIST, useConnection } from "./common/src/connection";
import { swap as orcaSwap } from "./common/src/orca-utils/orca-swap-funcs";
import * as RaydiumRateFuncs from "./common/src/raydium-utils/raydium-rate-funcs";
import { NATIVE_SOL, swap as raydiumSwap } from "./common/src/raydium-utils/raydium-swap-funcs";
import { createAssociatedTokenAccountIfNotExist } from "./common/src/raydium-utils/web3";
import { RAYDIUM_POOLS_ENDPOINT, listeners as raydiumListeners } from "./common/src/raydium-utils/constants";
import { listeners as orcaListeners } from "./common/src/orca-utils/constants";
import { OrcaPoolImpl } from "@orca-so/sdk/dist/model/orca/pool/orca-pool";
import { fetchWithTimeout } from "./common/src/fetch-timeout";
import fetch from "node-fetch"
import { u64 } from "@solana/spl-token";


const firebaseConfig = {
    apiKey: config.FIREBASE_API_KEY,
    authDomain: config.FIREBASE_DOMAIN,
    databaseURL: config.FIREBASE_DATABASE_URL,
    projectId: config.FIREBASE_PROJECT_ID,
    storageBucket: config.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: config.FIREBASE_MESSAGING_SENDER_ID,
    appId: config.FIREBASE_APP_ID
};

const DISCORD_STATUS_WEBHOOK = process.env.DISCORD_STATUS_WEBHOOK; // change this for general channel
// Hot patches to token info
MAINNET_SPL_TOKENS["SOL"] = {
    ...WSOL,
};

MAINNET_SPL_TOKENS["ETH"] = {
    ...MAINNET_SPL_TOKENS["ETH"],
    mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    name: "Ether (Portal)", // TODO: fix ETH-USDC pool
    decimals: 8
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Get a reference to the database service
const database = getDatabase(app);
const firestore = getFirestore(app);
// ~~~~~~ firebase configs ~~~~~~

const args = process.argv.slice(2);

const BASE_TOKEN = args.length > 1 ? args[1] : "USDC";

const WALLET_KEY_PATH = process.env.WALLET_KEY_PATH ?? "/home/corridor/development/solarbitrage/backend/bot/wallet-keypair.json"
const STARTING_SLIPPAGE = 0;
const THRESHOLD = 0;
const STARTING_BET = args.length > 2 ? parseInt(args[2]) : 5;
let ADDITIONAL_SLIPPAGE = 0.005; // modifiable by firebase
let VALID_TOKENS = []; // modifiable by firebase

let ready_to_trade = true;  // flag to look for updates only when a swap intruction is done

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

const getNewConnection = useConnection(false, {
    disableRetryOnRateLimit: true,
    confirmTransactionInitialTimeout: 3000,
    fetch: (url, opts) => fetchWithTimeout(fetch, url, {...opts, timeout: 3000}),
});

// use this to get the latest price of a token
let connection = getNewConnection();

// use this connection to make swaps
const mainConnection = new Connection(CONNECTION_ENDPOINT_LIST[0], CONNECTION_COMMITMENT);

const poolKeysMap = {};
const poolAddrToOrcaPool = {};
let tokenAccounts = {};

orcaListeners.map(([pool, _]) => poolAddrToOrcaPool[pool.address.toBase58()] = pool);

let owner: Keypair;

let local_database: any = {};
let pool_to_slippage_map: {[key:string]: [number, number]} = {};

// function to set up local copy of the database
async function query_pools() {
    const latest_price = ref(database, 'latest_prices/');
    return get(latest_price).then((snapshot) => {
        if (!snapshot.exists()) throw new Error("Snapshot doesn't exist");
        return snapshot.val();
    })
}

async function get_slippages() {
    const slip_map = ref(database, 'mainnet_pool_to_slippage_map/');
    return get(slip_map).then((snapshot) => {
        if (!snapshot.exists()) return {};
        const data = snapshot.val();
        const ret = {}
        for (const key of Object.keys(data)) {
            ret[key] = [data[key]["0"] || (1-STARTING_SLIPPAGE), data[key]["1"] || (1-STARTING_SLIPPAGE)]
        }
        return ret;
    })
}

async function set_slippages(val) {
    const slip_map = ref(database, 'mainnet_pool_to_slippage_map/');
    return set(slip_map, val);
}

async function main() {
    debugger;
    // ==== Setup 
    // Read secret key file to get owner keypair
    const secretKeyString = await readFile(WALLET_KEY_PATH, {
        encoding: "utf8",
    });

    const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
    owner = Keypair.fromSecretKey(secretKey);

    const lpMetadata = await fetch(RAYDIUM_POOLS_ENDPOINT).then(res => res.json())
    const lpPools: LiquidityPoolJsonInfo[] = [
        ...lpMetadata["official"],
        ...lpMetadata["unOfficial"],
    ].filter((val) => raydiumListeners.includes(val.id));
    
    for (const pool of lpPools) {
        poolKeysMap[pool.id] = jsonInfo2PoolKeys(pool);
    }

    // get valid token list
    let gotValidTokens = undefined;
    const waitForValidTokens = new Promise((resolve, _) => {gotValidTokens = resolve});

    const config_pools = ref(database, 'currencies_to_use');
    onValue(config_pools, (snapshot) => {
        if (gotValidTokens) {
            gotValidTokens();
            gotValidTokens = undefined;
        }
        VALID_TOKENS = Object.keys(snapshot.val()).filter(function(currency) {
            return snapshot.val()[currency];
        }); 
        console.log("NEW VALID TOKEN:", VALID_TOKENS);
    });

    console.log("Waiting for valid tokens...");
    await waitForValidTokens;
    console.log({ VALID_TOKENS })

    // local_database setup
    const queries = await query_pools();
    console.log("local_database setup");
    local_database = queries;
    let middleTokenToPoolMap = getMiddleTokenToPoolMap(BASE_TOKEN);

    // setup slippage's per pool_id
    pool_to_slippage_map = await get_slippages();
    for (const poolId of Object.keys(local_database)) {
        if (!pool_to_slippage_map[poolId]) {
            pool_to_slippage_map[poolId] = [1-STARTING_SLIPPAGE, 1-STARTING_SLIPPAGE];
        }
    }

    const slip_map = ref(database, 'mainnet_pool_to_slippage_map/');
    onValue(slip_map, (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.val();
        for (const key of Object.keys(data)) {
            pool_to_slippage_map[key] = [data[key]["0"] || (1-STARTING_SLIPPAGE), data[key]["1"] || (1-STARTING_SLIPPAGE)]
        }
    });

    // setup token account
    await setupTokenAccounts(Object.keys(middleTokenToPoolMap));
    console.log("setup WSOL Token Account");

    // get token accounts
    tokenAccounts = await getTokenAccounts();

    const loop = () => {
        middleTokenToPoolMap = getMiddleTokenToPoolMap(BASE_TOKEN);
        const middleTokenToRouteMap = getMiddleTokenToRoutesMap(middleTokenToPoolMap);
        const profitableRoutes = []
        ready_to_trade = false;

        for (const middleTokenName of Object.keys(middleTokenToRouteMap)) {
            if (middleTokenToRouteMap[middleTokenName].length > 0) {
                profitableRoutes.push(middleTokenToRouteMap[middleTokenName][0])
            }
        }

        console.table(
            Object.keys(pool_to_slippage_map)
                .map(poolId => ({ "Pool": poolId, "Buy Rate Multiplier": (pool_to_slippage_map[poolId][0]).toFixed(4), "Sell Rate Multiplier": (pool_to_slippage_map[poolId][1]).toFixed(4) }))
        )


        console.table(profitableRoutes
            .sort((a, b) => b.estimatedProfit - a.estimatedProfit)
            .map(r => ({
                [`Estimated Profit per 1 ${BASE_TOKEN}`]: r.estimatedProfit,
                "First Pool": r.route[0].pool_id,
                "Second Pool": r.route[1].pool_id
            })));

        return Promise.all(profitableRoutes.sort((a, b) => b.estimatedProfit - a.estimatedProfit).map((r, i) => calculate_trade(r, i)))
            .then(() => {
                ready_to_trade = true;
            })
            .catch(e => console.error(e))
    }
    

    // ==== Start listener
    const updated_pools = ref(database, 'latest_prices/');
    onChildChanged(updated_pools, (snapshot) => {
        const data = snapshot.val();
        local_database[snapshot.key] = data;
    });

    // ==== Start listener
    const config_slippage = ref(database, 'configuration/acceptable_slippage');
    onValue( config_slippage, (snapshot) => {
        ADDITIONAL_SLIPPAGE = snapshot.val();
    });

    for (;;) {
        const dateString = new Date().toLocaleString()
        console.log(dateString, "-".repeat(Math.max(process.stdout.columns - dateString.length - 1, 0)))
        await loop();
        await new Promise((resolve) => setTimeout(resolve, 60));
    }
}
signInWithEmailAndPassword(auth, config.FIREBASE_EMAIL, config.FIREBASE_PASSWORD)
  .then(() => {
    // Signed in..
    console.log("Signed in!");
    main().then(() => {}).catch(e => {console.error("FATAL", e); process.exit(1)})
  })
  .catch((error) => {
    const errorCode = error.code;
    const errorMessage = error.message;
    console.log(errorMessage);
    // ...
  });

async function calculate_trade({route, estimatedProfit}, index) {
    let starting = STARTING_BET;

    // don't bother if it is not profitable or if RNG gods say so
    if (estimatedProfit <= THRESHOLD && (args[0] !== "SLIP_CHECK" || index < 2 || Math.random() > 0.3)) return;
 
    // if the route is not profitable then don't make swap functions, just test out slippage
    const startTime = Date.now();
    const interval = setInterval(() => {
        console.log(`waiting on ${route[0].pool_id} -> ${route[1].pool_id}; time elapsed: ${(Date.now() - startTime) / 1000}s`);
    }, 5000);
    try {
        await arbitrage(route, starting, starting + (starting * estimatedProfit), estimatedProfit <= THRESHOLD)
    } catch (e) {
        console.error(e);
    }
    clearInterval(interval);
}

enum RouteOrder { 
    OrcaThenRaydium = 0,
    RaydiumThenOrca = 1,
    OrcaThenOrca = 2,
    RaydiumThenRaydium = 3
}


// 1st set up local database
// update database on changes, if change is found, calculate the rate differences to check for profitable trades
// if profitable trade exists, conduct a swap.
// only after a swap is done, look for another database update?
const arbitrage = async (route, fromCoinAmount: number, _expected_end, shouldSkipSwap?: boolean) => {
    const current_pool_to_slippage = JSON.parse(JSON.stringify(pool_to_slippage_map))
    let transactionId = "";
    const profitMsg = {
        "content": "MADE A PROFIT! 🎉"
    }   

    const transaction = new Transaction();
    const swapTransactions = new Transaction();
    transaction.feePayer = owner.publicKey;
    swapTransactions.feePayer = owner.publicKey;
    const signers = [];


    let beforeAmt = fromCoinAmount;
    const providers = route.map(r => r.provider || r.pool_id.split("_")[0].split("|")[0]);
    const routeOrder = (() => {
        if (providers[0] === "ORCA" && providers[1] === "RAYDIUM") {
            return RouteOrder.OrcaThenRaydium;
        } else if (providers[0] === "RAYDIUM" && providers[1] === "ORCA") {
            return RouteOrder.RaydiumThenOrca;
        } else if (providers[0] === "ORCA" && providers[1] === "ORCA") {
            return RouteOrder.OrcaThenOrca;
        } else if (providers[0] === "RAYDIUM" && providers[1] === "RAYDIUM") {
            return RouteOrder.RaydiumThenRaydium;
        }
    })();
    try {
        for (const [i, pool] of route.entries()) {
            const pool_id = pool.pool_id;
            const provider = pool.provider || pool_id.split("_")[0].split("|")[0]; // lol
            const pool_addr = pool.pool_addr;

            const slippage = current_pool_to_slippage[pool_id][i];
            const newTokenAmt = i === 0 ? (beforeAmt * pool.buy.rate * slippage) : (beforeAmt * pool.sell.rate * slippage);

            const fromTokenStr = (i === 0 ? pool.buy.from : pool.sell.from);
            const toTokenStr = (i === 0 ? pool.buy.to : pool.sell.to);

            if (provider === "RAYDIUM") {
                const fromToken = fromTokenStr === "SOL" ? NATIVE_SOL : MAINNET_SPL_TOKENS[fromTokenStr];
                const toToken = toTokenStr === "SOL" ? NATIVE_SOL : MAINNET_SPL_TOKENS[toTokenStr];

                const poolKeys = poolKeysMap[pool_addr];

                // add rate info instruction
                transaction.add(Liquidity.makeSimulatePoolInfoInstruction({ poolKeys }));

                const connection = getNewConnection();
                if (!shouldSkipSwap) {
                    const res = await raydiumSwap(
                        connection,
                        owner,
                        poolKeys,
                        fromToken,
                        toToken,
                        tokenAccounts[fromToken.mint]?.tokenAccountAddress,
                        tokenAccounts[toToken.mint]?.tokenAccountAddress,
                        beforeAmt.toString(),
                        i === 0 ? newTokenAmt.toString() : fromCoinAmount.toString(), // if it is the second swap then we should set the minimum out to be the same as the input
                        tokenAccounts[WSOL.mint]?.tokenAccountAddress
                    );
                    swapTransactions.add(res.transaction);
                    signers.push(...res.signers);
                }
            } else if (provider === "ORCA") {
                const connection = getNewConnection();

                const poolParam = poolAddrToOrcaPool[pool_addr];
                const currentPool = new OrcaPoolImpl(connection, Network.MAINNET, poolParam)
      
                const coinA = currentPool.getTokenA();
                const coinB = currentPool.getTokenB();
          
                const poolTokens = {
                    [coinA.tag]: coinA,
                    [coinB.tag]: coinB
                }

                const fromToken = poolTokens[fromTokenStr];
                const toToken = poolTokens[toTokenStr];

                // add rate info instruction
                transaction.add(new TransactionInstruction({
                    programId: new PublicKey("8D7UaJcASNVK9m6wbJvRebPFn6kbfg5m2t4Vt8MpKxrL"),
                    keys: [
                        AccountMetaReadonly(new PublicKey(fromToken.addr), false),
                        AccountMetaReadonly(new PublicKey(toToken.addr), false),
                        AccountMetaReadonly(new PublicKey(owner.publicKey), true)
                    ],
                    data: Buffer.from(
                        /* order           */ `${routeOrder}\n`+
                        /* poolAddrs[0]    */ `${route[0].pool_addr}\n`+
                        /* poolAddrs[1]    */ `${route[1].pool_addr}\n`+
                        /* baseToken       */ `${route[0].buy.from}\n`+
                        /* middleToken     */ `${route[0].buy.to}\n`+
                        /* startingAmount  */ `${fromCoinAmount}\n`+
                        /* afterFirstSwap  */ `${parseFloat((fromCoinAmount * route[0].buy.rate * current_pool_to_slippage[route[0].pool_id][0]).toFixed(6))}\n`+
                        /* afterSecondSwap */ `${parseFloat((fromCoinAmount * route[0].buy.rate * current_pool_to_slippage[route[0].pool_id][0] * route[1].sell.rate * current_pool_to_slippage[route[1].pool_id][1]).toFixed(6))}`
                    )
                }));
            
                if (!shouldSkipSwap) {
                    const { transactionPayload } = await orcaSwap(
                        currentPool, 
                        owner, 
                        fromToken, 
                        new Decimal(beforeAmt), 
                        new Decimal(i === 0 ? newTokenAmt : fromCoinAmount), // if it is the second swap then we should set the minimum out to be the same as the input
                        new PublicKey(tokenAccounts[fromToken.mint.toBase58()]?.tokenAccountAddress),
                        new PublicKey(tokenAccounts[toToken.mint.toBase58()]?.tokenAccountAddress),
                    );
                    swapTransactions.add(transactionPayload.transaction);
                    signers.push(...transactionPayload.signers); 
                }

            }

            beforeAmt = newTokenAmt;
        }

        transaction.add(swapTransactions);

        if (!shouldSkipSwap) {
            const beforeParsedInfo = tokenAccounts[MAINNET_SPL_TOKENS["USDC"].mint]?.parsedInfo;
            const beforeUSDC = parseFloat(beforeParsedInfo.tokenAmount.uiAmount);
            console.log("SENDING TRANSACTION")
            let failed = false;
            try {
                transactionId = await sendAndConfirmTransaction(mainConnection, transaction, signers, {commitment: "singleGossip", skipPreflight: true});
            } catch(e) {
                failed = true;
                console.error(e.message);
                if (e.message.includes("Transaction") && e.message.includes(" failed ({\"err\"")) {
                    transactionId = e.message.split("Transaction ")[1].split(" failed")[0]
                }
            }
            console.log({ transactionId });

            if (!transactionId) return;

            console.time(transactionId);
            mainConnection.getTransaction(transactionId, {commitment: "finalized"})
            .then(async parsedTx => {
                let count = 0;
                while (!parsedTx) {
                    parsedTx = await mainConnection.getTransaction(transactionId, {commitment: "finalized"})
                    count++;
                    if (count > 1000) {
                        throw new Error("Transaction not found");
                    }
                }
                return parsedTx
            }).then(async parsedTx => {
                console.timeEnd(transactionId);
                debugger;
                console.log("got tx details:", transactionId);
                const [parsedOrcaAccInfoAndMsg,] = parseLogForPoolInfo(parsedTx.meta.logMessages);
                const status = parseMsg(parsedOrcaAccInfoAndMsg.msg);
                
                const route = status.route.split(" -> ");
                
                for (const [i, poolId] of route.entries()) {
                    let currLogs = parsedTx.meta.logMessages
                    const pool_addr = status.poolAddrs[i];
                    const [provider, ] = poolId.split("_");
                    const fromTokenStr = i == 0 ? status.baseToken : status.middleToken;
                    const toTokenStr = i == 0 ? status.middleToken : status.baseToken;
                    
                    const estimatedAmtOut = i === 0 ? status.afterFirstSwap : status.afterSecondSwap;
                    const amountIn = i === 0 ? status.startingAmount : status.afterFirstSwap;
                    
                    if (provider.split("|")[0] === "RAYDIUM") {
                        const [parsedRaydiumAccInfo, nextLogs] = getRaydiumPoolInfoFromLogs(currLogs);
                        currLogs = nextLogs;
                        const fromToken = MAINNET_SPL_TOKENS[fromTokenStr];
                        const toToken = MAINNET_SPL_TOKENS[toTokenStr];
                        
                        const poolKeys = poolKeysMap[pool_addr];
                        
                        const amountOut = RaydiumRateFuncs.getRate(poolKeys, parsedRaydiumAccInfo, fromToken, toToken, amountIn);
                        const parsedAmountOut = (amountOut.amountOut.raw.toNumber() / Math.pow(10, toToken.decimals));
                        
                        const slippageShouldBe = parsedAmountOut / estimatedAmtOut;
                        console.warn(`POOL_ID{${poolId}}: old slippage: ${pool_to_slippage_map[poolId][i]} ;new slippage: ${slippageShouldBe}; actual: ${parsedAmountOut} estimate: ${estimatedAmtOut}`);
                        update(ref(database, 'mainnet_pool_to_slippage_map/'+poolId), { [i]: slippageShouldBe });
                    } else if (provider.split("|")[0] === "ORCA") {
                        const [orcaAccInfo, nextLogs] = parseLogForPoolInfo(currLogs);
                        currLogs = nextLogs;

                        const poolParam = poolAddrToOrcaPool[pool_addr];
                        const currentPool = new OrcaPoolImpl(connection, Network.MAINNET, poolParam)
                
                        const coinA = currentPool.getTokenA();
                        const coinB = currentPool.getTokenB();
                    
                        const poolTokens = {
                            [coinA.tag]: coinA,
                            [coinB.tag]: coinB
                        }

                        const inputAccAmtParsed = orcaAccInfo.inputAcc;
                        const outputAccAmtParsed = orcaAccInfo.outputAcc; 

                        const fromToken = poolTokens[fromTokenStr];

                        const quote = await currentPool.getQuoteWithPoolAmounts(fromToken, new Decimal(amountIn), new BN(inputAccAmtParsed) as any, new BN(outputAccAmtParsed) as any);
                        const parsedAmountOut = quote.getExpectedOutputAmount().toNumber();
                        const slippageShouldBe = parsedAmountOut / estimatedAmtOut;
                        console.warn(`POOL_ID{${poolId}}: old slippage: ${pool_to_slippage_map[poolId][i]} ;new slippage: ${slippageShouldBe}; actual: ${parsedAmountOut} estimate: ${estimatedAmtOut}`);
                        update(ref(database, 'mainnet_pool_to_slippage_map/'+poolId), { [i]: slippageShouldBe });
                    }
                }
                
            }).catch(e => console.error("ERROR_PARSING_TX", e));

            if (failed) return;

            // Repoll for token account data
            const afterTokenAccounts = await getTokenAccounts();
            if (!afterTokenAccounts[MAINNET_SPL_TOKENS["USDC"].mint])
                throw new Error("No USDC token account!");

            const parsedInfo = afterTokenAccounts[MAINNET_SPL_TOKENS["USDC"].mint]?.parsedInfo;
            const afterUSDC = parseFloat(parsedInfo.tokenAmount.uiAmount);
            
            // how much transaction, what coin, what profit -> using tokenaccounts
            // add the transaction id to be more informative
            let transaction_link = "\nhttps://solscan.io/tx/"+transactionId;
            profitMsg.content += transaction_link;

            fetch(DISCORD_STATUS_WEBHOOK, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(profitMsg)
            }).catch(err => console.error(err))
            profitMsg.content = "MADE A PROFIT! 🎉"     // reset to default message

            write_to_database(beforeUSDC, afterUSDC, fromCoinAmount - _expected_end, transactionId);
            tokenAccounts = {...afterTokenAccounts};
        }

    } catch (err) {
        console.error(`CONTEXT: ${route[0].pool_id} -> ${route[1].pool_id}\n`, err);
    }
}


function getMiddleTokenToPoolMap(mainToken: string) {
    const poolsWithUSDC = Object.keys(local_database)
        .filter(function (amm) {
            var [firstCurrency, secondCurrency] = amm.split('_').slice(1)
            const mainTokenExists = firstCurrency == mainToken || secondCurrency == mainToken;
            const firstTokenValid = VALID_TOKENS.includes(firstCurrency);
            const secondTokenValid = VALID_TOKENS.includes(secondCurrency);

            return mainTokenExists && firstTokenValid && secondTokenValid;
        })
        .map(pool => ({...local_database[pool], pool_id: pool, tokens: pool.split("_").slice(1)}));

    const mapFromMiddleTokenToPool = {};
    for (const pool of poolsWithUSDC) {
        let middleTokenName = ""
        for (const t of pool.tokens) {
            if (t !== mainToken) {
                middleTokenName = t;
                break;
            }
        }
        if (!(middleTokenName in mapFromMiddleTokenToPool)) {
            mapFromMiddleTokenToPool[middleTokenName] = []
        }

        mapFromMiddleTokenToPool[middleTokenName].push(pool);
    }

    return mapFromMiddleTokenToPool;
}

function getMiddleTokenToRoutesMap(middleTokenToPoolMap: any) {
    const middleTokenToRouteMap = {};

    for (const middleTokenName of Object.keys(middleTokenToPoolMap)) {
        if (!(middleTokenName in middleTokenToRouteMap)) {
            middleTokenToRouteMap[middleTokenName] = []
        }
        for (let x=0; x<middleTokenToPoolMap[middleTokenName].length; x++) {
            for (let y=x+1; y<middleTokenToPoolMap[middleTokenName].length; y++) {
                const a = middleTokenToPoolMap[middleTokenName][x];
                const b = middleTokenToPoolMap[middleTokenName][y];

                let estimatedProfits = {
                    "a then b": (1 * a.buy.rate * pool_to_slippage_map[a.pool_id][0] * b.sell.rate * pool_to_slippage_map[b.pool_id][1]) - 1,
                    "b then a": (1 * b.buy.rate * pool_to_slippage_map[b.pool_id][0] * a.sell.rate * pool_to_slippage_map[a.pool_id][1]) - 1
                }

                if (estimatedProfits["a then b"] > estimatedProfits["b then a"]) {
                    middleTokenToRouteMap[middleTokenName].push({route: [a, b], estimatedProfit: estimatedProfits["a then b"]})
                } else {
                    middleTokenToRouteMap[middleTokenName].push({route: [b, a], estimatedProfit: estimatedProfits["b then a"]})
                }   
            }
        }

        middleTokenToRouteMap[middleTokenName].sort((a, b) => b.estimatedProfit - a.estimatedProfit);
    }

    return middleTokenToRouteMap;
}

// write to firestore
async function write_to_database(_start: number, _end: number, _expected_profit: number, _transaction_id: string) {
    try {
        const docRef = await addDoc(collection(firestore, "trade_history"), {
            starting_amount: _start,
            ending_amount: _end,
            net_profit: (_end - _start),
            expected_profit: _expected_profit,
            transaction_id: _transaction_id,
            time_stamp: serverTimestamp()
        });
        console.log("Document written with ID: ", docRef.id);
    } catch (e) {
        console.error("Error adding document: ", e);
    }
}

async function getTokenAccounts() {
    const accounts = await mainConnection.getParsedTokenAccountsByOwner(owner.publicKey, { programId: TOKEN_PROGRAM_ID })

    // token account for Raydium
    const tokenAccounts = {};
    for (const tokenAccountInfo of accounts.value) {
        const tokenAccountPubkey = tokenAccountInfo.pubkey
        const tokenAccountAddress = tokenAccountPubkey.toBase58()
        const parsedInfo = tokenAccountInfo.account.data.parsed.info
        const mintAddress = parsedInfo.mint;
        const balance = new TokenAmount(parsedInfo.tokenAmount.amount, parsedInfo.tokenAmount.decimals)

        tokenAccounts[mintAddress] = {
            tokenAccountAddress,
            balance,
            parsedInfo
        }

        if (mintAddress === WSOL.mint) {
            tokenAccounts[NATIVE_SOL.mint] = {
                tokenAccountAddress,
                balance,
                parsedInfo
            }

        }
    }

    return tokenAccounts;
}

async function setupTokenAccounts(tokens: string[]) {
    const tokenAccounts = await getTokenAccounts();

    let transaction = new Transaction();
    let signers = [];

    signers.push(owner);

    for (let [i, token] of tokens.entries()) {
        if (token === "SOL") {
            token = "WSOL";
        }
        if (!tokenAccounts[MAINNET_SPL_TOKENS[token].mint]) {  
            console.log("creating token acc for", token)         
            await createAssociatedTokenAccountIfNotExist(
                null,
                owner.publicKey,
                MAINNET_SPL_TOKENS[token].mint,
                transaction
            )
        }

        if ((i+1) % 3 && transaction.instructions.length > 0) {
            const tx = await sendAndConfirmTransaction(mainConnection, transaction, signers, { commitment: "singleGossip" });
            transaction = new Transaction();
            signers = [owner];
            console.log("create token acc: ", tx)
        }
        
    }
    
    if (transaction.instructions.length > 0) {
        const tx = await sendAndConfirmTransaction(mainConnection, transaction, signers, { commitment: "singleGossip" });
        console.log("create token acc: ", tx)    
    }
}