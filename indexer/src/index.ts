import { ethers } from "ethers";
import { Server } from "socket.io";
import { createServer } from "http";
import * as path from "path";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { config, contractAbi, Actions } from "./config";
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

  // Serve frontend static files if they exist
  if (fs.existsSync(FRONTEND_DIST)) {
    console.log("Serving frontend from:", FRONTEND_DIST);
    app.use(express.static(FRONTEND_DIST));
    // SPA fallback - serve index.html for all non-API routes
    app.use((req, res, next) => {
      if (req.path.startsWith("/socket.io")) return next();
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
