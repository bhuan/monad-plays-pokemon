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

  // Handle wagmi transaction broadcast (for external wallets)
  // Optimistic UI: Enable buttons as soon as tx is broadcast, don't wait for confirmation
  useEffect(() => {
    if (txHash && pendingAction !== null) {
      console.log("Vote tx broadcast (wagmi):", txHash);
      console.log("Buttons re-enabled. Vote will appear in chat via proposed state (~400ms-1s)");
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
        // 1 second is enough for bundler to process the UserOp
        console.log("Vote submitted to bundler, buttons re-enabled in 1s (optimistic)");
        console.log("Vote will appear in chat via proposed state (~400ms-1s)");
        setTimeout(() => {
          setPendingAction(null);
          setIsVoting(false);
        }, 1000);
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
          {pendingAction === Action.UP && (isVoting || isWriting)
            ? <span className="loading">...</span>
            : <span className="arrow" />}
        </button>
        <button
          className="dpad-btn left"
          onClick={() => vote(Action.LEFT)}
          disabled={isDisabled}
        >
          {pendingAction === Action.LEFT && (isVoting || isWriting)
            ? <span className="loading">...</span>
            : <span className="arrow" />}
        </button>
        <div className="dpad-center" />
        <button
          className="dpad-btn right"
          onClick={() => vote(Action.RIGHT)}
          disabled={isDisabled}
        >
          {pendingAction === Action.RIGHT && (isVoting || isWriting)
            ? <span className="loading">...</span>
            : <span className="arrow" />}
        </button>
        <button
          className="dpad-btn down"
          onClick={() => vote(Action.DOWN)}
          disabled={isDisabled}
        >
          {pendingAction === Action.DOWN && (isVoting || isWriting)
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

      {error && <p className="error">{error}</p>}

      {disabled && <p className="warning">Sign in to vote</p>}
    </div>
  );
}
