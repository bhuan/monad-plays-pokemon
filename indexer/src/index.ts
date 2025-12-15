import { ethers } from "ethers";
import { Server } from "socket.io";
import { createServer } from "http";
import * as path from "path";
import { config, contractAbi, Actions } from "./config";
import { VoteAggregator } from "./voteAggregator";
import { GameBoyEmulator } from "./emulator";

// Paths
const ROM_PATH = path.join(__dirname, "..", "roms", "pokemon-red.gb");
const SAVE_PATH = path.join(__dirname, "..", "saves", "pokemon-red.sav");

// Auto-save interval (every 60 seconds)
const AUTO_SAVE_INTERVAL = 60000;

// Frame streaming rate (FPS) - GameBoy native is ~60 FPS
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

  // Initialize GameBoy emulator
  const emulator = new GameBoyEmulator(ROM_PATH, SAVE_PATH);
  try {
    await emulator.init();
  } catch (err) {
    console.error("Failed to initialize emulator:", err);
    process.exit(1);
  }

  // Set up Socket.io server
  const httpServer = createServer();
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
    maxHttpBufferSize: 1e7, // 10MB for frame data
  });

  // Set up frame streaming
  emulator.setFrameCallback((frameData: Buffer) => {
    io.emit("frame", frameData);
  });

  // Track connected clients
  io.on("connection", (socket) => {
    console.log(`Client connected: ${socket.id}`);
    socket.emit("screenInfo", emulator.getScreenDimensions());

    socket.on("disconnect", () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });

  httpServer.listen(config.port, () => {
    console.log(`Socket.io server listening on port ${config.port}`);
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

  // Connect to Monad via WebSocket
  let wsProvider: ethers.WebSocketProvider;

  try {
    wsProvider = new ethers.WebSocketProvider(config.rpcUrl);
    console.log("Connected to Monad WebSocket");
  } catch (err) {
    console.error("Failed to connect to WebSocket provider:", err);
    process.exit(1);
  }

  // Create WebSocket contract instance
  const wsContract = new ethers.Contract(
    config.contractAddress,
    contractAbi,
    wsProvider
  );

  // Process a vote event (with deduplication)
  function processVoteEvent(
    player: string,
    action: number,
    blockNumber: number,
    txHash: string,
    logIndex: number,
    source: "ws" | "poll"
  ): boolean {
    const eventKey = getEventKey(blockNumber, txHash, logIndex);

    if (seenEvents.has(eventKey)) {
      return false; // Already processed
    }

    seenEvents.add(eventKey);
    aggregator.addVote(player, action, blockNumber);
    console.log(
      `[${source}] Vote: ${player.slice(0, 8)}... voted ${Actions[action]} in block ${blockNumber}`
    );
    return true;
  }

  // Listen for VoteCast events via WebSocket
  wsContract.on("VoteCast", (player: string, action: bigint, event: any) => {
    const blockNumber = event.log.blockNumber;
    const txHash = event.log.transactionHash;
    const logIndex = event.log.index;

    lastWebSocketBlock = Math.max(lastWebSocketBlock, blockNumber);
    processVoteEvent(player, Number(action), blockNumber, txHash, logIndex, "ws");
  });

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
    wsProvider.destroy();
    httpServer.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
