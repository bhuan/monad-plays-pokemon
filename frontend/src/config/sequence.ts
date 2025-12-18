import { createConfig } from "@0xsequence/connect";
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

// Create Sequence config for embedded wallet
export const sequenceConfig = createConfig("waas", {
  projectAccessKey: import.meta.env.VITE_SEQUENCE_PROJECT_ACCESS_KEY || "",
  waasConfigKey: import.meta.env.VITE_SEQUENCE_WAAS_CONFIG_KEY || "",

  appName: "Monad Plays Pokemon",
  defaultTheme: "dark",

  // Pass chain objects for wagmi/external wallet support
  chains: [monadTestnet],
  chainIds: [monadTestnet.id],
  defaultChainId: monadTestnet.id,

  // Auth options
  signIn: {
    projectName: "Monad Plays Pokemon",
    logoUrl: "/pokemon-logo.png",
  },

  // Enable auth methods - these are handled by Sequence WaaS once enabled in dashboard
  email: false,
  guest: true,
  google: false,  // Disabled until Google OAuth is configured in Sequence Builder
  // apple: true,  // Uncomment when Apple sign-in is configured
});

// Contract address
export const CONTRACT_ADDRESS =
  import.meta.env.VITE_CONTRACT_ADDRESS || "0xd1770d17d23f5012b5ba6bbf67a19daed3108855";

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
