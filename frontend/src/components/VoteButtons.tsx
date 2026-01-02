import { useState, useEffect, useRef } from "react";
import { useWallets } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { useWriteContract } from "wagmi";
import { encodeFunctionData } from "viem";
import {
  Action,
  CONTRACT_ADDRESS,
  CONTRACT_ABI,
  type ActionType,
} from "../config/wagmi";
import "./VoteButtons.css";

type AuthMode = "privy" | "direct" | null;

interface VoteButtonsProps {
  disabled?: boolean;
  authMode?: AuthMode;
}

export function VoteButtons({ disabled, authMode }: VoteButtonsProps) {
  const [pendingAction, setPendingAction] = useState<ActionType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isVoting, setIsVoting] = useState(false);
  // Track "vote sent" state for visual feedback during cooldown
  const [sentAction, setSentAction] = useState<ActionType | null>(null);
  const errorTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const sentTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  // Note: We intentionally don't use useWaitForTransactionReceipt here.
  // Instead of waiting for on-chain confirmation (~3-5s), we use optimistic UI:
  // - Buttons re-enable immediately after tx broadcast (~200ms)
  // - Vote appears in VoteChat via indexer's proposed state subscription (~400ms-1s)
  // This leverages Monad's monadNewHeads with "Proposed" state for fast feedback.

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

  // Mark vote as sent with visual feedback, auto-clears after delay
  const markVoteSent = (action: ActionType, delayMs: number = 1000) => {
    setSentAction(action);
    if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
    sentTimeoutRef.current = setTimeout(() => {
      setSentAction(null);
    }, delayMs);
  };

  // Cleanup sent timeout on unmount
  useEffect(() => {
    return () => {
      if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
    };
  }, []);

  // Handle wagmi transaction broadcast (for external wallets)
  // Optimistic UI: Enable buttons as soon as tx is broadcast, don't wait for confirmation
  useEffect(() => {
    if (txHash && pendingAction !== null) {
      console.log("Vote tx broadcast (wagmi):", txHash);
      console.log("Buttons re-enabled. Vote will appear in chat via proposed state (~400ms-1s)");
      markVoteSent(pendingAction, 1500); // Show "sent" feedback for 1.5s
      setPendingAction(null);
      setIsVoting(false);
      reset();
    }
  }, [txHash, pendingAction, reset]);

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
      if (authMode === "privy" && smartWalletClient) {
        // Use smart wallet with paymaster (gas sponsored)
        const data = encodeFunctionData({
          abi: CONTRACT_ABI,
          functionName: "vote",
          args: [action],
        });

        // Check if wallet is already deployed (first tx needs higher gas for account creation)
        const isDeployed = await smartWalletClient.account?.isDeployed();

        // Gas overrides - only apply for existing wallets
        // New wallets need higher gas for account creation, let bundler estimate
        const gasOverrides = isDeployed
          ? {
              callGasLimit: 15000n,           // Actual: ~14,500
              verificationGasLimit: 130000n,  // Actual: ~102,000 + 27% buffer
              preVerificationGas: 165000n,    // Required: ~164k
              maxFeePerGas: 155000000000n,    // 155 gwei (bundler min: 152.5)
              maxPriorityFeePerGas: 2500000000n, // 2.5 gwei tip
            }
          : {};

        // Fire-and-forget: Start transaction but don't await confirmation
        // This enables optimistic UI - buttons re-enable immediately
        smartWalletClient.sendTransaction(
          {
            calls: [{
              to: CONTRACT_ADDRESS as `0x${string}`,
              data,
            }],
            ...gasOverrides,
          },
          {
            uiOptions: {
              showWalletUIs: false, // Disable confirmation popup
            },
          }
        )
          .then((txHash) => {
            console.log("Vote tx confirmed (Smart Wallet, sponsored):", txHash);
          })
          .catch((err: any) => {
            console.error("Vote failed (Smart Wallet):", err);
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
          });

        // Optimistic UI: Enable buttons after short cooldown to prevent nonce collisions
        // 1.5 seconds to avoid Privy re-signing dialogs on rapid clicks
        console.log("Vote submitted to bundler, buttons re-enabled in 1.5s (optimistic)");
        console.log("Vote will appear in chat via proposed state (~400ms-1s)");
        // Show "sent" visual feedback immediately, clear after 2s total
        markVoteSent(action, 2000);
        setTimeout(() => {
          setPendingAction(null);
          setIsVoting(false);
        }, 1500);
      } else if (authMode === "privy" && hasEmbeddedWallet && !smartWalletClient) {
        // Privy user but smart wallet not ready yet
        setError("Smart wallet not ready. Please wait or refresh.");
        setPendingAction(null);
        setIsVoting(false);
      } else if (authMode === "direct") {
        // Direct wallet connection (EOA) - user pays gas
        // Use wagmi's writeContract - shows wallet's native approval popup
        writeContract({
          address: CONTRACT_ADDRESS as `0x${string}`,
          abi: CONTRACT_ABI,
          functionName: "vote",
          args: [action],
        });
        // Note: success/error is handled in useEffect watching isSuccess/writeError
      } else {
        setError("No wallet connected");
        setPendingAction(null);
        setIsVoting(false);
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

  const isDisabled = disabled || isVoting || isWriting;

  const getButtonText = (action: ActionType, label: string) => {
    if (pendingAction === action && (isVoting || isWriting)) {
      return "...";
    }
    return label;
  };

  // Check if this specific button shows the "sent" state
  const isButtonSent = (action: ActionType) => sentAction === action;

  return (
    <div className="vote-buttons">
      <h3>Cast Your Vote</h3>

      {/* D-Pad */}
      <div className="dpad">
        <button
          className={`dpad-btn up ${isButtonSent(Action.UP) ? 'sent' : ''}`}
          onClick={() => vote(Action.UP)}
          disabled={isDisabled}
        >
          {pendingAction === Action.UP && (isVoting || isWriting)
            ? <span className="loading">...</span>
            : isButtonSent(Action.UP)
            ? <span className="checkmark">✓</span>
            : <span className="arrow" />}
        </button>
        <button
          className={`dpad-btn left ${isButtonSent(Action.LEFT) ? 'sent' : ''}`}
          onClick={() => vote(Action.LEFT)}
          disabled={isDisabled}
        >
          {pendingAction === Action.LEFT && (isVoting || isWriting)
            ? <span className="loading">...</span>
            : isButtonSent(Action.LEFT)
            ? <span className="checkmark">✓</span>
            : <span className="arrow" />}
        </button>
        <div className="dpad-center" />
        <button
          className={`dpad-btn right ${isButtonSent(Action.RIGHT) ? 'sent' : ''}`}
          onClick={() => vote(Action.RIGHT)}
          disabled={isDisabled}
        >
          {pendingAction === Action.RIGHT && (isVoting || isWriting)
            ? <span className="loading">...</span>
            : isButtonSent(Action.RIGHT)
            ? <span className="checkmark">✓</span>
            : <span className="arrow" />}
        </button>
        <button
          className={`dpad-btn down ${isButtonSent(Action.DOWN) ? 'sent' : ''}`}
          onClick={() => vote(Action.DOWN)}
          disabled={isDisabled}
        >
          {pendingAction === Action.DOWN && (isVoting || isWriting)
            ? <span className="loading">...</span>
            : isButtonSent(Action.DOWN)
            ? <span className="checkmark">✓</span>
            : <span className="arrow" />}
        </button>
      </div>

      {/* Action buttons */}
      <div className="action-buttons">
        <button
          className={`action-btn b ${isButtonSent(Action.B) ? 'sent' : ''}`}
          onClick={() => vote(Action.B)}
          disabled={isDisabled}
        >
          {isButtonSent(Action.B) ? "✓" : getButtonText(Action.B, "B")}
        </button>
        <button
          className={`action-btn a ${isButtonSent(Action.A) ? 'sent' : ''}`}
          onClick={() => vote(Action.A)}
          disabled={isDisabled}
        >
          {isButtonSent(Action.A) ? "✓" : getButtonText(Action.A, "A")}
        </button>
      </div>

      {/* Start/Select */}
      <div className="menu-buttons">
        <button
          className={`menu-btn ${isButtonSent(Action.SELECT) ? 'sent' : ''}`}
          onClick={() => vote(Action.SELECT)}
          disabled={isDisabled}
        >
          {isButtonSent(Action.SELECT) ? "✓ SENT" : getButtonText(Action.SELECT, "SELECT")}
        </button>
        <button
          className={`menu-btn ${isButtonSent(Action.START) ? 'sent' : ''}`}
          onClick={() => vote(Action.START)}
          disabled={isDisabled}
        >
          {isButtonSent(Action.START) ? "✓ SENT" : getButtonText(Action.START, "START")}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {disabled && <p className="warning">Sign in to vote</p>}
    </div>
  );
}
