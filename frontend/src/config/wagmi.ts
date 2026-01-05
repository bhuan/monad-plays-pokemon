import { http } from "wagmi";
import { injected } from "wagmi/connectors";
import { createConfig } from "@privy-io/wagmi";
import { defineChain } from "viem";

// Define Monad Testnet chain
export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: {
    name: "MON",
    symbol: "MON",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://testnet-rpc.monad.xyz"],
      webSocket: ["wss://testnet-rpc.monad.xyz"],
    },
  },
  blockExplorers: {
    default: {
      name: "Monad Explorer",
      url: "https://testnet.monadvision.com",
    },
  },
  testnet: true,
});

// Create wagmi config with direct wallet connectors
// Privy handles embedded wallets, these connectors handle direct EOA connections
export const wagmiConfig = createConfig({
  chains: [monadTestnet] as const,
  connectors: [injected()],
  transports: {
    [monadTestnet.id]: http("https://testnet-rpc.monad.xyz"),
  },
} as Parameters<typeof createConfig>[0]);

// Contract address
export const CONTRACT_ADDRESS =
  import.meta.env.VITE_CONTRACT_ADDRESS || "0xd1770d17d23f5012b5ba6bbf67a19daed3108855";

// EIP-7702 Relay Configuration (experimental)
export const RELAY_CONFIG = {
  // Enable relay mode (backend pays gas)
  enabled: import.meta.env.VITE_RELAY_ENABLED === "true",
  // SimpleDelegation contract address (users delegate to this)
  delegationContract: import.meta.env.VITE_DELEGATION_CONTRACT || "",
  // Relay API URL (defaults to same origin)
  apiUrl: import.meta.env.VITE_RELAY_API_URL || "",
  // Signature validity in seconds
  signatureValiditySeconds: parseInt(import.meta.env.VITE_RELAY_SIGNATURE_VALIDITY || "300", 10),
};

// Contract ABI for voting
export const CONTRACT_ABI = [
  {
    inputs: [{ internalType: "uint8", name: "_action", type: "uint8" }],
    name: "vote",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "player", type: "address" },
      { indexed: false, internalType: "uint8", name: "action", type: "uint8" },
    ],
    name: "VoteCast",
    type: "event",
  },
] as const;

// Action enum
export const Action = {
  UP: 0,
  DOWN: 1,
  LEFT: 2,
  RIGHT: 3,
  A: 4,
  B: 5,
  START: 6,
  SELECT: 7,
} as const;

export type ActionType = (typeof Action)[keyof typeof Action];

export const ACTION_LABELS: Record<ActionType, string> = {
  [Action.UP]: "UP",
  [Action.DOWN]: "DOWN",
  [Action.LEFT]: "LEFT",
  [Action.RIGHT]: "RIGHT",
  [Action.A]: "A",
  [Action.B]: "B",
  [Action.START]: "START",
  [Action.SELECT]: "SELECT",
};
