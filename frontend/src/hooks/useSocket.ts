import { useState, useEffect, useCallback, useRef } from "react";
import { io, Socket } from "socket.io-client";

export interface WindowResult {
  windowId: number;
  startBlock: number;
  endBlock: number;
  winningAction: string;
  votes: Record<string, number>;
  totalVotes: number;
}

export interface ScreenInfo {
  width: number;
  height: number;
}

// Use same origin if VITE_INDEXER_URL is not set (for single-server deployment)
const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || undefined;

export function useSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [lastResult, setLastResult] = useState<WindowResult | null>(null);
  const [resultHistory, setResultHistory] = useState<WindowResult[]>([]);
  const [screenInfo, setScreenInfo] = useState<ScreenInfo>({ width: 160, height: 144 });
  const frameCallbackRef = useRef<((frame: ArrayBuffer) => void) | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // If INDEXER_URL is undefined, socket.io connects to same origin
    const newSocket = INDEXER_URL ? io(INDEXER_URL) : io();
    socketRef.current = newSocket;

    newSocket.on("connect", () => {
      console.log("Connected to indexer");
      setIsConnected(true);
    });

    newSocket.on("disconnect", () => {
      console.log("Disconnected from indexer");
      setIsConnected(false);
    });

    newSocket.on("screenInfo", (info: ScreenInfo) => {
      console.log("Screen info:", info);
      setScreenInfo(info);
    });

    newSocket.on("frame", (frameData: ArrayBuffer) => {
      if (frameCallbackRef.current) {
        frameCallbackRef.current(frameData);
      }
    });

    newSocket.on("windowResult", (result: WindowResult) => {
      console.log("Window result:", result);
      setLastResult(result);
      setResultHistory((prev) => [...prev.slice(-19), result]);
    });

    return () => {
      newSocket.close();
    };
  }, []);

  const setFrameCallback = useCallback((callback: (frame: ArrayBuffer) => void) => {
    frameCallbackRef.current = callback;
  }, []);

  const clearHistory = useCallback(() => {
    setResultHistory([]);
    setLastResult(null);
  }, []);

  return {
    isConnected,
    lastResult,
    resultHistory,
    screenInfo,
    setFrameCallback,
    clearHistory,
  };
}
