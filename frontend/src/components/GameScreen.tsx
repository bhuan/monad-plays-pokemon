import { useEffect, useRef, useState } from "react";
import type { WindowResult, ScreenInfo } from "../hooks/useSocket";
import "./GameScreen.css";

interface GameScreenProps {
  lastResult: WindowResult | null;
  isConnected: boolean;
  screenInfo: ScreenInfo;
  setFrameCallback: (callback: (frame: ArrayBuffer) => void) => void;
}

export function GameScreen({
  lastResult,
  isConnected,
  screenInfo,
  setFrameCallback
}: GameScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [fps, setFps] = useState(0);
  const frameCountRef = useRef(0);
  const lastFpsUpdateRef = useRef(Date.now());

  // Set up frame rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Create ImageData for rendering frames
    const imageData = ctx.createImageData(screenInfo.width, screenInfo.height);

    const handleFrame = (frameData: ArrayBuffer) => {
      const data = new Uint8Array(frameData);

      // Copy frame data to ImageData
      for (let i = 0; i < data.length && i < imageData.data.length; i++) {
        imageData.data[i] = data[i];
      }

      // Render to canvas
      ctx.putImageData(imageData, 0, 0);

      // Update FPS counter
      frameCountRef.current++;
      const now = Date.now();
      if (now - lastFpsUpdateRef.current >= 1000) {
        setFps(frameCountRef.current);
        frameCountRef.current = 0;
        lastFpsUpdateRef.current = now;
      }
    };

    setFrameCallback(handleFrame);

    // Draw initial state
    ctx.fillStyle = "#9bbc0f";
    ctx.fillRect(0, 0, screenInfo.width, screenInfo.height);
    ctx.fillStyle = "#0f380f";
    ctx.font = "12px monospace";
    ctx.textAlign = "center";
    ctx.fillText("Connecting...", screenInfo.width / 2, screenInfo.height / 2);

  }, [screenInfo, setFrameCallback]);

  // Track move history
  useEffect(() => {
    if (lastResult?.winningAction) {
      setMoveHistory((prev) => [...prev.slice(-9), lastResult.winningAction]);
    }
  }, [lastResult]);

  return (
    <div className="game-screen">
      <div className="screen-bezel">
        <canvas
          ref={canvasRef}
          width={screenInfo.width}
          height={screenInfo.height}
          className="game-canvas"
        />
      </div>

      <div className="status-bar">
        <span className={`status-dot ${isConnected ? "connected" : ""}`} />
        <span>{isConnected ? "Connected" : "Disconnected"}</span>
        {isConnected && <span className="fps-counter">{fps} FPS</span>}
        <span className="rom-status">Pokemon Red</span>
      </div>

      {lastResult && (
        <div className="window-info">
          <span>Window #{lastResult.windowId}</span>
          <span>Votes: {lastResult.totalVotes}</span>
        </div>
      )}

      {moveHistory.length > 0 && (
        <div className="move-history">
          <span>Last: <strong>{moveHistory[moveHistory.length - 1]}</strong></span>
          <span className="history-trail">{moveHistory.slice(-5).join(" → ")}</span>
        </div>
      )}

      <div className="shared-state-notice">
        All players see the same game - votes affect the shared state!
      </div>
    </div>
  );
}
