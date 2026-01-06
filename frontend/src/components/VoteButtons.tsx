import { useState, useEffect, useRef } from "react";
import { useWallets, useSendTransaction, useSignMessage } from "@privy-io/react-auth";
import { useWriteContract, useSignMessage as useWagmiSignMessage } from "wagmi";
import { encodeFunctionData, keccak256, encodePacked, toRlp, toHex, type Hex } from "viem";
import {
  Action,
  CONTRACT_ADDRESS,
  CONTRACT_ABI,
  RELAY_CONFIG,
  monadTestnet,
  type ActionType,
} from "../config/wagmi";
import "./VoteButtons.css";

type AuthMode = "privy" | "direct" | "relay" | null;

// Session cache for relay mode optimization
interface RelaySessionCache {
  address: string | null;
  isDelegated: boolean | null;
  nonce: number | null;
}

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

  // Session cache for relay mode - avoids redundant API calls
  const relayCache = useRef<RelaySessionCache>({
    address: null,
    isDelegated: null,
    nonce: null,
  });

  // Cooldown state for visual feedback (buttons greyed out)
  const [isCooldown, setIsCooldown] = useState(false);
  const cooldownTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const VOTE_COOLDOWN_MS = 1500; // Min 1.5s between votes (Privy rate limits)

  // Synchronous ref-based cooldown check (React state updates are async)
  const lastVoteTimeRef = useRef<number>(0);

  // Privy hooks for embedded wallet
  const { wallets } = useWallets();

  // Privy native sendTransaction (for testing without EIP-4337)
  const { sendTransaction: privySendTransaction } = useSendTransaction();

  // Privy signMessage for relay mode
  const { signMessage: privySignMessage } = useSignMessage();

  // Wagmi signMessage for direct wallet relay mode
  const { signMessageAsync: wagmiSignMessage } = useWagmiSignMessage();

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

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
      if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
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
    if (disabled || isVoting || isCooldown) return;

    // Synchronous ref-based cooldown check (React state may not be updated yet on rapid clicks)
    const now = Date.now();
    if (now - lastVoteTimeRef.current < VOTE_COOLDOWN_MS) {
      console.log(`[cooldown] Vote rejected - ${VOTE_COOLDOWN_MS - (now - lastVoteTimeRef.current)}ms remaining`);
      return;
    }
    lastVoteTimeRef.current = now;

    // Start cooldown immediately (visual feedback)
    setIsCooldown(true);
    if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
    cooldownTimeoutRef.current = setTimeout(() => setIsCooldown(false), VOTE_COOLDOWN_MS);

    setPendingAction(action);
    setError(null);
    setIsVoting(true);

    try {
      if (authMode === "privy" && hasEmbeddedWallet) {
        // Use Privy native sendTransaction with embedded wallet
        // TESTING: First without sponsorship to prove it works
        const data = encodeFunctionData({
          abi: CONTRACT_ABI,
          functionName: "vote",
          args: [action],
        });

        const startTime = performance.now();
        console.log(`[TIMING] Vote started (native Privy) at ${new Date().toISOString()}`);

        // Find the embedded wallet address
        const embeddedWallet = wallets.find((w) => w.walletClientType === "privy");
        if (!embeddedWallet) {
          setError("No embedded wallet found");
          setPendingAction(null);
          setIsVoting(false);
          return;
        }

        try {
          // Use Privy's native sendTransaction
          // Set sponsor: false first to test without gas sponsorship
          // Change to sponsor: true to test gas sponsorship
          const USE_SPONSORSHIP = true; // Testing Privy native gas sponsorship

          const txReceipt = await privySendTransaction(
            {
              to: CONTRACT_ADDRESS as `0x${string}`,
              data,
              chainId: 10143, // Monad Testnet
            },
            {
              address: embeddedWallet.address,
              // uiOptions: { showWalletUIs: false }, // Requires dashboard setting
              ...(USE_SPONSORSHIP ? { sponsor: true } : {}),
            }
          );

          const duration = performance.now() - startTime;
          console.log(`[TIMING] ✅ Transaction sent after ${duration.toFixed(0)}ms - txHash: ${txReceipt.hash}`);
          markVoteSent(action, 1500);
          setPendingAction(null);
          setIsVoting(false);
        } catch (err: any) {
          const duration = performance.now() - startTime;
          console.error(`[TIMING] ❌ Vote failed after ${duration.toFixed(0)}ms:`, err);
          const errMsg = err?.message || "Vote failed";
          if (
            errMsg.includes("rejected") ||
            errMsg.includes("denied") ||
            errMsg.includes("cancelled")
          ) {
            setError("Transaction cancelled");
          } else if (errMsg.includes("insufficient funds")) {
            setError("Insufficient funds - need MON for gas");
          } else if (
            errMsg.includes("higher priority") ||
            errMsg.includes("nonce") ||
            errMsg.includes("Too many requests") ||
            errMsg.includes("429")
          ) {
            // Nonce collision or rate limit - silently ignore, don't show UI error
            console.log("[TIMING] Nonce collision or rate limit detected, try again later");
          } else {
            setError(errMsg.slice(0, 100));
          }
          setPendingAction(null);
          setIsVoting(false);
        }
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
      } else if (authMode === "relay") {
        // EIP-7702 Relay mode - backend pays gas, user just signs
        const startTime = performance.now();
        console.log(`[TIMING] Vote started (relay) at ${new Date().toISOString()}`);

        // Find the user's wallet (embedded or connected)
        const embeddedWallet = wallets.find((w) => w.walletClientType === "privy");
        const connectedWallet = wallets.find((w) => w.walletClientType !== "privy");
        const userWallet = embeddedWallet || connectedWallet;

        if (!userWallet) {
          setError("No wallet found");
          setPendingAction(null);
          setIsVoting(false);
          return;
        }

        const userAddress = userWallet.address as `0x${string}`;
        const relayApiUrl = RELAY_CONFIG.apiUrl || "";

        try {
          // Reset cache if address changed
          if (relayCache.current.address !== userAddress) {
            relayCache.current = { address: userAddress, isDelegated: null, nonce: null };
          }

          // 1. Check if user is already delegated (use cache if available)
          let isDelegated = relayCache.current.isDelegated;
          if (isDelegated === null) {
            const delegatedResponse = await fetch(`${relayApiUrl}/relay/delegated/${userAddress}`);
            const result = await delegatedResponse.json();
            isDelegated = result.delegated;
            relayCache.current.isDelegated = isDelegated;
            console.log(`[relay] User ${userAddress.slice(0, 8)}... delegated: ${isDelegated} (fetched)`);
          } else {
            console.log(`[relay] User ${userAddress.slice(0, 8)}... delegated: ${isDelegated} (cached)`);
          }

          // 2. Get nonce - use optimistic cache if available, otherwise fetch
          let nonce = relayCache.current.nonce;
          if (nonce === null) {
            const nonceResponse = await fetch(`${relayApiUrl}/relay/nonce/${userAddress}`);
            if (!nonceResponse.ok) {
              throw new Error("Failed to get nonce");
            }
            const result = await nonceResponse.json();
            nonce = result.nonce;
            relayCache.current.nonce = nonce;
            console.log(`[relay] Nonce: ${nonce} (fetched)`);
          } else {
            console.log(`[relay] Nonce: ${nonce} (optimistic)`);
          }

          // 3. Encode vote calldata
          const voteData = encodeFunctionData({
            abi: CONTRACT_ABI,
            functionName: "vote",
            args: [action],
          });

          // 4. Calculate deadline
          const deadline = BigInt(Math.floor(Date.now() / 1000) + RELAY_CONFIG.signatureValiditySeconds);

          // 5. Build message hash matching SimpleDelegation.execute()
          // Message = keccak256(abi.encodePacked(owner, to, value, data, nonce, deadline, chainId))
          const messageHash = keccak256(
            encodePacked(
              ["address", "address", "uint256", "bytes", "uint256", "uint256", "uint256"],
              [
                userAddress,                           // owner (the delegated EOA)
                CONTRACT_ADDRESS as `0x${string}`,     // to (vote contract)
                BigInt(0),                             // value (0 ETH)
                voteData,                              // data (vote calldata)
                BigInt(nonce),                         // nonce
                deadline,                              // deadline
                BigInt(monadTestnet.id),               // chainId
              ]
            )
          );

          // 6. Sign the execute message (EIP-191 personal_sign adds prefix automatically)
          let signature: string;
          if (embeddedWallet) {
            // Use Privy signMessage for embedded wallets
            const signResult = await privySignMessage(
              { message: messageHash },
              { address: userAddress }
            );
            signature = signResult.signature;
          } else {
            // Use wagmi signMessage for external wallets
            signature = await wagmiSignMessage({ message: { raw: messageHash as `0x${string}` } });
          }

          // 7. If not delegated, also sign EIP-7702 authorization
          let authorization = null;
          if (!isDelegated) {
            console.log(`[relay] First vote - signing EIP-7702 authorization`);

            // Get EOA's transaction nonce (different from SimpleDelegation nonce)
            // For first vote, EOA nonce should be 0 for new accounts
            const eoaNonceResponse = await fetch(
              `https://testnet-rpc.monad.xyz`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  method: "eth_getTransactionCount",
                  params: [userAddress, "latest"],
                  id: 1,
                }),
              }
            );
            const eoaNonceResult = await eoaNonceResponse.json();
            const eoaNonce = parseInt(eoaNonceResult.result, 16);

            // EIP-7702 authorization hash: keccak256(0x05 || rlp([chainId, address, nonce]))
            // Note: The signer signs this hash directly (no EIP-191 prefix for EIP-7702)
            const delegationContract = RELAY_CONFIG.delegationContract as `0x${string}`;
            const chainId = BigInt(monadTestnet.id);

            // RLP encode [chainId, address, nonce]
            const rlpEncoded = toRlp([
              chainId === 0n ? "0x" : toHex(chainId),
              delegationContract,
              eoaNonce === 0 ? "0x" : toHex(eoaNonce),
            ]);

            // Authorization hash = keccak256(0x05 || rlp([chainId, address, nonce]))
            const authHash = keccak256(("0x05" + rlpEncoded.slice(2)) as Hex);

            // Sign the authorization hash (raw hash, no EIP-191 prefix)
            // EIP-7702 requires raw ECDSA signature without any prefix
            // Privy supports this via secp256k1_sign method
            let authSig: string;
            if (embeddedWallet) {
              // Use Privy's secp256k1_sign for raw hash signing (no EIP-191 prefix)
              // This is required for EIP-7702 authorization
              const provider = await embeddedWallet.getEthereumProvider();
              authSig = await provider.request({
                method: 'secp256k1_sign',
                params: [authHash],
              }) as string;
              console.log(`[relay] Raw signature obtained via secp256k1_sign`);
            } else {
              // For external wallets, try eth_sign (deprecated but works for raw hashes)
              // Note: Many wallets block this for security, may need wallet_sendCalls
              authSig = await wagmiSignMessage({ message: { raw: authHash as `0x${string}` } });
            }

            // Parse signature into r, s, yParity
            const r = ("0x" + authSig.slice(2, 66)) as `0x${string}`;
            const s = ("0x" + authSig.slice(66, 130)) as `0x${string}`;
            const v = parseInt(authSig.slice(130, 132), 16);
            const yParity = v === 27 ? 0 : v === 28 ? 1 : v; // Handle both legacy v and yParity

            authorization = {
              chainId: Number(chainId),
              nonce: eoaNonce,
              r,
              s,
              yParity,
            };

            console.log(`[relay] EIP-7702 authorization signed (EOA nonce: ${eoaNonce})`);
          }

          // 8. Send to relay endpoint
          const relayResponse = await fetch(`${relayApiUrl}/relay`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userAddress,
              action,
              deadline: Number(deadline),
              signature,
              authorization, // null if already delegated, object if first vote
            }),
          });

          const relayResult = await relayResponse.json();

          if (!relayResponse.ok) {
            // Check if error is nonce-related (InvalidSignature often means stale nonce)
            const errMsg = relayResult.error || "";
            if (errMsg.includes("InvalidSignature") || errMsg.includes("nonce")) {
              console.log(`[relay] Nonce mismatch detected, clearing cache for retry`);
              relayCache.current.nonce = null; // Force re-fetch on next attempt
            }
            throw new Error(relayResult.error || "Relay failed");
          }

          // Success! Update optimistic cache
          relayCache.current.nonce = nonce + 1; // Increment nonce for next vote
          if (!isDelegated) {
            relayCache.current.isDelegated = true; // Mark as delegated after first successful vote
          }

          const duration = performance.now() - startTime;
          console.log(`[TIMING] Vote relayed after ${duration.toFixed(0)}ms - txHash: ${relayResult.txHash}`);
          markVoteSent(action, 1500);
          setPendingAction(null);
          setIsVoting(false);
        } catch (err: any) {
          const duration = performance.now() - startTime;
          console.error(`[TIMING] Vote relay failed after ${duration.toFixed(0)}ms:`, err);
          const errMsg = err?.message || "Relay failed";

          // Reset nonce cache on potential nonce issues for recovery on next attempt
          if (errMsg.includes("InvalidSignature") || errMsg.includes("nonce") || errMsg.includes("reverted")) {
            relayCache.current.nonce = null;
          }

          if (errMsg.includes("rejected") || errMsg.includes("denied") || errMsg.includes("cancelled")) {
            setError("Signature cancelled");
          } else if (errMsg.includes("higher priority") || errMsg.includes("request limit")) {
            // Rate limit / tx collision - just log, don't show UI error
            console.log("[relay] Transaction collision or rate limit, try again");
          } else {
            setError(errMsg.slice(0, 100));
          }
          setPendingAction(null);
          setIsVoting(false);
        }
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

  const isDisabled = disabled || isVoting || isWriting || isCooldown;

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
