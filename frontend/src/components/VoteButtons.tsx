import { useState, useEffect, useRef } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
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
  const errorTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  // Handle write errors
  useEffect(() => {
    if (writeError) {
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
      reset();
    }
  }, [writeError, reset]);

  // Handle successful transaction
  useEffect(() => {
    if (isSuccess && pendingAction !== null) {
      setLastVote(pendingAction);
      setPendingAction(null);
      reset();
    }
  }, [isSuccess, pendingAction, reset]);

  const vote = async (action: ActionType) => {
    if (disabled || isWriting || isConfirming) return;

    setPendingAction(action);
    setError(null);

    try {
      writeContract({
        address: CONTRACT_ADDRESS as `0x${string}`,
        abi: CONTRACT_ABI,
        functionName: "vote",
        args: [action],
      });
    } catch (err: any) {
      console.error("Vote failed:", err);
      setError(err?.message || "Vote failed");
      setPendingAction(null);
    }
  };

  const isVoting = isWriting || isConfirming;
  const isDisabled = disabled || isVoting;

  const getButtonText = (action: ActionType, label: string) => {
    if (pendingAction === action) {
      if (isWriting) return "...";
      if (isConfirming) return "...";
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
