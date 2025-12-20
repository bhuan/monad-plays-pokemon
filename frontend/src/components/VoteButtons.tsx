import { useState, useEffect, useRef } from "react";
import { useWallets } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { encodeFunctionData } from "viem";
import {
  Action,
  ACTION_LABELS,
  CONTRACT_ADDRESS,
  CONTRACT_ABI,
  type ActionType,
} from "../config/wagmi";
import "./VoteButtons.css";

interface VoteButtonsProps {
  disabled?: boolean;
}

export function VoteButtons({ disabled }: VoteButtonsProps) {
  const [pendingAction, setPendingAction] = useState<ActionType | null>(null);
  const [lastVote, setLastVote] = useState<ActionType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isVoting, setIsVoting] = useState(false);
  const errorTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Privy hooks for embedded wallet and smart wallet
  const { wallets } = useWallets();
  const { client: smartWalletClient } = useSmartWallets();

  // Wagmi hooks for external wallets (MetaMask, etc.)
  const {
    writeContract,
    data: txHash,
    isPending: isWriting,
    error: writeError,
    reset,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  // Check if user has an embedded wallet
  const hasEmbeddedWallet = wallets.some((w) => w.walletClientType === "privy");

  // Auto-clear error after 3 seconds
  useEffect(() => {
    if (error) {
      if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = setTimeout(() => setError(null), 3000);
    }
    return () => {
      if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current);
    };
  }, [error]);

  // Handle wagmi transaction success (for external wallets)
  useEffect(() => {
    if (isSuccess && pendingAction !== null) {
      console.log("Vote tx confirmed (wagmi):", txHash);
      setLastVote(pendingAction);
      setPendingAction(null);
      setIsVoting(false);
      reset();
    }
  }, [isSuccess, txHash, pendingAction, reset]);

  // Handle wagmi write errors (for external wallets)
  useEffect(() => {
    if (writeError) {
      console.error("Vote failed (wagmi):", writeError);
      const errMsg = writeError.message || "Vote failed";
      if (
        errMsg.includes("rejected") ||
        errMsg.includes("denied") ||
        errMsg.includes("cancelled")
      ) {
        setError("Transaction cancelled");
      } else {
        setError(errMsg.slice(0, 100));
      }
      setPendingAction(null);
      setIsVoting(false);
      reset();
    }
  }, [writeError, reset]);

  const vote = async (action: ActionType) => {
    if (disabled || isVoting) return;

    setPendingAction(action);
    setError(null);
    setIsVoting(true);

    try {
      if (smartWalletClient) {
        // Use smart wallet with paymaster (gas sponsored)
        const data = encodeFunctionData({
          abi: CONTRACT_ABI,
          functionName: "vote",
          args: [action],
        });

        // Use calls format with gas overrides to reduce bundler gas waste
        // Actual usage: callGas ~14.5k, verification ~102k, preVerification varies
        // Adding 25% buffer over observed usage
        const txHash = await smartWalletClient.sendTransaction(
          {
            calls: [{
              to: CONTRACT_ADDRESS as `0x${string}`,
              data,
            }],
            // Gas overrides - minimal thresholds based on actual usage
            callGasLimit: 15000n,           // Actual: ~14,500
            verificationGasLimit: 130000n,  // Actual: ~102,000 + 27% buffer
            preVerificationGas: 165000n,    // Required: ~164k
            // Gas price overrides (bundler minimums: 152.5 gwei fee, 2.5 gwei priority)
            maxFeePerGas: 155000000000n,         // 155 gwei
            maxPriorityFeePerGas: 2500000000n,   // 2.5 gwei tip
          },
          {
            uiOptions: {
              showWalletUIs: false, // Disable confirmation popup
            },
          }
        );

        console.log("Vote tx sent (Smart Wallet, sponsored):", txHash);
        setLastVote(action);
        setPendingAction(null);
        setIsVoting(false);
      } else if (hasEmbeddedWallet) {
        // Fallback: embedded wallet without smart wallet (user pays gas)
        setError("Smart wallet not ready. Please wait or refresh.");
        setPendingAction(null);
        setIsVoting(false);
      } else {
        // Use wagmi's writeContract for external wallets (MetaMask, etc.)
        // This will show the wallet's native approval popup
        // Don't clear pending state here - let the useEffect handle it when tx completes
        writeContract({
          address: CONTRACT_ADDRESS as `0x${string}`,
          abi: CONTRACT_ABI,
          functionName: "vote",
          args: [action],
        });
        // Note: success/error is handled in useEffect watching isSuccess/writeError
      }
    } catch (err: any) {
      console.error("Vote failed:", err);
      const errMsg = err?.message || "Vote failed";
      if (
        errMsg.includes("rejected") ||
        errMsg.includes("denied") ||
        errMsg.includes("cancelled")
      ) {
        setError("Transaction cancelled");
      } else {
        setError(errMsg.slice(0, 100));
      }
      setPendingAction(null);
      setIsVoting(false);
    }
  };

  const isDisabled = disabled || isVoting || isWriting || isConfirming;

  const getButtonText = (action: ActionType, label: string) => {
    if (pendingAction === action && (isVoting || isWriting || isConfirming)) {
      return "...";
    }
    return label;
  };

  return (
    <div className="vote-buttons">
      <h3>Cast Your Vote</h3>

      {/* D-Pad */}
      <div className="dpad">
        <button
          className="dpad-btn up"
          onClick={() => vote(Action.UP)}
          disabled={isDisabled}
        >
          {pendingAction === Action.UP && (isVoting || isWriting || isConfirming)
            ? <span className="loading">...</span>
            : <span className="arrow" />}
        </button>
        <button
          className="dpad-btn left"
          onClick={() => vote(Action.LEFT)}
          disabled={isDisabled}
        >
          {pendingAction === Action.LEFT && (isVoting || isWriting || isConfirming)
            ? <span className="loading">...</span>
            : <span className="arrow" />}
        </button>
        <div className="dpad-center" />
        <button
          className="dpad-btn right"
          onClick={() => vote(Action.RIGHT)}
          disabled={isDisabled}
        >
          {pendingAction === Action.RIGHT && (isVoting || isWriting || isConfirming)
            ? <span className="loading">...</span>
            : <span className="arrow" />}
        </button>
        <button
          className="dpad-btn down"
          onClick={() => vote(Action.DOWN)}
          disabled={isDisabled}
        >
          {pendingAction === Action.DOWN && (isVoting || isWriting || isConfirming)
            ? <span className="loading">...</span>
            : <span className="arrow" />}
        </button>
      </div>

      {/* Action buttons */}
      <div className="action-buttons">
        <button
          className="action-btn b"
          onClick={() => vote(Action.B)}
          disabled={isDisabled}
        >
          {getButtonText(Action.B, "B")}
        </button>
        <button
          className="action-btn a"
          onClick={() => vote(Action.A)}
          disabled={isDisabled}
        >
          {getButtonText(Action.A, "A")}
        </button>
      </div>

      {/* Start/Select */}
      <div className="menu-buttons">
        <button
          className="menu-btn"
          onClick={() => vote(Action.SELECT)}
          disabled={isDisabled}
        >
          {getButtonText(Action.SELECT, "SELECT")}
        </button>
        <button
          className="menu-btn"
          onClick={() => vote(Action.START)}
          disabled={isDisabled}
        >
          {getButtonText(Action.START, "START")}
        </button>
      </div>

      {lastVote !== null && (
        <p className="last-vote">Last vote: {ACTION_LABELS[lastVote]}</p>
      )}

      {error && <p className="error">{error}</p>}

      {disabled && <p className="warning">Sign in to vote</p>}
    </div>
  );
}
