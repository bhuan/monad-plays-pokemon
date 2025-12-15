# Project: MonadPlaysPokemon (Twitch Plays Pokémon on Monad)

## Context
We are building a Proof-of-Concept (POC) for a decentralized "Twitch Plays Pokémon" experience running on the Monad blockchain.
* **Goal:** Leverage Monad's 400ms block time to create a collaborative gaming experience where users vote on game inputs via blockchain transactions.
* **Core Loop:** Users vote -> Smart Contract Events -> Off-chain Indexer aggregates votes -> Winner elected per "Window" -> Emulator executes move.

## Architecture Overview

### 1. Smart Contract (The Ballot Box)
* **Role:** Extremely lightweight event emitter. No state storage to minimize gas.
* **Optimization:** Relies entirely on `logs` for data availability.

### 2. Indexer (The Brain)
* **Role:** Listens to the chain, buckets votes into time windows (denominated in blocks), calculates the winning move, and broadcasts it to the frontend.
* **Tech:** Node.js, Ethers.js (WebSocket Provider), Socket.io (Server).

### 3. Frontend (The View)
* **Role:** Renders the GameBoy emulator, handles wallet connection, and submits vote transactions.
* **Tech:** React, `boytacean` (or similar WASM GBA emulator), Socket.io (Client).
* **Note for POC:** The emulator runs locally on the client for this version. The client receives the "official" moves from the Indexer to keep the input stream synchronized, though game state (RNG) may diverge in a local-only setup.

---

## Phase 1: Smart Contract Development

**Objective:** Deploy a gas-minimized contract to Monad Testnet.

1.  **Contract Specifications:**
    * **Name:** `MonadPlays.sol`
    * **Enum:** `Action { UP, DOWN, LEFT, RIGHT, A, B, START, SELECT }`
    * **Events:** `event VoteCast(address indexed player, Action action);`
    * **Functions:**
        * `vote(Action _action) external`: Accepts an enum. Emits `VoteCast`. Does **not** write to storage.
2.  **Tasks:**
    * Write `MonadPlays.sol`.
    * Create a Hardhat/Foundry script to deploy to Monad Testnet.
    * **Output:** Save the deployed Contract Address and ABI.

---

## Phase 2: High-Performance Indexer

**Objective:** precise vote aggregation using Monad WebSockets.

1.  **Configuration:**
    * `WINDOW_SIZE`: Configurable integer (e.g., 5 blocks).
