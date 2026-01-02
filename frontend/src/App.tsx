import { useEffect, useCallback, useState, useMemo } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { useAccount, useConnect, useDisconnect, useSwitchChain, useChainId } from "wagmi";
import { injected } from "wagmi/connectors";
import { monadTestnet } from "./config/wagmi";
import { useSocket } from "./hooks/useSocket";
import { VoteButtons } from "./components/VoteButtons";
import { GameScreen } from "./components/GameScreen";
import { VoteChat } from "./components/VoteChat";
import { GameStatusPanel } from "./components/GameStatusPanel";
import { PartyPanel } from "./components/PartyPanel";
import "./App.css";

// Auth modes: "privy" for email/social with AA, "direct" for EOA wallet
type AuthMode = "privy" | "direct" | null;

function App() {
  const { login, logout, ready, authenticated, user } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { client: smartWalletClient } = useSmartWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { address, isConnected: walletConnected, connector } = useAccount();

  // Direct wallet connection (wagmi)
  const { connect, isPending: isConnecting } = useConnect();
  const { disconnect: disconnectWagmi } = useDisconnect();
  const { switchChain } = useSwitchChain();

  // Current chain ID
  const chainId = useChainId();

  // Create injected connector
  const injectedConnector = useMemo(() => injected(), []);

  // Track auth mode
  const [authMode, setAuthMode] = useState<AuthMode>(null);

  // Get the smart wallet address (the AA contract address that votes go through)
  const smartWalletAddress = smartWalletClient?.account?.address;
  const {
    isConnected: indexerConnected,
    resultHistory,
    recentVotes,
    screenInfo,
    viewerCount,
    gameState,
    setFrameCallback,
  } = useSocket();

  // Detect auth mode based on connection state
  useEffect(() => {
    if (authenticated && walletConnected) {
      // User logged in via Privy (has embedded wallet or linked wallet)
      setAuthMode("privy");
    } else if (!authenticated && walletConnected && connector) {
      // User connected directly via wagmi (EOA)
      setAuthMode("direct");
    } else if (!authenticated && !walletConnected) {
      setAuthMode(null);
    }
  }, [authenticated, walletConnected, connector]);

  // Prompt to switch chain if connected to wrong network (for direct wallet connections)
  useEffect(() => {
    if (authMode === "direct" && walletConnected && chainId !== monadTestnet.id) {
      console.log(`Wrong chain (${chainId}), switching to Monad Testnet (${monadTestnet.id})`);
      switchChain({ chainId: monadTestnet.id });
    }
  }, [authMode, walletConnected, chainId, switchChain]);

  // Debug: log wallet state
  useEffect(() => {
    console.log("Auth state:", {
      authMode,
      ready,
      authenticated,
      walletsReady,
      walletCount: wallets.length,
      walletConnected,
      connectorName: connector?.name,
      address,
    });
  }, [authMode, ready, authenticated, walletsReady, wallets, walletConnected, connector, address]);

  // Connect Privy wallet to wagmi when user authenticates
  useEffect(() => {
    const connectWallet = async () => {
      if (authenticated && walletsReady && wallets.length > 0 && !walletConnected) {
        // Find embedded wallet or use the first available wallet
        const embeddedWallet = wallets.find((w) => w.walletClientType === "privy");
        const walletToConnect = embeddedWallet || wallets[0];
        if (walletToConnect) {
          console.log("Connecting wallet to wagmi:", walletToConnect.address);
          try {
            await setActiveWallet(walletToConnect);
          } catch (err) {
            console.error("Failed to set active wallet:", err);
          }
        }
      }
    };
    connectWallet();
  }, [authenticated, walletsReady, wallets, walletConnected, setActiveWallet]);

  // Handle Privy login (email/social) - creates embedded wallet with AA
  const handlePrivyLogin = useCallback(() => {
    if (!authenticated) {
      login();
    }
  }, [authenticated, login]);

  // Handle direct wallet connection (EOA - user pays gas)
  const handleDirectConnect = useCallback(async () => {
    try {
      await connect(
        { connector: injectedConnector },
        {
          onSuccess: () => {
            // After connection, switch to Monad Testnet
            switchChain({ chainId: monadTestnet.id });
          },
        }
      );
    } catch (err) {
      console.error("Failed to connect wallet:", err);
    }
  }, [connect, injectedConnector, switchChain]);

  // Handle disconnect for both modes
  const handleDisconnect = useCallback(() => {
    if (authMode === "privy") {
      logout();
    } else if (authMode === "direct") {
      disconnectWagmi();
    }
    setAuthMode(null);
  }, [authMode, logout, disconnectWagmi]);

  // Determine connection state
  const isLoggedIn = authMode !== null && walletConnected;
  const canVote = isLoggedIn;
  const isLoading = !ready || isConnecting;

  // Get display address - use AA wallet for Privy users (that's their on-chain identity)
  // For direct EOA connections, use the connected address
  const displayAddress = authMode === "privy"
    ? smartWalletAddress
    : address;

  // Copy address state
  const [copied, setCopied] = useState(false);

  // FPS from game screen
  const [fps, setFps] = useState(0);

  const copyAddress = useCallback(() => {
    if (displayAddress) {
      navigator.clipboard.writeText(displayAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [displayAddress]);

  return (
    <div className="app">
      <header className="header">
        <h1>Monad Plays Pokemon</h1>
        <p className="subtitle">Decentralized gaming on Monad's 400ms blocks</p>

        <div className="wallet-section">
          {isLoggedIn ? (
            <div className="wallet-info">
              <span className="auth-badge" data-mode={authMode}>
                {authMode === "privy" ? "Gasless" : "EOA"}
              </span>
              <span className="address" title={displayAddress || undefined}>
                {displayAddress
                  ? `${displayAddress.slice(0, 6)}...${displayAddress.slice(-4)}`
                  : "No wallet"}
              </span>
              {displayAddress && (
                <button onClick={copyAddress} className="copy-btn" title="Copy full address">
                  {copied ? "Copied!" : "Copy"}
                </button>
              )}
              {authMode === "privy" && !walletConnected && (
                <span className="connecting"> (connecting wallet...)</span>
              )}
              <button onClick={handleDisconnect} className="disconnect-btn">
                {authMode === "privy" ? "Logout" : "Disconnect"}
              </button>
            </div>
          ) : (
            <>
              <div className="login-options">
                <button
                  onClick={handlePrivyLogin}
                  disabled={isLoading}
                  className="connect-btn privy-btn"
                >
                  {isLoading ? "Loading..." : "Login (Gasless)"}
                </button>
                <span className="login-divider">or</span>
                <button
                  onClick={handleDirectConnect}
                  disabled={isLoading}
                  className="connect-btn wallet-btn"
                >
                  Connect Wallet*
                </button>
              </div>
            </>
          )}
        </div>

        <div className="connection-status-bar">
          <span className={`status-dot ${indexerConnected ? "connected" : ""}`} />
          <span>{indexerConnected ? "Connected" : "Disconnected"}</span>
          {indexerConnected && <span className="fps-counter">{fps} FPS</span>}
          {viewerCount > 0 && (
            <span className="viewer-count">
              <span className="viewer-dot" />
              {viewerCount} watching
            </span>
          )}
        </div>
      </header>

      <main className="main">
        <div className="game-row">
          <div className="game-area">
            <div className="game-with-party">
              <div className="game-column">
                <GameScreen
                  screenInfo={screenInfo}
                  setFrameCallback={setFrameCallback}
                  onFpsUpdate={setFps}
                />
                <GameStatusPanel gameState={gameState} />
              </div>
              <PartyPanel gameState={gameState} />
            </div>
          </div>

          <div className="controls-column">
            <div className="controls-chat-row">
              <div className="controls-container">
                <VoteButtons disabled={!canVote} authMode={authMode} />
              </div>

              <VoteChat
                votes={recentVotes}
                userAddress={authMode === "privy" ? smartWalletAddress : address}
              />
            </div>

            {resultHistory.length > 0 && (() => {
              const lastResult = resultHistory[resultHistory.length - 1];
              const sortedVotes = Object.entries(lastResult.votes)
                .filter(([, count]) => count > 0)
                .sort(([, a], [, b]) => b - a);
              const winningVotes = lastResult.votes[lastResult.winningAction] || 0;
              return (
                <div className="last-winning-move">
                  <span className="last-move-label">Last action:</span>
                  <span className="last-move-action">{lastResult.winningAction}</span>
                  <span className="last-move-total">
                    ({winningVotes} / {lastResult.totalVotes} vote{lastResult.totalVotes !== 1 ? 's' : ''})
                  </span>
                  <span className="last-move-breakdown">
                    {sortedVotes.map(([action, count]) => (
                      <span
                        key={action}
                        className={`breakdown-item ${action === lastResult.winningAction ? 'winner' : ''}`}
                      >
                        {action}:{count}
                      </span>
                    ))}
                  </span>
                </div>
              );
            })()}
          </div>
        </div>
      </main>

      <footer className="footer">
        <p>
          All players see the same game state (Pokemon Red) and vote on Monad Testnet for the next action.
          {" "}<strong>Every 5 blocks</strong> (approx. 2 seconds), the most popular action is executed on the shared game. Ties are broken randomly.
        </p>
        <p className="inspiration">
          Inspired by{" "}
          <a
            href="https://en.wikipedia.org/wiki/Twitch_Plays_Pok%C3%A9mon"
            target="_blank"
            rel="noopener noreferrer"
          >
            Twitch Plays Pokémon
          </a>
        </p>
        <p className="wallet-note">*Phantom wallet is known to be buggy; MetaMask works</p>
      </footer>
    </div>
  );
}

export default App;
