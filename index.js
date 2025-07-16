// index.js (Node.js MEV Detector Service)

// Import necessary libraries.
// `ethers` is used to connect to the Ethereum node via WebSockets.
const { WebSocketProvider } = require('ethers');
// `Redis` client for caching and deduplication.
const Redis = require('ioredis');
// `Kafka` client for sending alerts.
const { Kafka } = require('kafkajs');

// Import our compiled Rust WASM module.
// Corrected import: using detect_mev_sandwich (snake_case) as exported by Rust WASM
const { detect_mev_sandwich } = require('./mev_engine/pkg');

// --- Configuration ---
// IMPORTANT: Replace 'ws://localhost:8546' with the actual WebSocket URL of your Ethereum node.
// If you're using a public node like Infura/Alchemy, their WebSocket URLs will start with `wss://`.
// For a local node (like Geth/Erigon in Docker), it's typically `ws://localhost:8546`.
const ETHEREUM_NODE_WS_URL = 'ws://localhost:8546'; // Example: Geth local node WS
const REDIS_URL = 'redis://localhost:6379'; // Default Redis URL
const KAFKA_BROKERS = ['localhost:9092']; // Default Kafka broker address
const KAFKA_TOPIC = 'mev-alerts'; // Kafka topic name for alerts
const REDIS_TTL_SECONDS = 300; // Time-to-live for Redis keys: 5 minutes (5 * 60 seconds)

// --- Initialize Clients ---
// Create an `ethers` WebSocket provider to connect to the Ethereum node.
const provider = new WebSocketProvider(ETHEREUM_NODE_WS_URL);
// Create a new Redis client instance.
const redis = new Redis(REDIS_URL);
// Create a new Kafka client instance.
const kafka = new Kafka({
    clientId: 'mev-bot-detector', // A unique ID for our Kafka client
    brokers: KAFKA_BROKERS,       // List of Kafka broker addresses
});
// Create a Kafka producer to send messages.
const producer = kafka.producer();

// --- Data Structures ---
// A simple in-memory Map to store pending transactions.
// The key is the transaction hash, and the value is the transaction object.
// In a very high-throughput production system, this might be a more sophisticated
// data structure or a temporary database like a fast in-memory store.
const pendingTransactions = new Map(); // Map<txHash, Transaction>

// Interval for processing transaction clusters for MEV detection.
// Every 1 second, we'll gather recent transactions and send them to Rust for analysis.
const BATCH_PROCESSING_INTERVAL = 1000; // milliseconds (1 second)

// Lifespan for transactions in our `pendingTransactions` map.
// Transactions older than this will be removed to prevent memory buildup.
const TRANSACTION_LIFESPAN_MS = 60 * 1000; // 60 seconds (1 minute)

// --- Helper Functions ---

/**
 * Simulates transaction clustering.
 * In a real MEV detection system, this would involve sophisticated logic
 * to group related transactions (e.g., by target contract, token pair,
 * or by identifying transactions within the same block or very close blocks).
 * For this demonstration, we'll simply return all currently pending transactions
 * that are within our defined `TRANSACTION_LIFESPAN_MS`.
 * @returns {Array<Object>} An array of recent pending transactions to be analyzed.
 */
function getTransactionCluster() {
    const now = Date.now();
    const cluster = [];
    // Iterate over all stored pending transactions.
    for (const [hash, tx] of pendingTransactions.entries()) {
        // Check if the transaction is still "fresh" (within its lifespan).
        if (now - tx.ingestionTime < TRANSACTION_LIFESPAN_MS) {
            cluster.push(tx); // Add fresh transactions to the cluster.
        } else {
            // If a transaction is too old, remove it from the map to free up memory.
            pendingTransactions.delete(hash);
        }
    }
    return cluster;
}

/**
 * Sends an alert message to the configured Kafka topic.
 * @param {Object} alertData - The payload of the alert, conforming to the specified schema.
 * Example: `{ "victim": "0x...", "attacker": "0x...", "profit_eth": 0.42, "timestamp": 1678901234 }`
 */
async function sendKafkaAlert(alertData) {
    try {
        // Send a single message to the Kafka topic.
        await producer.send({
            topic: KAFKA_TOPIC,
            messages: [
                { value: JSON.stringify(alertData) }, // Kafka messages are typically strings/buffers
            ],
        });
        console.log(`Alert sent to Kafka: ${JSON.stringify(alertData)}`);
    } catch (error) {
        console.error('Error sending message to Kafka:', error);
    }
}

/**
 * Checks Redis to see if an alert for a specific attacker address has been sent recently.
 * If not, it caches the attacker's address in Redis with a TTL (Time-To-Live)
 * to prevent duplicate alerts for the next 5 minutes.
 * @param {string} attackerAddress - The Ethereum address of the detected attacker bot.
 * @returns {Promise<boolean>} True if this is a new alert for this attacker (and should be sent), false otherwise.
 */
async function isNewAlert(attackerAddress) {
    // Construct the Redis key using the attacker's address.
    const redisKey = `mev:${attackerAddress}:last_alert`;
    // Attempt to get the value associated with this key from Redis.
    const lastAlertTimestamp = await redis.get(redisKey);

    if (lastAlertTimestamp) {
        // If a value exists, it means an alert for this attacker was sent recently.
        console.log(`Duplicate alert for attacker ${attackerAddress}. Skipping.`);
        return false;
    } else {
        // If no value exists, this is a new alert for this attacker.
        // Set the key in Redis with a TTL. `setex` means "SET with EXpiration".
        await redis.setex(redisKey, REDIS_TTL_SECONDS, Date.now());
        console.log(`New alert for attacker ${attackerAddress}. Caching for ${REDIS_TTL_SECONDS} seconds.`);
        return true;
    }
}

// --- Main Logic ---

/**
 * Starts the main mempool ingestion and MEV detection process.
 */
async function startMempoolIngestion() {
    console.log('Connecting to Ethereum node WebSocket...');
    // Connect the Kafka producer before starting to listen for transactions.
    await producer.connect();
    console.log('Kafka producer connected.');

    // Listen for 'pending' transactions from the Ethereum node.
    // `provider.on('pending', ...)` is an event listener that fires whenever
    // a new transaction enters the mempool (is seen by the node).
    provider.on('pending', async (txHash) => {
        try {
            // Fetch the full transaction details using the transaction hash.
            const tx = await provider.getTransaction(txHash);
            if (tx) {
                // Add an `ingestionTime` timestamp for managing transaction lifespan in our map.
                tx.ingestionTime = Date.now();

                // Add simplified MEV-related flags/data for demo purposes.
                // In a real system, you would need to decode `tx.data` (calldata)
                // to accurately determine if it's a Uniswap swap, identify tokens, etc.
                // For Uniswap V2 Router 02 on Mainnet: 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D
                tx.is_uniswap_swap = tx.to === '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
                tx.sender = tx.from; // For simplicity, attacker/victim sender is `from` address.
                // Simulate a random slippage tolerance for the victim transaction.
                // This is for demonstration purposes to satisfy the Rust detection logic.
                tx.slippage_tolerance = Math.random() * 0.1; // Random slippage between 0 and 10%

                // Store the transaction in our in-memory map.
                pendingTransactions.set(txHash, tx);
                // console.log(`Ingested pending transaction: ${txHash}`); // Uncomment for detailed logging
            }
        } catch (error) {
            // It's common to get errors here if a transaction is mined very quickly
            // after being seen as pending, before we can fetch its full details.
            // console.error(`Error fetching transaction ${txHash}:`, error); // Uncomment for detailed error logging
        }
    });

    // Listen for errors from the WebSocket provider.
    provider.on('error', (error) => {
        console.error('WebSocket Provider Error:', error);
    });

    // Listen for new blocks being mined (optional, but useful for context).
    provider.on('block', (blockNumber) => {
        // console.log(`New block mined: ${blockNumber}`); // Uncomment for detailed logging
        // You could use block events to trigger more sophisticated analysis or cleanup.
    });

    console.log('Listening for pending transactions...');

    // Periodically process transaction clusters for MEV detection.
    // This `setInterval` will run every `BATCH_PROCESSING_INTERVAL` milliseconds.
    setInterval(async () => {
        // Get the current cluster of recent pending transactions.
        const cluster = getTransactionCluster();
        if (cluster.length === 0) {
            // console.log('No transactions in cluster to process.'); // Uncomment for detailed logging
            return; // Nothing to do if the cluster is empty.
        }

        // Prepare transactions for the Rust WASM module.
        // The Rust code expects a JSON string where `value`, `gas_price`, `gas_limit`
        // are strings (because `ethers` BigNumber objects can't be directly serialized to Rust's u64).
        // We also convert `ingestionTime` to seconds for the Rust `timestamp` field.
        const simplifiedCluster = cluster.map(tx => ({
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            value: tx.value ? tx.value.toString() : '0', // Convert BigNumber to string
            gas_price: tx.gasPrice ? tx.gasPrice.toString() : '0',
            gas_limit: tx.gasLimit ? tx.gasLimit.toString() : '0',
            input: tx.data,
            timestamp: Math.floor(tx.ingestionTime / 1000), // Convert milliseconds to seconds
            block_number: tx.blockNumber || 0, // Placeholder if not yet in a block
            sender: tx.sender,
            slippage_tolerance: tx.slippage_tolerance,
            is_uniswap_swap: tx.is_uniswap_swap,
            token_in: tx.token_in, // Placeholder: In a real app, extract from tx.data
            token_out: tx.token_out, // Placeholder
            amount_in: tx.amount_in, // Placeholder
            amount_out_min: tx.amount_out_min, // Placeholder
        }));

        try {
            // Call the Rust WASM function `detectMevSandwich`.
            // Corrected function name: detect_mev_sandwich
            const isAttack = detect_mev_sandwich(JSON.stringify(simplifiedCluster));

            if (isAttack) {
                console.warn('!!! POTENTIAL MEV SANDWICH ATTACK DETECTED !!!');
                // For demonstration, let's make some simplified assumptions for the alert data:
                // - Attacker is the sender of the first transaction in the cluster.
                // - Victim is the sender of the transaction flagged as `is_uniswap_swap`.
                const attacker = simplifiedCluster[0].sender;
                const victimTx = simplifiedCluster.find(tx => tx.is_uniswap_swap);
                const victim = victimTx ? victimTx.sender : 'unknown_victim';

                // Simulate profit calculation (very basic for demo).
                const profitEth = Math.random() * 0.5; // Random profit between 0 and 0.5 ETH

                // Check Redis to prevent duplicate alerts for this attacker.
                if (await isNewAlert(attacker)) {
                    // Construct the alert data object according to the specified Kafka schema.
                    const alertData = {
                        victim: victim,
                        attacker: attacker,
                        profit_eth: parseFloat(profitEth.toFixed(4)), // Format profit to 4 decimal places
                        timestamp: Math.floor(Date.now() / 1000), // Current timestamp in seconds
                    };
                    // Send the alert to Kafka.
                    await sendKafkaAlert(alertData);
                }
            }
        } catch (wasmError) {
            // Log any errors that occur during the WASM function call.
            console.error('Error in WASM MEV detection:', wasmError);
        }
    }, BATCH_PROCESSING_INTERVAL); // Run the detection logic at the specified interval.
}

// Start the main service.
// `.catch(console.error)` will log any unhandled errors from `startMempoolIngestion`.
startMempoolIngestion().catch(console.error);

// --- Graceful Shutdown ---
// Listen for `SIGINT` (Ctrl+C) signal to gracefully shut down connections.
process.on('SIGINT', async () => {
    console.log('Shutting down MEV Detector...');
    try {
        // Disconnect Kafka producer.
        await producer.disconnect();
        console.log('Kafka producer disconnected.');
    } catch (error) {
        console.error('Error disconnecting Kafka producer:', error);
    }
    try {
        // Quit Redis connection.
        await redis.quit();
        console.log('Redis client disconnected.');
    } catch (error) {
        console.error('Error disconnecting Redis client:', error);
    }
    try {
        // Destroy (close) the ethers WebSocket provider connection.
        provider.destroy();
        console.log('Ethereum WebSocket provider disconnected.');
    } catch (error) {
        console.error('Error destroying Ethereum provider:', error);
    }
    console.log('MEV Detector gracefully shut down.');
    // Exit the Node.js process.
    process.exit(0);
});
