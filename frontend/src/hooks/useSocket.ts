import { useState, useEffect, useCallback, useRef } from "react";
import { io, Socket } from "socket.io-client";

export interface WindowResult {
  windowId: number;
  startBlock: number;
  endBlock: number;
  winningAction: string;
  winningTxHash: string | null;
  votes: Record<string, number>;
  totalVotes: number;
}

export interface Vote {
  player: string;
  action: string;
  blockNumber: number;
  txHash: string;
}

export interface ScreenInfo {
  width: number;
  height: number;
}

// Use same origin if VITE_INDEXER_URL is not set (for single-server deployment)
const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || undefined;

// Construct WebSocket URL for frame streaming
function getStreamUrl(): string {
  if (INDEXER_URL) {
    // Convert http(s) to ws(s)
    const url = new URL(INDEXER_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/stream";
    return url.toString();
  }
  // Same origin
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/stream`;
}

export function useSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [lastResult, setLastResult] = useState<WindowResult | null>(null);
  const [resultHistory, setResultHistory] = useState<WindowResult[]>([]);
  const [recentVotes, setRecentVotes] = useState<Vote[]>([]);
  const [screenInfo, setScreenInfo] = useState<ScreenInfo>({ width: 160, height: 144 });
  const [viewerCount, setViewerCount] = useState(0);
  const frameCallbackRef = useRef<((frame: ArrayBuffer) => void) | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Socket.io for windowResult events (use polling only to avoid WebSocket upgrade errors)
    const socketOptions = { transports: ["polling"] as ("polling")[] };
    const newSocket = INDEXER_URL ? io(INDEXER_URL, socketOptions) : io(socketOptions);
    socketRef.current = newSocket;

    newSocket.on("connect", () => {
      console.log("[Socket.io] Connected");
    });

    newSocket.on("disconnect", () => {
      console.log("[Socket.io] Disconnected");
    });

    newSocket.on("screenInfo", (info: ScreenInfo) => {
      console.log("[Socket.io] Screen info:", info);
      setScreenInfo(info);
    });

    newSocket.on("windowResult", (result: WindowResult) => {
      console.log("[Socket.io] Window result:", result);
      setLastResult(result);
      setResultHistory((prev) => [...prev.slice(-19), result]);
    });

    newSocket.on("vote", (vote: Vote) => {
      console.log("[Socket.io] Vote:", vote);
      setRecentVotes((prev) => [...prev.slice(-49), vote]); // Keep last 50 votes
    });

    // Raw WebSocket for high-performance frame streaming
    const streamUrl = getStreamUrl();
    console.log("[WS] Connecting to frame stream:", streamUrl);

    const ws = new WebSocket(streamUrl);
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      console.log("[WS] Frame stream connected");
      setIsConnected(true);
    };

    ws.onclose = () => {
      console.log("[WS] Frame stream disconnected");
      setIsConnected(false);
    };

    ws.onerror = (err) => {
      console.error("[WS] Frame stream error:", err);
    };

    ws.onmessage = (event) => {
      const data = event.data;

      // Handle JSON messages (screenInfo, viewerCount)
      if (typeof data === "string") {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "screenInfo") {
            setScreenInfo({ width: msg.width, height: msg.height });
          } else if (msg.type === "viewerCount") {
            setViewerCount(msg.count);
          }
        } catch {
          // Ignore parse errors
        }
        return;
      }

      // Handle binary frame data
      if (data instanceof ArrayBuffer && frameCallbackRef.current) {
        frameCallbackRef.current(data);
      }
    };

    return () => {
      newSocket.close();
      ws.close();
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
    recentVotes,
    screenInfo,
    viewerCount,
    setFrameCallback,
    clearHistory,
  };
}
