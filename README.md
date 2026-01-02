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

Let's walk through the game loop using the [Privy](https://www.privy.io/) smart wallet integration.

![The game loop](./assets/game-loop.png)

1. The user clicks the UP button on the D-pad. The frontend encodes `vote(Action.UP)` and prepares a `UserOperation` with the user's smart wallet as the sender.
2. The signed `UserOperation` is sent to the Privy endpoint. This contains the encoded vote call and the user's embedded wallet signature.
3. The bundler validates the `UserOperation` and requests gas sponsorship from the Paymaster (the entity paying for gas fees on behalf of the user). The Paymaster approves, and the bundler wraps the `UserOperation` into a transaction.
4. The bundler broadcasts the transaction to Monad validators via RPC. The transaction calls `EntryPoint.handleOps()` which will execute the user's vote through their smart wallet.
5. The next leader includes the transaction in a block (~400 ms block time). The smart wallet executes `vote(Action.UP)` on the MonadPlaysPokemon contract, which emits a `VoteCast(player, UP)` event.
6. The indexer receives the `VoteCast` event via its WebSocket subscription (`monadLogs`). The event includes the player's address, the action (UP), block number, and transaction hash.
7. The indexer records the vote in the current time window. When the window closes (every 5 blocks), it tallies votes, determines UP as the winner, and presses UP on the emulator.
8. The indexer broadcasts the finalized vote to all clients via [Socket.io](http://socket.io/) (appears in vote feed). It also streams the updated game visuals as a JPEG over WebSocket.
9. The user sees the character walk UP.

If a user connects with an EOA account, the dotted line is taken and all the complexity of account abstraction goes away (but the user has to pay for their own gas and click “Approve”!).

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
