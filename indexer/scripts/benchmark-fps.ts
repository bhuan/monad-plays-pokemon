#!/usr/bin/env npx ts-node

/**
 * FPS Benchmark Script
 *
 * Connects to the WebSocket frame stream and measures frame delivery rate.
 * Usage: npx ts-node scripts/benchmark-fps.ts [url] [duration]
 *
 * Examples:
 *   npx ts-node scripts/benchmark-fps.ts                           # localhost:3001, 10s
 *   npx ts-node scripts/benchmark-fps.ts https://example.com       # custom URL, 10s
 *   npx ts-node scripts/benchmark-fps.ts https://example.com 30    # custom URL, 30s
 */

import WebSocket from "ws";

const DEFAULT_URL = "http://localhost:3001";
const DEFAULT_DURATION = 10; // seconds

interface Stats {
  frameCount: number;
  totalBytes: number;
  minFrameSize: number;
  maxFrameSize: number;
  frameTimes: number[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function calculatePercentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function getStreamUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/stream";
  return url.toString();
}

async function benchmark(baseUrl: string, durationSec: number): Promise<void> {
  const streamUrl = getStreamUrl(baseUrl);

  console.log(`\n📊 FPS Benchmark`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Target:   ${streamUrl}`);
  console.log(`Duration: ${durationSec} seconds`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const stats: Stats = {
    frameCount: 0,
    totalBytes: 0,
    minFrameSize: Infinity,
    maxFrameSize: 0,
    frameTimes: [],
  };

  let lastFrameTime = 0;
  let connected = false;
  let startTime = 0;

  const ws = new WebSocket(streamUrl);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!connected) {
        console.error("❌ Connection timeout");
        ws.close();
        reject(new Error("Connection timeout"));
      }
    }, 10000);

    ws.on("open", () => {
      connected = true;
      clearTimeout(timeout);
      console.log(`✅ Connected to frame stream`);
      console.log(`⏱️  Measuring for ${durationSec} seconds...\n`);
      startTime = Date.now();
      lastFrameTime = startTime;

      // End benchmark after duration
      setTimeout(() => {
        ws.close();
        printResults(stats, durationSec);
        resolve();
      }, durationSec * 1000);
    });

    ws.on("error", (err: Error) => {
      clearTimeout(timeout);
      console.error(`❌ Connection failed: ${err.message}`);
      reject(err);
    });

    ws.on("message", (data: WebSocket.Data) => {
      // Handle JSON messages (screenInfo)
      if (typeof data === "string") {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "screenInfo") {
            console.log(`📺 Screen: ${msg.width}x${msg.height}`);
          }
        } catch {
          // Ignore parse errors
        }
        return;
      }

      // Handle binary frame data
      const now = Date.now();
      const frameSize = Buffer.isBuffer(data) ? data.length : (data as ArrayBuffer).byteLength;

      stats.frameCount++;
      stats.totalBytes += frameSize;
      stats.minFrameSize = Math.min(stats.minFrameSize, frameSize);
      stats.maxFrameSize = Math.max(stats.maxFrameSize, frameSize);

      if (lastFrameTime > 0) {
        const delta = now - lastFrameTime;
        stats.frameTimes.push(delta);
      }
      lastFrameTime = now;

      // Progress indicator every 60 frames
      if (stats.frameCount % 60 === 0) {
        const elapsed = (now - startTime) / 1000;
        const currentFps = (stats.frameCount / elapsed).toFixed(1);
        process.stdout.write(`\r  Frames: ${stats.frameCount} | FPS: ${currentFps} | Data: ${formatBytes(stats.totalBytes)}   `);
      }
    });

    ws.on("close", () => {
      console.log("\n\n🔌 Disconnected");
    });
  });
}

function printResults(stats: Stats, durationSec: number): void {
  console.log(`\n\n📈 Results`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (stats.frameCount === 0) {
    console.log("❌ No frames received");
    return;
  }

  const avgFps = stats.frameCount / durationSec;
  const avgFrameSize = stats.totalBytes / stats.frameCount;
  const bandwidth = (stats.totalBytes / durationSec) * 8; // bits per second

  console.log(`\nFrame Rate:`);
  console.log(`  Average FPS:     ${avgFps.toFixed(1)}`);
  console.log(`  Total frames:    ${stats.frameCount}`);

  if (stats.frameTimes.length > 1) {
    const avgDelta = stats.frameTimes.reduce((a, b) => a + b, 0) / stats.frameTimes.length;
    const p50 = calculatePercentile(stats.frameTimes, 50);
    const p95 = calculatePercentile(stats.frameTimes, 95);
    const p99 = calculatePercentile(stats.frameTimes, 99);
    const maxDelta = Math.max(...stats.frameTimes);
    const minDelta = Math.min(...stats.frameTimes);

    console.log(`\nFrame Timing (ms between frames):`);
    console.log(`  Average:         ${avgDelta.toFixed(1)} ms`);
    console.log(`  Min:             ${minDelta} ms`);
    console.log(`  Max:             ${maxDelta} ms`);
    console.log(`  P50:             ${p50} ms`);
    console.log(`  P95:             ${p95} ms`);
    console.log(`  P99:             ${p99} ms`);

    // Jitter detection
    const variance = stats.frameTimes.reduce((sum, t) => sum + Math.pow(t - avgDelta, 2), 0) / stats.frameTimes.length;
    const stdDev = Math.sqrt(variance);
    console.log(`  Std Dev:         ${stdDev.toFixed(1)} ms`);
  }

  console.log(`\nBandwidth:`);
  console.log(`  Total data:      ${formatBytes(stats.totalBytes)}`);
  console.log(`  Avg frame size:  ${formatBytes(avgFrameSize)}`);
  console.log(`  Min frame size:  ${formatBytes(stats.minFrameSize)}`);
  console.log(`  Max frame size:  ${formatBytes(stats.maxFrameSize)}`);
  console.log(`  Bitrate:         ${(bandwidth / 1000).toFixed(0)} kbps`);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

// Parse CLI arguments
const args = process.argv.slice(2);
const url = args[0] || DEFAULT_URL;
const duration = parseInt(args[1]) || DEFAULT_DURATION;

benchmark(url, duration).catch((err) => {
  process.exit(1);
});
