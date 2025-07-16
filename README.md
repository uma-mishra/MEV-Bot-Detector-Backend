# MEV-Bot Detector with Real-Time Alert System

## Project Overview

This project implements a backend service designed to detect potential MEV (Maximal Extractable Value) bot activities, specifically focusing on **sandwich attacks**, within the Ethereum mempool. It leverages a high-performance Rust WebAssembly (WASM) engine for transaction clustering and detection, integrates with Redis for alert deduplication, and streams real-time alerts to a Kafka topic. The system is designed to be scalable and efficient, processing a high volume of pending transactions.

## Architecture Diagram

The system architecture is depicted below:

![Architecture Diagram](https://i.imgur.com/image_71ef81.png)
*(Note: The original image URL provided in the problem statement was a local file. For GitHub, it needs to be a publicly accessible URL. You should upload your diagram to an image hosting service like Imgur and replace this URL with the direct image link. If you prefer, you can remove this line and describe the architecture in text.)*

## Key Features & Technologies

* **Ethereum Mempool Ingestion:** Real-time monitoring of pending Ethereum transactions via `ethers.providers.WebSocketProvider`.
* **High-Performance MEV Detection (Rust WASM):**
    * Core detection logic for identifying sandwich attacks is implemented in Rust, compiled to WebAssembly (WASM) for maximum efficiency.
    * The Rust module processes transaction clusters to identify patterns like:
        * Transactions with high slippage tolerance appearing between a victim's buy/sell.
        * Time analysis: Bots consistently submitting transactions within a close time window of a victim.
    * Integrated with Node.js for seamless execution.
* **Real-Time Alerting Pipeline:**
    * **Redis for Deduplication:** Caches detected bot addresses for 5 minutes (`mev:<attacker_address>:last_alert` TTL) to prevent duplicate alerts.
    * **Kafka for Alert Streaming:** Publishes structured alert messages to a `mev-alerts` topic.
* **Historical MEV Pattern Validation (The Graph - Code Provided):**
    * A dedicated subgraph schema and mapping logic are provided for indexing historical MEV attacks on Ethereum. This component is crucial for validating new detection patterns against known historical attacks.
* **Containerized Environment:** All external services (Ethereum Node, Redis, Kafka, Zookeeper) are set up using Docker Compose for easy local development and deployment.

## Deliverables Status

* **Node.js service with WASM integration:** **COMPLETE & DEMONSTRABLE.**
* **The Graph subgraph for MEV pattern indexing:** **CODE COMPLETE & PROVIDED.** (See explanation below regarding local build).
* **Load test script simulating 10K TPS mempool:** **COMPLETE & DEMONSTRABLE.**
* **Github link containing all the code written with readme:** **COMPLETE.** (This repository itself).
* **Demo of what you build showing that its working for 5-10min:** **READY TO PERFORM.**

## Setup and Running Instructions

Follow these steps to set up and run the MEV-Bot Detector locally.

### Prerequisites

* [Node.js](https://nodejs.org/en/) (LTS version recommended) & npm
* [Rust](https://www.rust-lang.org/tools/install) & Cargo
* [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/) (`cargo install wasm-pack`)
* [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Ensure it's running and you are logged in)
* [Microsoft Visual C++ Build Tools](https://visualstudio.microsoft.com/downloads/) (Required for Rust compilation on Windows, select "Desktop development with C++" workload)

### 1. Clone the Repository

```bash
git clone [YOUR_GITHUB_REPO_URL] # Replace with your actual repo URL
cd MEV-Bot-Detector-Backend # Or whatever your repo name is