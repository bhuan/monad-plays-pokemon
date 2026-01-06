import { ethers } from "ethers";
import { Server } from "socket.io";
import { createServer } from "http";
import * as path from "path";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { config, contractAbi, Actions, CONTRACT_ABI, DELEGATION_ABI } from "./config";
import { VoteAggregator } from "./voteAggregator";
import { GameBoyEmulator, GameState } from "./emulator";

// Frontend static files path
const FRONTEND_DIST = path.join(__dirname, "..", "..", "frontend", "dist");

// Paths
const ROM_PATH = path.join(__dirname, "..", "roms", "pokemon-red.gb");
// Use SAVE_DIR env var for Railway volume, fallback to local saves folder
const SAVE_DIR = process.env.SAVE_DIR || path.join(__dirname, "..", "saves");
const SAVE_PATH = path.join(SAVE_DIR, "pokemon-red.sav");

// Ensure save directory exists
if (!fs.existsSync(SAVE_DIR)) {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  console.log("Created save directory:", SAVE_DIR);
}

// Download ROM from URL if not present locally
async function ensureRomExists(): Promise<void> {
  if (fs.existsSync(ROM_PATH)) {
    console.log("ROM found locally:", ROM_PATH);
    return;
  }

  const romUrl = process.env.ROM_URL;
  if (!romUrl) {
    throw new Error(
      `ROM file not found at ${ROM_PATH} and ROM_URL environment variable not set`
    );
  }

  console.log("ROM not found locally, downloading from ROM_URL...");

  // Ensure roms directory exists
  const romsDir = path.dirname(ROM_PATH);
  if (!fs.existsSync(romsDir)) {
    fs.mkdirSync(romsDir, { recursive: true });
  }

  // Download the ROM
  await new Promise<void>((resolve, reject) => {
    const protocol = romUrl.startsWith("https") ? https : http;
    const file = fs.createWriteStream(ROM_PATH);

    protocol.get(romUrl, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Handle redirect
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          protocol.get(redirectUrl, (redirectResponse) => {
            redirectResponse.pipe(file);
            file.on("finish", () => {
              file.close();
              console.log("ROM downloaded successfully");
              resolve();
            });
          }).on("error", reject);
        } else {
          reject(new Error("Redirect without location header"));
        }
      } else if (response.statusCode === 200) {
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          console.log("ROM downloaded successfully");
          resolve();
        });
      } else {
        reject(new Error(`Failed to download ROM: HTTP ${response.statusCode}`));
      }
    }).on("error", (err) => {
      fs.unlink(ROM_PATH, () => {}); // Clean up partial file
      reject(err);
    });
  });
}

// Auto-save interval (every 60 seconds)
const AUTO_SAVE_INTERVAL = 60000;

// Game state broadcast interval (every 2 seconds)
const GAME_STATE_INTERVAL = 2000;

// Startup delay to allow old container to save before we read (Railway race condition)
const STARTUP_SAVE_DELAY = 5000;

// Frame streaming rate (FPS) - targeting native GameBoy rate (~60 FPS)
const STREAM_FPS = 60;

// ============================================================================
// In-Memory Cache Configuration
// ============================================================================
const MAX_CACHED_VOTES = parseInt(process.env.MAX_CACHED_VOTES || "100");
const MAX_CACHED_ACTIONS = parseInt(process.env.MAX_CACHED_ACTIONS || "50");

// Types for cached data
interface CachedVote {
  player: string;
  action: string;
  blockNumber: number;
  txHash: string;
  timestamp: number;
}

interface CachedAction {
  windowId: number;
  startBlock: number;
  endBlock: number;
  winningAction: string;
  winningTxHash: string | null;
  votes: Record<string, number>;
  totalVotes: number;
  timestamp: number;
}

// Circular buffers for recent history
const recentVotes: CachedVote[] = [];
const recentActions: CachedAction[] = [];

// Cached game state for instant hydration
let cachedGameState: GameState | null = null;

// Helper to add item to circular buffer
function addToCircularBuffer<T>(buffer: T[], item: T, maxSize: number): void {
  buffer.push(item);
  if (buffer.length > maxSize) {
    buffer.shift();
  }
}

// Track seen events to deduplicate between WebSocket and polling
const seenEvents = new Set<string>();

// Generate unique key for an event
function getEventKey(blockNumber: number, txHash: string, logIndex: number): string {
  return `${blockNumber}-${txHash}-${logIndex}`;
}

// Track the latest confirmed block from polling
let lastPolledBlock = 0;
let lastWebSocketBlock = 0;

async function main() {
  console.log("MonadPlaysPokemon Indexer starting...");
  console.log(`Contract: ${config.contractAddress}`);
  console.log(`Window Size: ${config.windowSize} blocks`);
  console.log(`WebSocket RPC: ${config.rpcUrl}`);
  console.log(`HTTP RPC: ${config.httpRpcUrl}`);
  console.log(`Poll interval: ${config.windowSize * config.blockTimeMs}ms`);
  console.log(`Cache: ${MAX_CACHED_VOTES} votes, ${MAX_CACHED_ACTIONS} actions`);

  if (!config.contractAddress) {
    console.error("ERROR: CONTRACT_ADDRESS not set in environment");
    process.exit(1);
  }

  // Ensure ROM exists (download if needed)
  try {
    await ensureRomExists();
    // Verify ROM exists after download
    if (!fs.existsSync(ROM_PATH)) {
      throw new Error(`ROM still not found after download: ${ROM_PATH}`);
    }
    console.log("ROM verified at:", ROM_PATH);
  } catch (err) {
    console.error("Failed to get ROM:", err);
    process.exit(1);
  }

  // Wait for old container to save before reading (Railway redeploy race condition)
  if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT) {
    console.log(`Waiting ${STARTUP_SAVE_DELAY}ms for old container to save...`);
    await new Promise((resolve) => setTimeout(resolve, STARTUP_SAVE_DELAY));
  }

  // Initialize GameBoy emulator (ROM must exist before this point)
  const emulator = new GameBoyEmulator(ROM_PATH, SAVE_PATH);
  try {
    await emulator.init();
  } catch (err) {
    console.error("Failed to initialize emulator:", err);
    process.exit(1);
  }

  // Set up Express app to serve frontend
  const app = express();

  // CORS middleware for API endpoints (needed for dev server on different port)
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  // JSON middleware for API endpoints
  app.use(express.json());

  // ============================================================================
  // EIP-7702 Relay Endpoint (experimental)
  // ============================================================================
  // This endpoint allows gasless voting by having the backend pay gas.
  // Users sign a message off-chain, and the relay submits the tx to their
  // delegated EOA. The user's EOA is msg.sender to the vote contract.
  // ============================================================================

  if (config.relay.enabled) {
    console.log("EIP-7702 Relay enabled");
    console.log(`  Delegation contract: ${config.relay.delegationContract}`);

    if (!config.relay.privateKey) {
      console.error("ERROR: RELAY_PRIVATE_KEY not set but relay is enabled");
      process.exit(1);
    }

    // Create relay wallet
    const relayWallet = new ethers.Wallet(
      config.relay.privateKey,
      new ethers.JsonRpcProvider(config.httpRpcUrl)
    );
    console.log(`  Relay wallet: ${relayWallet.address}`);

    // Contract interfaces for encoding
    const voteInterface = new ethers.Interface(CONTRACT_ABI);
    const delegationInterface = new ethers.Interface(DELEGATION_ABI);

    // SimpleDelegation contract for reading nonces
    const delegationContract = new ethers.Contract(
      config.relay.delegationContract,
      DELEGATION_ABI,
      relayWallet
    );

    // EIP-7702 delegation prefix: 0xef0100 indicates code is delegated to another address
    // See EIP-7702 spec: https://eips.ethereum.org/EIPS/eip-7702
    const EIP7702_DELEGATION_PREFIX = "0xef0100";

    // Normalize address to checksummed format
    // We lowercase first because ethers.js v6 throws on addresses with incorrect checksum casing
    function normalizeAddress(address: string): string {
      return ethers.getAddress(address.toLowerCase());
    }

    // Check if an address is already delegated to SimpleDelegation
    async function isDelegated(address: string): Promise<boolean> {
      try {
        const provider = relayWallet.provider;
        if (!provider) return false;
        const normalizedAddress = normalizeAddress(address);
        const code = await provider.getCode(normalizedAddress);
        // Check if code matches EIP-7702 delegation to our contract
        const expectedCode = EIP7702_DELEGATION_PREFIX + config.relay.delegationContract.slice(2).toLowerCase();
        return code.toLowerCase() === expectedCode;
      } catch {
        return false;
      }
    }

    app.post("/relay", async (req, res) => {
      const startTime = Date.now();
      try {
        const { userAddress, action, deadline, signature, authorization } = req.body;

        // Validate required fields
        if (!userAddress || action === undefined || !deadline || !signature) {
          return res.status(400).json({
            error: "Missing required fields: userAddress, action, deadline, signature",
          });
        }

        // Validate action
        if (action < 0 || action > 7) {
          return res.status(400).json({ error: "Invalid action (must be 0-7)" });
        }

        // Check deadline hasn't passed
        const now = Math.floor(Date.now() / 1000);
        if (deadline < now) {
          return res.status(400).json({ error: "Signature has expired" });
        }

        // Check if user is already delegated
        const alreadyDelegated = await isDelegated(userAddress);

        // If not delegated, require authorization
        if (!alreadyDelegated && !authorization) {
          return res.status(400).json({
            error: "Authorization required for first vote (EIP-7702 delegation)",
            needsAuthorization: true,
          });
        }

        // Encode the vote call data
        const voteData = voteInterface.encodeFunctionData("vote", [action]);

        // Encode the execute call to the user's delegated EOA
        // The user's EOA has delegated to SimpleDelegation contract via EIP-7702
        const executeData = delegationInterface.encodeFunctionData("execute", [
          config.contractAddress, // to: MonadPlaysPokemon contract
          0,                      // value: 0 ETH
          voteData,               // data: vote(action)
          deadline,               // deadline: from request
          signature,              // signature: from request
        ]);

        let tx;
        if (authorization && !alreadyDelegated) {
          // First vote: Include EIP-7702 authorization in Type 0x04 transaction
          // This delegates the EOA and executes in one atomic transaction
          console.log(`[relay] first vote for ${userAddress.slice(0, 8)}... - including EIP-7702 authorization`);

          // Build authorization list from signed authorization
          // authorization = { chainId, nonce, r, s, yParity }
          // ethers expects signature as a combined hex string or SignatureLike object
          const authList = [{
            chainId: authorization.chainId,
            nonce: authorization.nonce,
            address: config.relay.delegationContract,
            signature: {
              r: authorization.r,
              s: authorization.s,
              yParity: authorization.yParity,
            },
          }];

          // Gas breakdown for first vote with EIP-7702 delegation (~98k actual):
          // - Base transaction cost: 21,000
          // - Calldata (~300 bytes): ~4,800
          // - EIP-7702 authorization (PER_AUTH_BASE_COST): 12,500
          // - EIP-7702 empty account setup: ~12,500
          // - SSTORE nonce 0→1 (cold, zero to non-zero): ~22,100
          // - ecrecover precompile: 6,000
          // - External call to vote(): ~2,600 + 2,000
          // - Overhead/cleanup: ~15,000
          // Total: ~98,500 (125k provides safety margin)
          tx = await relayWallet.sendTransaction({
            type: 4, // EIP-7702 transaction type
            to: userAddress,
            data: executeData,
            gasLimit: 125000,
            authorizationList: authList,
          });
        } else {
          // Gas breakdown for subsequent votes (~55k actual):
          // - Base transaction cost: 21,000
          // - Calldata (~300 bytes): ~4,800
          // - Cold delegated EOA access: 2,600
          // - SSTORE nonce n→n+1 (warm, non-zero to non-zero): ~5,000
          // - ecrecover precompile: 6,000
          // - External call to vote(): ~2,600 + 2,000
          // - Overhead/cleanup: ~10,000
          // Total: ~54,000 (60k provides safety margin)
          tx = await relayWallet.sendTransaction({
            to: userAddress,
            data: executeData,
            gasLimit: 60000,
          });
        }

        const duration = Date.now() - startTime;
        console.log(`[relay] Vote relayed for ${userAddress.slice(0, 8)}... action=${Actions[action]} txHash=${tx.hash} (${duration}ms)`);

        return res.json({
          success: true,
          txHash: tx.hash,
          duration,
          delegated: true, // After this tx, user is delegated
        });
      } catch (err: any) {
        const duration = Date.now() - startTime;
        console.error(`[relay] Error (${duration}ms):`, err.message);

        // Provide helpful error messages
        if (err.message?.includes("insufficient funds")) {
          return res.status(503).json({ error: "Relay wallet out of funds" });
        }
        if (err.message?.includes("nonce")) {
          return res.status(429).json({ error: "Transaction pending, try again" });
        }
        if (err.message?.includes("InvalidSignature")) {
          return res.status(400).json({ error: "Invalid signature" });
        }
        if (err.message?.includes("Signature expired")) {
          return res.status(400).json({ error: "Signature expired" });
        }

        return res.status(500).json({ error: err.message || "Relay failed" });
      }
    });

    // Check if user's EOA is delegated
    app.get("/relay/delegated/:address", async (req, res) => {
      try {
        const { address } = req.params;
        const delegated = await isDelegated(address);
        return res.json({ delegated });
      } catch (err: any) {
        console.error("[relay] Delegation check error:", err.message);
        return res.status(500).json({ error: "Failed to check delegation" });
      }
    });

    // Endpoint to get current nonce for a user's EOA
    // IMPORTANT: Must call getNonce ON the user's delegated EOA, not on the delegation contract
    // EIP-7702 storage model: delegated code runs with the EOA's storage, not the contract's
    app.get("/relay/nonce/:address", async (req, res) => {
      try {
        const address = normalizeAddress(req.params.address);

        // Check if user is delegated first
        const delegated = await isDelegated(address);
        if (!delegated) {
          // Not delegated yet, nonce is 0
          return res.json({ nonce: 0 });
        }

        // Call getNonce ON the user's EOA (which has delegated code)
        // This reads from the user's storage, not the delegation contract's storage
        const userDelegatedContract = new ethers.Contract(
          address, // User's EOA address
          DELEGATION_ABI,
          relayWallet.provider
        );
        const nonce = await userDelegatedContract.getNonce(address);
        return res.json({ nonce: Number(nonce) });
      } catch (err: any) {
        console.error("[relay] Nonce lookup error:", err.message);
        return res.status(500).json({ error: "Failed to get nonce" });
      }
    });

    // Health check for relay
    app.get("/relay/health", async (req, res) => {
      try {
        const balance = await relayWallet.provider?.getBalance(relayWallet.address);
        return res.json({
          enabled: true,
          wallet: relayWallet.address,
          balance: ethers.formatEther(balance || 0),
          delegationContract: config.relay.delegationContract,
          voteContract: config.contractAddress,
        });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    console.log("Relay endpoints: POST /relay, GET /relay/nonce/:address, GET /relay/health");
  }

  // Serve frontend static files if they exist
  if (fs.existsSync(FRONTEND_DIST)) {
    console.log("Serving frontend from:", FRONTEND_DIST);
    app.use(express.static(FRONTEND_DIST));
    // SPA fallback - serve index.html for all non-API routes
    app.use((req, res, next) => {
      if (req.path.startsWith("/socket.io")) return next();
      if (req.path.startsWith("/relay")) return next();
      if (req.method !== "GET") return next();
      res.sendFile(path.join(FRONTEND_DIST, "index.html"));
    });
  } else {
    console.log("Frontend dist not found, serving API only");
  }

  const httpServer = createServer(app);

  // Socket.io for non-frame events (windowResult, screenInfo)
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  // Raw WebSocket server for high-performance frame streaming
  const wss = new WebSocketServer({ server: httpServer, path: "/stream" });
  const frameClients = new Set<WebSocket>();

  // Broadcast viewer count to all clients
  function broadcastViewerCount() {
    const count = frameClients.size;
    const msg = JSON.stringify({ type: "viewerCount", count });
    for (const client of frameClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  wss.on("connection", (ws) => {
    frameClients.add(ws);
    console.log(`[WS] Frame client connected (total: ${frameClients.size})`);

    // Send screen info and viewer count immediately
    ws.send(JSON.stringify({ type: "screenInfo", ...emulator.getScreenDimensions() }));
    broadcastViewerCount();

    ws.on("close", () => {
      frameClients.delete(ws);
      console.log(`[WS] Frame client disconnected (total: ${frameClients.size})`);
      broadcastViewerCount();
    });

    ws.on("error", () => {
      frameClients.delete(ws);
      broadcastViewerCount();
    });
  });

  // Set up frame streaming with FPS tracking
  let serverFrameCount = 0;
  let lastFpsLogTime = Date.now();

  emulator.setFrameCallback((frameData: Buffer) => {
    serverFrameCount++;

    // Broadcast frame to all connected WebSocket clients
    for (const client of frameClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(frameData);
      }
    }

    // Log server-side FPS every 5 seconds
    const now = Date.now();
    if (now - lastFpsLogTime >= 5000) {
      const elapsed = (now - lastFpsLogTime) / 1000;
      const fps = (serverFrameCount / elapsed).toFixed(1);
      console.log(`[FPS] Server emitting ${fps} frames/sec to ${frameClients.size} clients`);
      serverFrameCount = 0;
      lastFpsLogTime = now;
    }
  });

  // Socket.io for other events (windowResult, screenInfo, recentHistory, gameState)
  io.on("connection", (socket) => {
    console.log(`[Socket.io] Client connected: ${socket.id}`);
    socket.emit("screenInfo", emulator.getScreenDimensions());

    // Send cached recent history immediately for instant hydration
    socket.emit("recentHistory", {
      votes: recentVotes,
      actions: recentActions,
    });
    console.log(`[Socket.io] Sent ${recentVotes.length} votes, ${recentActions.length} actions to ${socket.id}`);

    // Send cached game state if available
    if (cachedGameState) {
      socket.emit("gameState", cachedGameState);
    }

    socket.on("disconnect", () => {
      console.log(`[Socket.io] Client disconnected: ${socket.id}`);
    });
  });

  httpServer.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
    console.log(`  - Frame stream: ws://localhost:${config.port}/stream`);
    console.log(`  - Socket.io: http://localhost:${config.port}/socket.io`);
  });

  // Start emulator
  emulator.start(STREAM_FPS);

  // Auto-save periodically
  setInterval(() => {
    emulator.saveState();
  }, AUTO_SAVE_INTERVAL);

  // Broadcast game state periodically
  setInterval(() => {
    const gameState = emulator.getGameState();
    if (gameState) {
      // Check if HP changed for any party Pokemon
      const hpChanged = !cachedGameState ||
        gameState.partyHp.some((hp, i) => {
          const cached = cachedGameState?.partyHp?.[i];
          return !cached || cached.current !== hp.current || cached.max !== hp.max;
        });

      // Only broadcast if state changed
      const stateChanged = !cachedGameState ||
        cachedGameState.location !== gameState.location ||
        cachedGameState.badgeCount !== gameState.badgeCount ||
        cachedGameState.partyCount !== gameState.partyCount ||
        cachedGameState.money !== gameState.money ||
        hpChanged;

      if (stateChanged) {
        cachedGameState = gameState;
        io.emit("gameState", gameState);
        console.log(`[GameState] ${gameState.location} | Badges: ${gameState.badgeCount}/8 | Party: ${gameState.partyCount}`);
      }
    }
  }, GAME_STATE_INTERVAL);

  // Set up vote aggregator - execute winning move on emulator
  const aggregator = new VoteAggregator(config.windowSize, (result) => {
    // Cache the action with timestamp
    const cachedAction: CachedAction = {
      ...result,
      timestamp: Date.now(),
    };
    addToCircularBuffer(recentActions, cachedAction, MAX_CACHED_ACTIONS);

    // Broadcast to all clients
    io.emit("windowResult", result);
    console.log(`Window ${result.windowId}: ${result.winningAction} wins!`);
    emulator.pressButton(result.winningAction, 5);
  });

  // Create HTTP provider for polling
  const httpProvider = new ethers.JsonRpcProvider(config.httpRpcUrl);
  const httpContract = new ethers.Contract(
    config.contractAddress,
    contractAbi,
    httpProvider
  );

  // Process a vote event (with deduplication)
  function processVoteEvent(
    player: string,
    action: number,
    blockNumber: number,
    txHash: string,
    logIndex: number,
    source: "ws" | "poll" | "proposed" | "logs"
  ): boolean {
    const eventKey = getEventKey(blockNumber, txHash, logIndex);

    if (seenEvents.has(eventKey)) {
      return false; // Already processed
    }

    seenEvents.add(eventKey);
    aggregator.addVote(player, action, blockNumber, txHash);

    // Emit individual vote event to connected clients
    const actionName = Actions[action];
    const voteData: CachedVote = {
      player,
      action: actionName,
      blockNumber,
      txHash,
      timestamp: Date.now(),
    };

    // Cache the vote
    addToCircularBuffer(recentVotes, voteData, MAX_CACHED_VOTES);

    // Broadcast to all clients
    io.emit("vote", voteData);

    console.log(
      `[${source}] Vote: ${player.slice(0, 8)}... voted ${actionName} in block ${blockNumber}`
    );
    return true;
  }

  // VoteCast event signature: keccak256("VoteCast(address,uint8)")
  const VOTE_CAST_TOPIC = ethers.id("VoteCast(address,uint8)");

  // Connect to Monad WebSocket with dual subscriptions:
  // 1. monadNewHeads - for window boundaries and block hash (tie-breaking)
  // 2. monadLogs - for VoteCast events directly (no receipt fetching needed)
  const WebSocket = require("ws");
  let ws: InstanceType<typeof WebSocket>;
  let wsReconnectTimeout: NodeJS.Timeout | null = null;

  // Track subscription IDs to route messages correctly
  let newHeadsSubId: string | null = null;
  let logsSubId: string | null = null;

  function connectWebSocket(): void {
    console.log("Connecting to Monad WebSocket (dual subscription: monadNewHeads + monadLogs)...");

    ws = new WebSocket(config.rpcUrl);

    ws.on("open", () => {
      console.log("Connected to Monad WebSocket");

      // Subscription 1: monadNewHeads for block boundaries and hash (tie-breaking seed)
      // Note: method is eth_subscribe, "monadNewHeads" is the subscription type
      const newHeadsMsg = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_subscribe",
        params: ["monadNewHeads"]
      });
      ws.send(newHeadsMsg);
      console.log("Subscribing to monadNewHeads...");

      // Subscription 2: monadLogs filtered by our contract and VoteCast topic
      // Note: method is eth_subscribe, "monadLogs" is the subscription type
      const logsMsg = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "eth_subscribe",
        params: ["monadLogs", {
          address: config.contractAddress,
          topics: [VOTE_CAST_TOPIC]
        }]
      });
      ws.send(logsMsg);
      console.log("Subscribing to monadLogs (VoteCast events)...");
    });

    ws.on("message", async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handle subscription confirmations
        if (msg.id === 1 && msg.result) {
          newHeadsSubId = msg.result;
          console.log(`monadNewHeads subscription ID: ${newHeadsSubId}`);
          return;
        }
        if (msg.id === 2 && msg.result) {
          logsSubId = msg.result;
          console.log(`monadLogs subscription ID: ${logsSubId}`);
          return;
        }

        // Handle subscription data (method is eth_subscription for both standard and monad variants)
        if (msg.method === "eth_subscription" && msg.params?.subscription && msg.params?.result) {
          const subId = msg.params.subscription;
          const result = msg.params.result;

          // Route to correct handler based on subscription ID
          if (subId === newHeadsSubId) {
            // monadNewHeads: new block header
            const blockNumber = parseInt(result.number, 16);
            const blockHash = result.hash;

            lastWebSocketBlock = Math.max(lastWebSocketBlock, blockNumber);

            // Trigger window progression on each proposed block
            // Pass block hash for deterministic tie-breaking (used as seed for previous window)
            aggregator.onBlock(blockNumber, blockHash);

          } else if (subId === logsSubId) {
            // monadLogs: VoteCast event
            // Log format: { address, topics, data, blockNumber, transactionHash, logIndex, ... }
            const blockNumber = parseInt(result.blockNumber, 16);
            const txHash = result.transactionHash;
            const logIndex = parseInt(result.logIndex, 16);

            // Decode VoteCast event
            // topics[0] = event signature (already filtered)
            // topics[1] = indexed player address (padded to 32 bytes)
            // data = action (uint8)
            const player = "0x" + result.topics[1].slice(26);
            const action = parseInt(result.data, 16);

            processVoteEvent(player, action, blockNumber, txHash, logIndex, "logs");
          }
        }
      } catch (parseErr) {
        // Ignore parse errors for non-JSON messages
      }
    });

    ws.on("error", (err: Error) => {
      console.error("WebSocket error:", err.message);
    });

    ws.on("close", () => {
      console.log("WebSocket disconnected, reconnecting in 5 seconds...");
      newHeadsSubId = null;
      logsSubId = null;
      if (wsReconnectTimeout) clearTimeout(wsReconnectTimeout);
      wsReconnectTimeout = setTimeout(connectWebSocket, 5000);
    });
  }

  // Start WebSocket connection
  connectWebSocket();

  // Poll for events via HTTP RPC
  // Monad limits eth_getLogs to 100 blocks per query
  const MAX_BLOCK_RANGE = 100;

  async function pollForEvents(): Promise<void> {
    try {
      // Get the latest block number
      const latestBlock = await httpProvider.getBlockNumber();

      // Determine the range to query
      // Start from the last polled block (or a recent window if first poll)
      let fromBlock = lastPolledBlock > 0
        ? lastPolledBlock + 1
        : Math.max(0, latestBlock - config.windowSize * 2);

      // If we're too far behind, skip ahead to recent blocks
      if (latestBlock - fromBlock > MAX_BLOCK_RANGE * 10) {
        console.log(`[poll] Too far behind (${latestBlock - fromBlock} blocks), skipping to recent`);
        fromBlock = latestBlock - MAX_BLOCK_RANGE;
      }

      if (fromBlock > latestBlock) {
        // No new blocks to poll
        // But we can use this to confirm finalization
        if (latestBlock > lastWebSocketBlock) {
          // RPC shows blocks ahead of our last WebSocket event
          // Safe to finalize based on RPC's view
          aggregator.onBlock(latestBlock);
        }
        return;
      }

      // Limit range to MAX_BLOCK_RANGE (Monad RPC limit)
      const toBlock = Math.min(latestBlock, fromBlock + MAX_BLOCK_RANGE - 1);

      // Query VoteCast events from the contract
      const filter = httpContract.filters.VoteCast();
      const events = await httpContract.queryFilter(filter, fromBlock, toBlock);

      let newEventsCount = 0;
      for (const event of events) {
        const log = event as ethers.EventLog;
        const player = log.args[0] as string;
        const action = Number(log.args[1]);
        const blockNumber = log.blockNumber;
        const txHash = log.transactionHash;
        const logIndex = log.index;

        if (processVoteEvent(player, action, blockNumber, txHash, logIndex, "poll")) {
          newEventsCount++;
        }
      }

      if (newEventsCount > 0) {
        console.log(`[poll] Found ${newEventsCount} new events from blocks ${fromBlock}-${toBlock}`);
      }

      // Update last polled block to what we actually queried
      lastPolledBlock = toBlock;

      // Use the latest block to trigger window finalization
      // This is the reliable source for knowing when windows end
      aggregator.onBlock(latestBlock);

      // Log window progress
      const windowId = Math.floor(latestBlock / config.windowSize);
      const blocksUntilWindowEnd =
        config.windowSize - (latestBlock % config.windowSize);

      if (blocksUntilWindowEnd === config.windowSize) {
        console.log(`\n--- New Window ${windowId} started at block ${latestBlock} ---`);
      }
    } catch (err) {
      console.error("[poll] Error polling for events:", err);
    }
  }

  // Clean up old events from seenEvents set periodically
  // Keep only events from recent windows to prevent memory growth
  function cleanupOldEvents(): void {
    const currentWindow = Math.floor(lastPolledBlock / config.windowSize);
    const minBlockToKeep = (currentWindow - 2) * config.windowSize;

    for (const eventKey of seenEvents) {
      const blockNumber = parseInt(eventKey.split("-")[0], 10);
      if (blockNumber < minBlockToKeep) {
        seenEvents.delete(eventKey);
      }
    }
  }

  // Start polling at window interval (safety net for WebSocket disconnects)
  const pollInterval = config.windowSize * config.blockTimeMs;
  console.log(`Starting RPC polling every ${pollInterval}ms`);

  // Initial poll
  await pollForEvents();

  // Regular polling
  setInterval(pollForEvents, pollInterval);

  // Cleanup old events every minute
  setInterval(cleanupOldEvents, 60000);

  console.log("Listening for VoteCast events (WebSocket + RPC polling)...");
  console.log(`Streaming at ${STREAM_FPS} FPS\n`);

  // Handle graceful shutdown
  // Graceful shutdown handler (SIGINT for local, SIGTERM for Railway/Docker)
  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    console.log("Saving game state...");
    emulator.saveState();
    console.log("Game saved successfully");
    emulator.stop();
    if (ws) ws.close();
    if (wsReconnectTimeout) clearTimeout(wsReconnectTimeout);
    httpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
