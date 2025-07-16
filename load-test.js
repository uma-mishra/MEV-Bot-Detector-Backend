// load-test.js (Conceptual Load Test Script for direct WASM testing)

// This script is designed to simulate a high volume of transactions and
// directly test the performance of the Rust WASM MEV detection logic,
// as well as the Redis deduplication and Kafka alerting.
// It bypasses the live Ethereum mempool ingestion for the purpose of focused load testing.

// Corrected import: using detect_mev_sandwich (snake_case) as exported by Rust WASM
const { detect_mev_sandwich } = require('./mev_engine/pkg'); // Path to WASM module
const Redis = require('ioredis');
const { Kafka } = require('kafkajs');

// --- Configuration for Load Test's Redis/Kafka interaction ---
const REDIS_URL = 'redis://localhost:6379'; // Ensure Redis Docker container is running
const KAFKA_BROKERS = ['localhost:9092']; // Ensure Kafka Docker container is running
const KAFKA_TOPIC = 'mev-alerts';
const REDIS_TTL_SECONDS = 300; // 5 minutes deduplication

// --- Initialize Clients for Load Test ---
const redis = new Redis(REDIS_URL);
const kafka = new Kafka({
    clientId: 'mev-load-tester', // Unique client ID for this load test script
    brokers: KAFKA_BROKERS,
});
const producer = kafka.producer();

// --- Helper Functions (adapted for load test context) ---

/**
 * Sends an alert message to the configured Kafka topic.
 * @param {Object} alertData - The payload of the alert.
 */
async function sendKafkaAlert(alertData) {
    try {
        await producer.send({
            topic: KAFKA_TOPIC,
            messages: [{ value: JSON.stringify(alertData) }],
        });
        // Console log this only for debugging, as it will be very noisy under load
        // console.log(`Load test alert sent to Kafka: ${JSON.stringify(alertData)}`);
    } catch (error) {
        console.error('Load test: Error sending message to Kafka:', error);
    }
}

/**
 * Checks Redis for duplicate alerts and caches new bot addresses.
 * This prevents sending too many alerts for the same attacker within the TTL.
 * @param {string} attackerAddress - The address of the detected attacker bot.
 * @returns {Promise<boolean>} True if the alert is new and should be processed, false otherwise.
 */
async function isNewAlert(attackerAddress) {
    const redisKey = `mev:${attackerAddress}:last_alert`;
    const lastAlertTimestamp = await redis.get(redisKey);
    if (lastAlertTimestamp) {
        // console.log(`Load test: Duplicate alert for attacker ${attackerAddress}. Skipping.`);
        return false;
    } else {
        await redis.setex(redisKey, REDIS_TTL_SECONDS, Date.now());
        // console.log(`Load test: New alert for attacker ${attackerAddress}. Caching for ${REDIS_TTL_SECONDS} seconds.`);
        return true;
    }
}

// --- Load Test Parameters ---
const TPS = 10000; // Target Transactions Per Second (simulated)
const DURATION_SECONDS = 60; // How long the load test will run
const TOTAL_TRANSACTIONS = TPS * DURATION_SECONDS;
const BATCH_SIZE = 100; // Number of transactions to process in each batch for WASM
const BATCH_INTERVAL_MS = 1000 / (TPS / BATCH_SIZE); // Interval between sending each batch to WASM

let sentTransactions = 0;
let detectedAttacks = 0;
let intervalId; // To store the interval timer ID

console.log(`Starting load test: Simulating ${TPS} TPS for ${DURATION_SECONDS} seconds.`);
console.log(`Total transactions to simulate: ${TOTAL_TRANSACTIONS}`);
console.log(`Processing in batches of ${BATCH_SIZE} every ${BATCH_INTERVAL_MS.toFixed(2)} ms.`);

/**
 * Generates a dummy transaction object.
 * @param {boolean} isUniswap - Whether to simulate a Uniswap swap.
 * @param {boolean} isAttacker - Whether to use a consistent attacker address.
 * @returns {Object} A simplified transaction object.
 */
function generateDummyTransaction(isUniswap = false, isAttacker = false) {
    // Helper to generate a random Ethereum-like address
    const randomAddress = () => `0x${Math.random().toString(16).slice(2,42).padEnd(40, '0')}`;
    const hash = `0x${Math.random().toString(16).slice(2,68)}`; // Random 64-char hex hash
    const from = isAttacker ? '0xAttackerAddress000000000000000000000000' : randomAddress();
    const to = isUniswap ? '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' : randomAddress(); // Uniswap V2 Router address
    const value = (Math.random() * 1).toFixed(18); // Random ETH value up to 1 ETH
    const gasPrice = (Math.floor(Math.random() * 100) + 20).toString(); // Gas price 20-120 Gwei
    const gasLimit = (Math.floor(Math.random() * 100000) + 21000).toString(); // Gas limit 21k-121k
    const input = isUniswap ? `0x${Array(200).fill('0').join('')}` : '0x'; // Dummy calldata
    const timestamp = Math.floor(Date.now() / 1000); // Current timestamp in seconds
    const block_number = 0; // Simulate pending transaction

    // Simulate slippage tolerance for victim transactions (only if it's a Uniswap swap)
    const slippage_tolerance = isUniswap ? (Math.random() * 0.08 + 0.02) : null; // 2-10% tolerance

    return {
        hash, from, to, value, gas_price: gasPrice, gas_limit: gasLimit,
        input, timestamp, block_number, sender: from, slippage_tolerance,
        is_uniswap_swap: isUniswap,
        token_in: isUniswap ? randomAddress() : null,
        token_out: isUniswap ? randomAddress() : null,
        amount_in: isUniswap ? (Math.random() * 1000).toFixed(0) : null,
        amount_out_min: isUniswap ? (Math.random() * 900).toFixed(0) : null,
    };
}

/**
 * Runs a single batch of simulated transactions through the MEV detection logic.
 */
async function runBatch() {
    // Check if we've sent enough transactions to stop the test
    if (sentTransactions >= TOTAL_TRANSACTIONS) {
        clearInterval(intervalId); // Stop the batch interval
        console.log(`Load test finished. Sent ${sentTransactions} transactions. Detected ${detectedAttacks} potential attacks.`);
        await producer.disconnect(); // Disconnect Kafka producer
        await redis.quit(); // Quit Redis connection
        process.exit(0); // Exit the script
        return;
    }

    const batch = [];
    const attackerAddress = '0xAttackerAddress000000000000000000000000'; // Consistent attacker for testing deduplication

    // Simulate a sandwich attack pattern in some batches (10% chance)
    const simulateAttack = Math.random() < 0.1;

    if (simulateAttack) {
        // Frontrun transaction by the attacker
        batch.push(generateDummyTransaction(false, true));
        // Victim (Uniswap swap with high slippage tolerance)
        batch.push(generateDummyTransaction(true, false));
        // Backrun transaction by the same attacker
        batch.push(generateDummyTransaction(false, true));
    }

    // Fill the rest of the batch with random transactions
    while (batch.length < BATCH_SIZE) {
        // 5% chance for a random transaction to be a Uniswap swap
        batch.push(generateDummyTransaction(Math.random() < 0.05));
    }

    // Shuffle the batch to mix transactions.
    // Note: For precise sandwich attack simulation, the order of frontrun-victim-backrun
    // within the batch should be maintained. The current Rust logic looks for them
    // within the *cluster*, so shuffling the batch is okay for this simulation.
    for (let i = batch.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [batch[i], batch[j]] = [batch[j], batch[i]];
    }

    try {
        // Call the Rust WASM function for MEV detection
        // Corrected function name: detect_mev_sandwich
        const isAttack = detect_mev_sandwich(JSON.stringify(batch));

        if (isAttack) {
            detectedAttacks++; // Increment attack counter
            // For this load test, we simplify victim identification
            const victimTx = batch.find(tx => tx.is_uniswap_swap);
            const victim = victimTx ? victimTx.sender : 'unknown_victim';

            const profitEth = parseFloat((Math.random() * 0.5).toFixed(4)); // Simulate profit

            // Check Redis for deduplication before sending a Kafka alert
            if (await isNewAlert(attackerAddress)) {
                const alertData = {
                    victim: victim,
                    attacker: attackerAddress,
                    profit_eth: profitEth,
                    timestamp: Math.floor(Date.now() / 1000),
                };
                await sendKafkaAlert(alertData); // Send alert to Kafka
            }
        }
    } catch (wasmError) {
        console.error('Load test: Error in WASM MEV detection:', wasmError);
    }

    sentTransactions += batch.length; // Update total sent transactions
    // Log progress every TPS transactions
    if (sentTransactions % TPS === 0) {
        console.log(`Sent ${sentTransactions} transactions. Detected ${detectedAttacks} attacks.`);
    }
}

/**
 * Starts the main load testing loop.
 */
async function startLoadTest() {
    await producer.connect(); // Connect Kafka producer for alerts
    console.log('Load test Kafka producer connected.');

    // Start the interval to run batches of transactions
    intervalId = setInterval(runBatch, BATCH_INTERVAL_MS);

    // Set a timeout to stop the load test after the specified specified duration
    setTimeout(() => {
        clearInterval(intervalId); // Stop the batch interval
        console.log(`Load test finished after ${DURATION_SECONDS} seconds. Sent ${sentTransactions} transactions. Detected ${detectedAttacks} potential attacks.`);
        producer.disconnect(); // Disconnect Kafka
        redis.quit(); // Disconnect Redis
        process.exit(0); // Exit the load test script
    }, DURATION_SECONDS * 1000);
}

// Start the load test
startLoadTest().catch(console.error);

// Handle graceful shutdown if the script is interrupted (e.g., Ctrl+C)
process.on('SIGINT', async () => {
    console.log('Load test interrupted.');
    clearInterval(intervalId); // Ensure interval is cleared
    try {
        await producer.disconnect();
    } catch (e) { console.error('Error disconnecting Kafka on SIGINT:', e); }
    try {
        await redis.quit();
    } catch (e) { console.error('Error quitting Redis on SIGINT:', e); }
    process.exit(0);
});
