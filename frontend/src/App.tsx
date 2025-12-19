import { useEffect, useCallback, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { useAccount } from "wagmi";
import { useSocket } from "./hooks/useSocket";
import { VoteButtons } from "./components/VoteButtons";
import { GameScreen } from "./components/GameScreen";
import "./App.css";

function App() {
  const { login, logout, ready, authenticated, user } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { address, isConnected: walletConnected } = useAccount();
  const {
    isConnected: indexerConnected,
    lastResult,
    resultHistory,
    screenInfo,
    setFrameCallback,
  } = useSocket();

  // Debug: log wallet state
  useEffect(() => {
    console.log("Privy state:", {
      ready,
      authenticated,
      walletsReady,
      walletCount: wallets.length,
      wallets: wallets.map(w => ({ address: w.address, type: w.walletClientType })),
      walletConnected,
      user: user?.wallet
    });
  }, [ready, authenticated, walletsReady, wallets, walletConnected, user]);

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

  // Handle login - only call if not already authenticated
  const handleLogin = useCallback(() => {
    if (!authenticated) {
      login();
    }
  }, [authenticated, login]);

  // Determine connection state - user is "connected" if authenticated with Privy
  // Voting requires wallet to be connected to wagmi
  const isLoggedIn = ready && authenticated;
  const canVote = isLoggedIn && walletConnected;
  const isConnecting = !ready;

  // Get display address from wagmi or Privy user
  const displayAddress = address || user?.wallet?.address;

  // Copy address state
  const [copied, setCopied] = useState(false);

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
              {!walletConnected && <span className="connecting"> (connecting wallet...)</span>}
              <button onClick={logout} className="disconnect-btn">
                Logout
              </button>
            </div>
          ) : (
            <button
              onClick={handleLogin}
              disabled={isConnecting}
              className="connect-btn"
            >
              {isConnecting ? "Loading..." : "Login"}
            </button>
          )}
        </div>

        <p className="auth-hint">
          Login with email, social, or wallet to vote!
        </p>
      </header>

      <main className="main">
        <div className="game-container">
          <GameScreen
            lastResult={lastResult}
            isConnected={indexerConnected}
            screenInfo={screenInfo}
            setFrameCallback={setFrameCallback}
          />
        </div>

        <div className="controls-container">
          <VoteButtons disabled={!canVote} />

          <div className="vote-history">
            <h4>Recent Winning Moves</h4>
            {resultHistory.length === 0 ? (
              <p className="no-history">No votes yet</p>
            ) : (
              <ul>
                {resultHistory
                  .slice()
                  .reverse()
                  .slice(0, 10)
                  .map((result) => (
                    <li key={result.windowId}>
                      <span className="window-id">#{result.windowId}</span>
                      <span className="winning-action">
                        {result.winningAction}
                      </span>
                      <span className="vote-count">
                        ({result.totalVotes} votes)
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      </main>

      <footer className="footer">
        <p>
          Vote using blockchain transactions. Every 5 blocks, the most popular
          action is executed on the shared game.
        </p>
      </footer>
    </div>
  );
}

export default App;
