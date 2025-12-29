import { useState, useCallback, useRef } from "react";

export interface LatencyMeasurement {
  action: string;
  latencyMs: number;
  timestamp: number;
}

export interface LatencyStats {
  measurements: LatencyMeasurement[];
  min: number | null;
  max: number | null;
  avg: number | null;
  count: number;
}

interface PendingVote {
  timestamp: number;
  action: string;
}

/**
 * Hook for measuring end-to-end vote latency.
 *
 * Tracks time from user click to when the vote appears via WebSocket.
 *
 * Flow:
 * 1. User clicks vote button -> recordVoteClick(address, action)
 * 2. Vote goes to blockchain
 * 3. Indexer picks up vote via WebSocket subscription
 * 4. Indexer broadcasts vote to frontend via Socket.io
 * 5. Frontend receives vote -> recordVoteReceived(address, action)
 * 6. If pending vote exists for this address, calculate latency
 */
export function useLatencyMeasurement() {
  const [stats, setStats] = useState<LatencyStats>({
    measurements: [],
    min: null,
    max: null,
    avg: null,
    count: 0,
  });

  // Store pending votes by address (lowercase) -> array of pending votes
  // Using array to handle rapid clicks where multiple votes might be pending
  const pendingVotesRef = useRef<Map<string, PendingVote[]>>(new Map());

  // Record when user clicks a vote button
  const recordVoteClick = useCallback((address: string, action: string) => {
    const normalizedAddress = address.toLowerCase();
    const pending = pendingVotesRef.current.get(normalizedAddress) || [];
    pending.push({ timestamp: performance.now(), action });
    pendingVotesRef.current.set(normalizedAddress, pending);

    console.log(`[Latency] Vote click recorded: ${action} from ${normalizedAddress.slice(0, 8)}...`);
  }, []);

  // Record when vote is received via WebSocket
  const recordVoteReceived = useCallback((address: string, action: string) => {
    const normalizedAddress = address.toLowerCase();
    const pending = pendingVotesRef.current.get(normalizedAddress);

    if (!pending || pending.length === 0) {
      // Not our vote or not tracked
      return;
    }

    // Find matching pending vote (same action, FIFO order)
    const matchIndex = pending.findIndex((p) => p.action === action);
    if (matchIndex === -1) {
      // Action mismatch - might be a different vote
      return;
    }

    const matched = pending.splice(matchIndex, 1)[0];
    const latencyMs = performance.now() - matched.timestamp;

    console.log(`[Latency] Vote received: ${action} - ${latencyMs.toFixed(0)}ms`);

    setStats((prev) => {
      const newMeasurement: LatencyMeasurement = {
        action,
        latencyMs,
        timestamp: Date.now(),
      };
      const measurements = [...prev.measurements, newMeasurement].slice(-50); // Keep last 50

      const latencies = measurements.map((m) => m.latencyMs);
      const min = Math.min(...latencies);
      const max = Math.max(...latencies);
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

      return {
        measurements,
        min,
        max,
        avg,
        count: prev.count + 1,
      };
    });
  }, []);

  // Clear all measurements
  const clearStats = useCallback(() => {
    setStats({
      measurements: [],
      min: null,
      max: null,
      avg: null,
      count: 0,
    });
    pendingVotesRef.current.clear();
    console.log("[Latency] Stats cleared");
  }, []);

  return {
    stats,
    recordVoteClick,
    recordVoteReceived,
    clearStats,
  };
}
