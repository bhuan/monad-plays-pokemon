import { useState, useEffect, useRef } from "react";
import { useSendTransaction, useWallets } from "@privy-io/react-auth";
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

  // Privy hooks for embedded wallet
  const { sendTransaction: privySendTransaction } = useSendTransaction();
  const { wallets } = useWallets();

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
      if (hasEmbeddedWallet) {
        // Use Privy's sendTransaction for embedded wallets (auto-approve, no popup)
        const data = encodeFunctionData({
          abi: CONTRACT_ABI,
          functionName: "vote",
          args: [action],
        });

        const txReceipt = await privySendTransaction(
          {
            to: CONTRACT_ADDRESS as `0x${string}`,
            data,
          },
          {
            uiOptions: {
              showWalletUIs: false, // Disable confirmation popup
            },
          }
        );

        console.log("Vote tx sent (Privy):", txReceipt.hash);
        setLastVote(action);
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
          {getButtonText(Action.UP, "UP")}
        </button>
        <div className="dpad-middle">
          <button
            className="dpad-btn left"
            onClick={() => vote(Action.LEFT)}
            disabled={isDisabled}
          >
            {getButtonText(Action.LEFT, "LEFT")}
          </button>
          <div className="dpad-center" />
          <button
            className="dpad-btn right"
            onClick={() => vote(Action.RIGHT)}
            disabled={isDisabled}
          >
            {getButtonText(Action.RIGHT, "RIGHT")}
          </button>
        </div>
        <button
          className="dpad-btn down"
          onClick={() => vote(Action.DOWN)}
          disabled={isDisabled}
        >
          {getButtonText(Action.DOWN, "DOWN")}
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
