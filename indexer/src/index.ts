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
import { GameBoyEmulator } from "./emulator";

// Frontend static files path
const FRONTEND_DIST = path.join(__dirname, "..", "..", "frontend", "dist");

// Paths
const ROM_PATH = path.join(__dirname, "..", "roms", "pokemon-red.gb");
const SAVE_PATH = path.join(__dirname, "..", "saves", "pokemon-red.sav");

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

// Frame streaming rate (FPS) - targeting native GameBoy rate (~60 FPS)
const STREAM_FPS = 60;

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

  if (!config.contractAddress) {
    console.error("ERROR: CONTRACT_ADDRESS not set in environment");
    process.exit(1);
  }

  // Ensure ROM exists (download if needed)
  try {
    await ensureRomExists();
  } catch (err) {
    console.error("Failed to get ROM:", err);
    process.exit(1);
  }

  // Initialize GameBoy emulator
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

  // Socket.io for other events (windowResult, screenInfo)
  io.on("connection", (socket) => {
    console.log(`[Socket.io] Client connected: ${socket.id}`);
    socket.emit("screenInfo", emulator.getScreenDimensions());

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

  // Set up vote aggregator - execute winning move on emulator
  const aggregator = new VoteAggregator(config.windowSize, (result) => {
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
    source: "ws" | "poll" | "proposed"
  ): boolean {
    const eventKey = getEventKey(blockNumber, txHash, logIndex);

    if (seenEvents.has(eventKey)) {
      return false; // Already processed
    }

    seenEvents.add(eventKey);
    aggregator.addVote(player, action, blockNumber, txHash);
    console.log(
      `[${source}] Vote: ${player.slice(0, 8)}... voted ${Actions[action]} in block ${blockNumber}`
    );
    return true;
  }

  // VoteCast event signature: keccak256("VoteCast(address,uint8)")
  const VOTE_CAST_TOPIC = ethers.id("VoteCast(address,uint8)");

  // Connect to Monad WebSocket for monadNewHeads subscription
  const WebSocket = require("ws");
  let ws: InstanceType<typeof WebSocket>;
  let wsReconnectTimeout: NodeJS.Timeout | null = null;

  function connectWebSocket(): void {
    console.log("Connecting to Monad WebSocket for monadNewHeads (Proposed state)...");

    ws = new WebSocket(config.rpcUrl);

    ws.on("open", () => {
      console.log("Connected to Monad WebSocket");

      // Subscribe to monadNewHeads with Proposed state for fastest block detection
      const subscribeMsg = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "monad_subscribe",
        params: ["monadNewHeads", { state: "Proposed" }]
      });
      ws.send(subscribeMsg);
      console.log("Subscribed to monadNewHeads (Proposed state)");
    });

    ws.on("message", async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handle subscription confirmation
        if (msg.id === 1 && msg.result) {
          console.log(`Subscription ID: ${msg.result}`);
          return;
        }

        // Handle subscription data (new proposed block)
        if (msg.method === "monad_subscription" && msg.params?.result) {
          const blockData = msg.params.result;
          const blockNumber = parseInt(blockData.number, 16);
          const blockHash = blockData.hash;

          lastWebSocketBlock = Math.max(lastWebSocketBlock, blockNumber);

          // Trigger window progression on each proposed block
          aggregator.onBlock(blockNumber);

          // Fetch receipts for this block to find VoteCast events
          // Use eth_getBlockReceipts for efficiency
          try {
            const receipts = await httpProvider.send("eth_getBlockReceipts", [blockData.number]);

            if (receipts && Array.isArray(receipts)) {
              for (const receipt of receipts) {
                // Check if this transaction is to our contract
                if (receipt.to?.toLowerCase() !== config.contractAddress.toLowerCase()) {
                  continue;
                }

                // Look for VoteCast events in the logs
                for (const log of receipt.logs || []) {
                  if (log.topics?.[0] === VOTE_CAST_TOPIC) {
                    // Decode the event
                    // topics[1] = indexed player address (padded to 32 bytes)
                    // data = action (uint8)
                    const player = "0x" + log.topics[1].slice(26);
                    const action = parseInt(log.data, 16);
                    const txHash = receipt.transactionHash;
                    const logIndex = parseInt(log.logIndex, 16);

                    processVoteEvent(player, action, blockNumber, txHash, logIndex, "proposed");
                  }
                }
              }
            }
          } catch (receiptErr) {
            // eth_getBlockReceipts might not be available, fall back to polling
            // This is fine - polling will catch it
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
      if (wsReconnectTimeout) clearTimeout(wsReconnectTimeout);
      wsReconnectTimeout = setTimeout(connectWebSocket, 5000);
    });
  }

  // Start WebSocket connection
  connectWebSocket();

  // Poll for events via HTTP RPC
  async function pollForEvents(): Promise<void> {
    try {
      // Get the latest block number
      const latestBlock = await httpProvider.getBlockNumber();

      // Determine the range to query
      // Start from the last polled block (or a recent window if first poll)
      const fromBlock = lastPolledBlock > 0
        ? lastPolledBlock + 1
        : Math.max(0, latestBlock - config.windowSize * 2);

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

      // Query VoteCast events from the contract
      const filter = httpContract.filters.VoteCast();
      const events = await httpContract.queryFilter(filter, fromBlock, latestBlock);

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
        console.log(`[poll] Found ${newEventsCount} new events from blocks ${fromBlock}-${latestBlock}`);
      }

      // Update last polled block
      lastPolledBlock = latestBlock;

      // Use the polled block to trigger window finalization
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

  // Start polling at window interval
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
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    emulator.saveState();
    emulator.stop();
    if (ws) ws.close();
    if (wsReconnectTimeout) clearTimeout(wsReconnectTimeout);
    httpServer.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
