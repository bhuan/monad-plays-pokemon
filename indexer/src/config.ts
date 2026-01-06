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

  // EIP-7702 Relay Configuration (experimental)
  relay: {
    // Enable/disable relay endpoint
    enabled: process.env.RELAY_ENABLED === "true",
    // Private key for the relay wallet (pays gas)
    privateKey: process.env.RELAY_PRIVATE_KEY || "",
    // SimpleDelegation contract address
    delegationContract: process.env.DELEGATION_CONTRACT || "",
    // Maximum gas price willing to pay (in gwei)
    maxGasPrice: parseInt(process.env.RELAY_MAX_GAS_PRICE || "200", 10),
    // Signature validity duration (seconds)
    signatureValiditySeconds: parseInt(process.env.RELAY_SIGNATURE_VALIDITY || "300", 10),
  },
};

// Contract ABI - only the event we care about
export const contractAbi = [
  "event VoteCast(address indexed player, uint8 action)",
];

// Full MonadPlaysPokemon ABI for encoding vote calls
export const CONTRACT_ABI = [
  "function vote(uint8 action) external",
  "event VoteCast(address indexed player, uint8 action)",
];

// SimpleDelegation ABI for relay
export const DELEGATION_ABI = [
  "function execute(address to, uint256 value, bytes calldata data, uint256 deadline, bytes calldata signature) external payable returns (bytes memory)",
  "function getNonce(address owner) external view returns (uint256)",
  "function getMessageHash(address owner, address to, uint256 value, bytes calldata data, uint256 nonce, uint256 deadline) external view returns (bytes32)",
  "event Executed(address indexed owner, address indexed to, uint256 value, bytes data)",
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
