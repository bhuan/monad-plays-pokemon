# Monad Plays Pokemon

A decentralized "Twitch Plays Pokémon" proof-of-concept running on the Monad blockchain.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Frontend  │────▶│   Monad     │◀────│   Indexer   │
│  (React +   │     │  Blockchain │     │  (Node.js)  │
│   Wallet)   │     │             │     │             │
└─────────────┘     └─────────────┘     └──────┬──────┘
      ▲                                        │
      │           Socket.io                    │
      └────────────────────────────────────────┘
```

- **Smart Contract**: Gas-minimized event emitter (no storage writes)
- **Indexer**: Listens to VoteCast events, aggregates votes per window, broadcasts winning moves
- **Frontend**: Wallet connection, voting UI, displays winning moves

## Quick Start

### 1. Deploy Contract (Monad Testnet)

```bash
cd contracts

# Copy and configure .env
cp .env.example .env

# Deploy
forge script script/MonadPlaysPokemon.s.sol --rpc-url https://testnet-rpc.monad.xyz --broadcast
```

### 2. Start Indexer

```bash
cd indexer

# Copy and configure .env
cp .env.example .env
# Set CONTRACT_ADDRESS to deployed contract

npm install
npm run dev
```

### 3. Start Frontend

```bash
cd frontend

# Copy and configure .env
cp .env.example .env
# Set VITE_CONTRACT_ADDRESS to deployed contract

npm install
npm run dev
```

## Configuration

### Contract (.env)
- `PRIVATE_KEY`: Deployer wallet private key (pre-configured)
- `MONAD_TESTNET_RPC_URL`: `https://testnet-rpc.monad.xyz`

### Indexer (.env)
- `RPC_URL`: `wss://testnet-rpc.monad.xyz` (WebSocket)
- `CONTRACT_ADDRESS`: Deployed MonadPlaysPokemon contract address
- `WINDOW_SIZE`: Blocks per voting window (default: 5)
- `PORT`: Socket.io server port (default: 3001)

### Frontend (.env)
- `VITE_CONTRACT_ADDRESS`: Deployed contract address
- `VITE_RPC_URL`: `https://testnet-rpc.monad.xyz`
- `VITE_INDEXER_URL`: Indexer WebSocket URL (default: `http://localhost:3001`)

## Network Details

| Property | Value |
|----------|-------|
| RPC URL (HTTP) | `https://testnet-rpc.monad.xyz` |
| RPC URL (WebSocket) | `wss://testnet-rpc.monad.xyz` |
| Block Explorer | `https://testnet.monadvision.com` |

## How It Works

1. Users connect their wallet and vote for a GameBoy action (UP, DOWN, A, B, etc.)
2. Votes are submitted as transactions to the MonadPlaysPokemon contract
3. The indexer listens for VoteCast events and groups them into time windows
4. At the end of each window (every N blocks), the most popular action wins
5. The winning action is broadcast to all connected frontends

## Game Input Actions

| Action | Description |
|--------|-------------|
| UP     | D-Pad Up    |
| DOWN   | D-Pad Down  |
| LEFT   | D-Pad Left  |
| RIGHT  | D-Pad Right |
| A      | A Button    |
| B      | B Button    |
| START  | Start       |
| SELECT | Select      |

## POC Limitations

- Emulator runs client-side (game state may diverge between clients)
- No persistence of game state
- Window timing based on block numbers

## Tech Stack

- **Contracts**: Solidity, Foundry
- **Indexer**: Node.js, TypeScript, ethers.js, Socket.io
- **Frontend**: React, TypeScript, Vite, ethers.js
