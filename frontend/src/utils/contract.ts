import { ethers } from "ethers";

// Contract ABI
export const CONTRACT_ABI = [
  "function vote(uint8 _action) external",
  "event VoteCast(address indexed player, uint8 action)",
];

// Action values matching contract
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

// Contract address (replace after deployment)
export const CONTRACT_ADDRESS =
  import.meta.env.VITE_CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000";

// Monad Testnet chain config
export const MONAD_TESTNET = {
  chainId: "0x279F", // 10143 in hex - placeholder, update with actual Monad testnet chainId
  chainName: "Monad Testnet",
  nativeCurrency: {
    name: "MON",
    symbol: "MON",
    decimals: 18,
  },
  rpcUrls: [import.meta.env.VITE_RPC_URL || "https://testnet-rpc.monad.xyz"],
  blockExplorerUrls: ["https://testnet.monadvision.com"],
};

export async function getContract(signer: ethers.Signer) {
  return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
}
