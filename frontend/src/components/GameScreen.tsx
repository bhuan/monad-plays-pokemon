import { useEffect, useRef } from "react";
import type { ScreenInfo } from "../hooks/useSocket";
import "./GameScreen.css";

interface GameScreenProps {
  screenInfo: ScreenInfo;
  setFrameCallback: (callback: (frame: ArrayBuffer) => void) => void;
  onFpsUpdate?: (fps: number) => void;
}

export function GameScreen({
  screenInfo,
  setFrameCallback,
  onFpsUpdate
}: GameScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameCountRef = useRef(0);
  const lastFpsUpdateRef = useRef(Date.now());

  // Set up frame rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const handleFrame = async (frameData: ArrayBuffer) => {
      try {
        // Decode JPEG frame
        const blob = new Blob([frameData], { type: "image/jpeg" });
        const bitmap = await createImageBitmap(blob);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();

        // Update FPS counter
        frameCountRef.current++;
        const now = Date.now();
        if (now - lastFpsUpdateRef.current >= 1000) {
          onFpsUpdate?.(frameCountRef.current);
          frameCountRef.current = 0;
          lastFpsUpdateRef.current = now;
        }
      } catch (err) {
        // Ignore decode errors
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
    </div>
  );
}
