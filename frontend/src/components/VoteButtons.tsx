import { useState, useEffect, useRef } from "react";
import { ethers } from "ethers";
import { Action, ACTION_LABELS, getContract, type ActionType } from "../utils/contract";
import "./VoteButtons.css";

interface VoteButtonsProps {
  signer: ethers.Signer | null;
  disabled?: boolean;
}

export function VoteButtons({ signer, disabled }: VoteButtonsProps) {
  const [voting, setVoting] = useState<ActionType | null>(null);
  const [lastVote, setLastVote] = useState<ActionType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  const vote = async (action: ActionType) => {
    if (!signer || voting !== null) return;

    setVoting(action);
    setError(null);

    try {
      const contract = await getContract(signer);
      const tx = await contract.vote(action);
      await tx.wait();
      setLastVote(action);
    } catch (err: any) {
      console.error("Vote failed:", err);
      // Handle user rejection gracefully
      if (err?.code === "ACTION_REJECTED" || err?.code === 4001 ||
          err?.message?.includes("rejected") || err?.message?.includes("denied")) {
        setError("Transaction cancelled");
      } else {
        setError(err?.shortMessage || err?.message || "Vote failed");
      }
    } finally {
      setVoting(null);
    }
  };

  const isDisabled = disabled || !signer;

  return (
    <div className="vote-buttons">
      <h3>Cast Your Vote</h3>

      {/* D-Pad */}
      <div className="dpad">
        <button
          className="dpad-btn up"
          onClick={() => vote(Action.UP)}
          disabled={isDisabled || voting !== null}
        >
          {voting === Action.UP ? "..." : "UP"}
        </button>
        <div className="dpad-middle">
          <button
            className="dpad-btn left"
            onClick={() => vote(Action.LEFT)}
            disabled={isDisabled || voting !== null}
          >
            {voting === Action.LEFT ? "..." : "LEFT"}
          </button>
          <div className="dpad-center" />
          <button
            className="dpad-btn right"
            onClick={() => vote(Action.RIGHT)}
            disabled={isDisabled || voting !== null}
          >
            {voting === Action.RIGHT ? "..." : "RIGHT"}
          </button>
        </div>
        <button
          className="dpad-btn down"
          onClick={() => vote(Action.DOWN)}
          disabled={isDisabled || voting !== null}
        >
          {voting === Action.DOWN ? "..." : "DOWN"}
        </button>
      </div>

      {/* Action buttons */}
      <div className="action-buttons">
        <button
          className="action-btn b"
          onClick={() => vote(Action.B)}
          disabled={isDisabled || voting !== null}
        >
          {voting === Action.B ? "..." : "B"}
        </button>
        <button
          className="action-btn a"
          onClick={() => vote(Action.A)}
          disabled={isDisabled || voting !== null}
        >
          {voting === Action.A ? "..." : "A"}
        </button>
      </div>

      {/* Start/Select */}
      <div className="menu-buttons">
        <button
          className="menu-btn"
          onClick={() => vote(Action.SELECT)}
          disabled={isDisabled || voting !== null}
        >
          {voting === Action.SELECT ? "..." : "SELECT"}
        </button>
        <button
          className="menu-btn"
          onClick={() => vote(Action.START)}
          disabled={isDisabled || voting !== null}
        >
          {voting === Action.START ? "..." : "START"}
        </button>
      </div>

      {lastVote !== null && (
        <p className="last-vote">Last vote: {ACTION_LABELS[lastVote]}</p>
      )}

      {error && <p className="error">{error}</p>}

      {!signer && <p className="warning">Connect wallet to vote</p>}
    </div>
  );
}
