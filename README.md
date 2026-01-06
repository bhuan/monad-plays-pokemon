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
- **Indexer**: Listens to VoteCast events, aggregates votes per window, runs the emulator, streams game frames
- **Frontend**: Wallet connection, voting UI, displays game stream

## The game loop

Let's walk through the game loop using the EIP-7702 relay for gasless voting.

![The game loop](./assets/game-loop.png)

1. The user clicks the UP button on the D-pad. The frontend prepares a vote signature and (for first-time users) an EIP-7702 authorization to delegate their EOA to a SimpleDelegation contract.
2. The signed vote message is sent to the relay endpoint. For first-time users, the message includes an EIP-7702 authorization that delegates their EOA.
3. The relay verifies the signature and prepares to submit on behalf of the user.
4. The relay submits the transaction to Monad, paying gas on behalf of the user. For first-time users, the transaction includes an EIP-7702 authorization list.
5. The next leader includes the transaction in a block (~400 ms block time). The delegated EOA executes `vote(Action.UP)` on the MonadPlaysPokemon contract, which emits a `VoteCast(player, UP)` event.
6. The indexer receives the `VoteCast` event via its WebSocket subscription (`monadLogs`). The event includes the player's address, the action (UP), block number, and transaction hash.
7. The indexer records the vote in the current time window. When the window closes (configurable, default: 1 block), it tallies votes, determines UP as the winner, and presses UP on the emulator.
8. The indexer broadcasts the finalized vote to all clients via [Socket.io](http://socket.io/) (appears in vote feed). It also streams the updated game visuals as a JPEG over WebSocket.
9. The user sees the character walk UP.

If a user connects with an external wallet (EOA), they can choose to pay their own gas and submit transactions directly to the blockchain.

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
- `PRIVATE_KEY`: Deployer wallet private key
- `MONAD_TESTNET_RPC_URL`: `https://testnet-rpc.monad.xyz`

### Indexer (.env)
- `RPC_URL`: `wss://testnet-rpc.monad.xyz` (WebSocket)
- `CONTRACT_ADDRESS`: Deployed MonadPlaysPokemon contract address
- `WINDOW_SIZE`: Blocks per voting window (default: 1)
- `PORT`: Socket.io server port (default: 3001)
- `RELAY_ENABLED`: Enable EIP-7702 gasless relay (default: false)
- `RELAY_PRIVATE_KEY`: Private key for relay wallet (pays gas)
- `DELEGATION_CONTRACT`: Deployed SimpleDelegation contract address

### Frontend (.env)
- `VITE_CONTRACT_ADDRESS`: Deployed contract address
- `VITE_RPC_URL`: `https://testnet-rpc.monad.xyz`
- `VITE_INDEXER_URL`: Indexer WebSocket URL (default: `http://localhost:3001`)
- `VITE_PRIVY_APP_ID`: Privy App ID for embedded wallets
- `VITE_RELAY_ENABLED`: Enable EIP-7702 gasless relay (default: false)
- `VITE_DELEGATION_CONTRACT`: Deployed SimpleDelegation contract address
- `VITE_RELAY_API_URL`: Relay API URL (default: `http://localhost:3001`)

## Network Details

| Property | Value |
|----------|-------|
| RPC URL (HTTP) | `https://testnet-rpc.monad.xyz` |
| RPC URL (WebSocket) | `wss://testnet-rpc.monad.xyz` |
| Block Explorer | `https://testnet.monadvision.com` |

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

- Single indexer instance runs the authoritative emulator (anyone can run their own indexer with a separate game state)
- Window timing based on block numbers

## Tech Stack

- **Contracts**: Solidity, Foundry
- **Indexer**: Node.js, TypeScript, ethers.js, Socket.io
- **Frontend**: React, TypeScript, Vite, ethers.js
