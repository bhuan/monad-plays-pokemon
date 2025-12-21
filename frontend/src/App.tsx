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

  // Get display address from wagmi or Privy user
  const displayAddress = address || user?.wallet?.address;

  // Copy address state
  const [copied, setCopied] = useState(false);

  // Toggle for Recent Winning Moves
  const [showHistory, setShowHistory] = useState(true);

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

      </header>

      <main className="main">
        <div className="game-row">
          <div className="game-container">
            <GameScreen
              isConnected={indexerConnected}
              screenInfo={screenInfo}
              viewerCount={viewerCount}
              setFrameCallback={setFrameCallback}
            />
          </div>

          <div className="controls-chat-row">
            <div className="controls-container">
              <VoteButtons disabled={!canVote} authMode={authMode} />
              {(authMode === "privy" && smartWalletAddress) && (
                <p className="your-wallet">
                  AA Wallet: {smartWalletAddress.slice(0, 6)}...{smartWalletAddress.slice(-4)}
                </p>
              )}
            </div>

            <VoteChat
              votes={recentVotes}
              userAddress={authMode === "privy" ? smartWalletAddress : address}
            />
          </div>
        </div>

        <div className="history-section">
          <button
            className="history-toggle"
            onClick={() => setShowHistory(!showHistory)}
          >
            {showHistory ? 'Hide' : 'Show'} Recent Winning Moves
            <span className="toggle-icon">{showHistory ? '▲' : '▼'}</span>
          </button>

          {showHistory && (
            <div className="vote-history">
              {resultHistory.length === 0 ? (
                <p className="no-history">No results yet</p>
              ) : (
                <ul>
                  {resultHistory
                    .slice()
                    .reverse()
                    .slice(0, 10)
                    .map((result) => (
                      <li key={result.windowId}>
                        <span className="block-range">
                          <a
                            href={`https://testnet.monadvision.com/block/${result.startBlock}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {result.startBlock}
                          </a>
                          -
                          <a
                            href={`https://testnet.monadvision.com/block/${result.endBlock}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {result.endBlock}
                          </a>
                        </span>
                        <span className="winning-action">
                          {result.winningAction}
                        </span>
                        <span className="vote-breakdown">
                          {Object.entries(result.votes)
                            .filter(([, count]) => count > 0)
                            .sort(([, a], [, b]) => b - a)
                            .map(([action, count]) => (
                              <span
                                key={action}
                                className={`vote-item ${action === result.winningAction ? 'winner' : ''}`}
                              >
                                {action}:{count}
                              </span>
                            ))}
                        </span>
                        <span className="vote-total">
                          ({result.totalVotes} total)
                        </span>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </main>

      <footer className="footer">
        <p>
          Vote using blockchain transactions. Every 5 blocks, the most popular
          action is executed on the shared game. Ties are broken randomly.
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
