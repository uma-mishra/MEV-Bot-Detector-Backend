// mev_engine/src/lib.rs

// Import necessary wasm-bindgen attributes for Node.js integration.
// `wasm_bindgen` allows us to expose Rust functions to JavaScript.
use wasm_bindgen::prelude::*;

// Import `serde` for easy serialization/deserialization with JavaScript.
// `Serialize` and `Deserialize` traits allow us to convert Rust structs
// to/from JSON strings, which is how data will pass between Node.js and Rust.
use serde::{Serialize, Deserialize};

// Define a simplified `Transaction` struct.
// This struct represents the data we expect for each transaction from Node.js.
// In a real-world scenario, this would be much more detailed, including
// raw transaction data, decoded calldata, gas prices, etc.
// `#[derive(Debug, Clone, Serialize, Deserialize)]` automatically adds
// functionality for debugging, cloning, and converting to/from JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    pub hash: String,          // Unique identifier for the transaction
    pub from: String,          // Sender's address
    pub to: String,            // Receiver's address or contract address
    pub value: String,         // ETH value transferred (as a string to avoid precision issues with large numbers)
    pub gas_price: String,     // Gas price paid (as a string)
    pub gas_limit: String,     // Maximum gas allowed (as a string)
    pub input: String,         // Transaction input data (calldata), contains function calls
    pub timestamp: u64,        // Timestamp when the transaction was seen/mined (in seconds since epoch)
    pub block_number: u64,     // Block number the transaction is in (0 if pending)
    pub sender: String,        // For sandwich attack detection: the address initiating the transaction (often same as `from`)
    pub slippage_tolerance: Option<f64>, // Example: How much price movement the victim tolerates (e.g., 0.01 for 1%)
    pub is_uniswap_swap: bool, // Simplified flag: true if this is a Uniswap-like swap
    pub token_in: Option<String>,      // Optional: Address of the token being swapped in
    pub token_out: Option<String>,     // Optional: Address of the token being swapped out
    pub amount_in: Option<String>,     // Optional: Amount of token being swapped in
    pub amount_out_min: Option<String>,// Optional: Minimum amount of token expected out (for slippage calculation)
}

// Enum to represent the direction of a transaction relative to a victim transaction.
// Used to find frontrun (before) or backrun (after) transactions.
#[derive(Debug, PartialEq, Eq)]
pub enum Direction {
    Before,
    After,
}

// Helper function: Simulates finding a Uniswap swap transaction within a list of transactions.
// In a real application, this would involve decoding the `input` data of each transaction
// to identify calls to known Uniswap (or other DEX) swap functions.
// For simplicity in this demo, we use the `is_uniswap_swap` flag in our `Transaction` struct.
fn find_uniswap_swap(transactions: &[Transaction]) -> Option<Transaction> {
    // Iterate through the transactions and find the first one where `is_uniswap_swap` is true.
    transactions.iter()
        .find(|tx| tx.is_uniswap_swap)
        .cloned() // `.cloned()` creates a copy of the found transaction.
}

// Helper function: Simulates finding a matching transaction (potential frontrun or backrun).
// This is a highly simplified version for demonstration. A real implementation would:
// - Analyze gas prices: Frontruns usually have significantly higher gas prices.
// - Analyze transaction `to` addresses and `input` data: Ensure they interact with the same DEX pool/router.
// - Check for token/amount matches: Ensure the transactions are related to the same asset swap.
// - Consider transaction ordering within a block (e.g., transaction index).
fn find_matching_tx(
    transactions: &[Transaction], // List of transactions to search within
    victim: &Transaction,         // The victim transaction we're looking around
    direction: Direction,         // Whether to look `Before` or `After` the victim
) -> Option<Transaction> {
    transactions.iter()
        .filter(|tx| {
            // Basic check: `to` address is the same (e.g., same DEX router/pair)
            // and it's not the victim transaction itself.
            tx.to == victim.to && tx.hash != victim.hash
            // In a real scenario, you'd add more complex filtering here:
            // - Check if the transaction is a swap of the same token pair.
            // - Check if the sender is an EOA or a contract known for bot activity.
            // - Compare gas prices (e.g., `tx.gas_price` vs `victim.gas_price`).
        })
        .min_by_key(|tx| {
            // Sort by timestamp to find the closest transaction in the specified direction.
            if direction == Direction::Before {
                // For "Before", we want the smallest positive difference (victim_timestamp - tx_timestamp)
                // This means `tx.timestamp` is just before `victim.timestamp`.
                victim.timestamp - tx.timestamp
            } else {
                // For "After", we want the smallest positive difference (tx_timestamp - victim_timestamp)
                // This means `tx.timestamp` is just after `victim.timestamp`.
                tx.timestamp - victim.timestamp
            }
        })
        .cloned() // Return a clone of the found transaction.
}

// Main MEV detection logic, exposed to JavaScript via WASM.
// `#[wasm_bindgen]` macro makes this function callable from JavaScript.
// It takes a JSON string of transactions, deserializes them,
// performs the sandwich attack detection, and returns a boolean (true if attack detected).
#[wasm_bindgen]
pub fn detect_mev_sandwich(transactions_json: &str) -> bool {
    // Deserialize the JSON string into a `Vec<Transaction>` (Vector/list of Transactions).
    let transactions: Vec<Transaction> = match serde_json::from_str(transactions_json) {
        Ok(txs) => txs, // If successful, assign the parsed transactions to `txs`.
        Err(e) => {
            // If deserialization fails (e.g., bad JSON format), print an error and return false.
            eprintln!("Error deserializing transactions: {:?}", e);
            return false;
        }
    };

    // Ensure there are enough transactions in the cluster to even attempt a sandwich detection.
    // A sandwich attack requires at least 3 transactions: frontrun, victim, backrun.
    if transactions.len() < 3 {
        return false;
    }

    // Attempt to find the victim (Uniswap swap) transaction within the cluster.
    let victim = match find_uniswap_swap(&transactions) {
        Some(v) => v,       // If found, assign it to `v`.
        None => return false, // No Uniswap swap found, so no sandwich attack of this type.
    };

    // Find potential frontrun and backrun transactions relative to the victim.
    let frontrun = find_matching_tx(&transactions, &victim, Direction::Before);
    let backrun = find_matching_tx(&transactions, &victim, Direction::After);

    // Check for the conditions of a sandwich attack as per the problem statement.
    // We use `if let (Some(fr), Some(br)) = (frontrun, backrun)` to check if both
    // frontrun AND backrun transactions were successfully found.
    if let (Some(fr), Some(br)) = (frontrun, backrun) {
        // Condition 1: Frontrun and backrun are from the same sender (this is the attacker bot).
        let same_sender = fr.sender == br.sender;

        // Condition 2: Backrun timestamp is within 120 seconds (approx. 2 Ethereum blocks)
        // of the frontrun timestamp. This is a simplified time analysis.
        // In reality, you'd look at block numbers and potentially transaction indices within blocks
        // to confirm they are in the same or very close blocks.
        let time_within_limit = if br.timestamp > fr.timestamp {
            br.timestamp - fr.timestamp < 120
        } else {
            // This case should ideally not happen if timestamps are accurate and ordered,
            // but added for robustness in case of out-of-order data.
            fr.timestamp - br.timestamp < 120
        };

        // Condition 3 (from problem statement): Victim has high slippage tolerance.
        // We check if `victim.slippage_tolerance` exists (`is_some()`) and if its value
        // is greater than a threshold (e.g., 0.05 for 5%).
        let high_slippage_victim = victim.slippage_tolerance.map_or(false, |s| s > 0.05);

        // Combine all conditions: All must be true for a detected sandwich attack.
        same_sender && time_within_limit && high_slippage_victim
    } else {
        // If either frontrun or backrun was not found, it's not a complete sandwich attack.
        false
    }
}