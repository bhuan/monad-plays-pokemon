import dotenv from "dotenv";
dotenv.config();

export const config = {
  // Monad WebSocket RPC URL
  rpcUrl: process.env.RPC_URL || "wss://testnet-rpc.monad.xyz",

  // Monad HTTP RPC URL (for polling)
  httpRpcUrl: process.env.HTTP_RPC_URL || "https://testnet-rpc.monad.xyz",

  // Contract address (set after deployment)
  contractAddress: process.env.CONTRACT_ADDRESS || "",

  // Number of blocks per voting window
  windowSize: parseInt(process.env.WINDOW_SIZE || "5", 10),

  // Socket.io server port
  port: parseInt(process.env.PORT || "3001", 10),

  // Block time in milliseconds (Monad's target)
  blockTimeMs: parseInt(process.env.BLOCK_TIME_MS || "400", 10),
};

// Contract ABI - only the event we care about
export const contractAbi = [
  "event VoteCast(address indexed player, uint8 action)",
];

// Action enum mapping
export const Actions = [
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "A",
  "B",
  "START",
  "SELECT",
] as const;

export type Action = (typeof Actions)[number];
