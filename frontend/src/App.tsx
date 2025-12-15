import { useWallet } from "./hooks/useWallet";
import { useSocket } from "./hooks/useSocket";
import { VoteButtons } from "./components/VoteButtons";
import { GameScreen } from "./components/GameScreen";
import "./App.css";

function App() {
  const { address, signer, isConnecting, error, connect, disconnect, isConnected } =
    useWallet();
  const {
    isConnected: indexerConnected,
    lastResult,
    resultHistory,
    screenInfo,
    setFrameCallback
  } = useSocket();

  return (
    <div className="app">
      <header className="header">
        <h1>Monad Plays Pokemon</h1>
        <p className="subtitle">Decentralized gaming on Monad's 400ms blocks</p>

        <div className="wallet-section">
          {isConnected ? (
            <div className="wallet-info">
              <span className="address">
                {address?.slice(0, 6)}...{address?.slice(-4)}
              </span>
              <button onClick={disconnect} className="disconnect-btn">
                Disconnect
              </button>
            </div>
          ) : (
            <button
              onClick={connect}
              disabled={isConnecting}
              className="connect-btn"
            >
              {isConnecting ? "Connecting..." : "Connect Wallet"}
            </button>
          )}
        </div>

        {error && <p className="error">{error}</p>}
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
          <VoteButtons signer={signer} disabled={!isConnected} />

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
                      <span className="winning-action">{result.winningAction}</span>
                      <span className="vote-count">({result.totalVotes} votes)</span>
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
