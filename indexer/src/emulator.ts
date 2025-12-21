import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";

// serverboy is a CommonJS module
const Gameboy = require("serverboy");

// GameBoy screen dimensions
const SCREEN_WIDTH = 160;
const SCREEN_HEIGHT = 144;

// Button mappings - serverboy uses KEYMAP
const BUTTON_MAP: Record<string, number> = {
  RIGHT: Gameboy.KEYMAP.RIGHT,
  LEFT: Gameboy.KEYMAP.LEFT,
  UP: Gameboy.KEYMAP.UP,
  DOWN: Gameboy.KEYMAP.DOWN,
  A: Gameboy.KEYMAP.A,
  B: Gameboy.KEYMAP.B,
  SELECT: Gameboy.KEYMAP.SELECT,
  START: Gameboy.KEYMAP.START,
};

// Helper to access serverboy's internal gameboy core (for full save state support)
function getInternalGameboy(gameboyInterface: any): any {
  const privateKey = Object.keys(gameboyInterface).find((k) => k.startsWith("_"));
  if (!privateKey) return null;
  return gameboyInterface[privateKey]?.gameboy;
}

export class GameBoyEmulator {
  private gameboy: any = null;
  private romPath: string;
  private savePath: string;
  private romData: Buffer | null = null;
  private isRunning: boolean = false;
  private frameInterval: NodeJS.Timeout | null = null;
  private onFrame: ((frame: Buffer) => void) | null = null;
  private pendingButton: string | null = null;
  private buttonFramesRemaining: number = 0;
  private compressionInFlight: number = 0;
  private maxConcurrentCompressions: number = 8;
  // Frame queuing: keep latest frame when compression is backed up
  private queuedFrame: Buffer | null = null;

  constructor(romPath: string, savePath: string) {
    this.romPath = romPath;
    this.savePath = savePath;
  }

  async init(): Promise<void> {
    // Step 1: Verify ROM exists
    console.log("Checking ROM:", this.romPath);
    if (!fs.existsSync(this.romPath)) {
      throw new Error(`ROM file not found: ${this.romPath}`);
    }

    // Step 2: Load ROM data
    console.log("Loading ROM into memory...");
    this.romData = fs.readFileSync(this.romPath);
    console.log(`ROM loaded: ${this.romData.length} bytes`);

    // Step 3: Initialize emulator with ROM first
    this.gameboy = new Gameboy();

    // Step 4: Check for full save state first, then fall back to SRAM-only
    const fullStatePath = this.savePath.replace(/\.sav$/, ".state");
    let loadedFullState = false;

    // Step 5: Load ROM first (required before loading full state)
    this.gameboy.loadRom(this.romData);
    console.log("GameBoy emulator initialized");

    // Step 6: Try to load full save state
    if (fs.existsSync(fullStatePath)) {
      try {
        const stateJson = fs.readFileSync(fullStatePath, "utf-8");
        const fullState = JSON.parse(stateJson);
        const innerGameboy = getInternalGameboy(this.gameboy);
        if (innerGameboy && typeof innerGameboy.saving === "function") {
          innerGameboy.saving(fullState);
          loadedFullState = true;
          console.log(`Full save state loaded from ${fullStatePath}`);
        }
      } catch (err) {
        console.error("Failed to load full save state:", err);
      }
    }

    // Step 7: Fall back to SRAM-only save if no full state
    if (!loadedFullState && fs.existsSync(this.savePath)) {
      try {
        const saveBuffer = fs.readFileSync(this.savePath);
        const saveData = Array.from(saveBuffer);
        console.log(`Falling back to SRAM save: ${saveBuffer.length} bytes from ${this.savePath}`);
        // Re-load ROM with SRAM data
        this.gameboy.loadRom(this.romData, saveData);
        console.log("GameBoy emulator re-initialized with SRAM data");
      } catch (err) {
        console.error("Failed to load SRAM save data:", err);
      }
    }

    if (!loadedFullState) {
      console.log("Starting fresh or with SRAM-only save");
    }
  }

  setFrameCallback(callback: (frame: Buffer) => void): void {
    this.onFrame = callback;
  }

  start(fps: number = 30): void {
    if (this.isRunning || !this.gameboy) return;

    this.isRunning = true;
    const frameTime = 1000 / fps;

    // Run emulator and emit frames
    this.frameInterval = setInterval(() => {
      if (!this.gameboy || !this.isRunning) return;

      // Press button if one is pending
      if (this.pendingButton && this.buttonFramesRemaining > 0) {
        const keyCode = BUTTON_MAP[this.pendingButton];
        if (keyCode !== undefined) {
          this.gameboy.pressKey(keyCode);
        }
        this.buttonFramesRemaining--;
        if (this.buttonFramesRemaining <= 0) {
          this.pendingButton = null;
        }
      }

      // Advance frame
      this.gameboy.doFrame();

      // Get frame data and queue for compression
      if (this.onFrame) {
        const screen = this.gameboy.getScreen();
        if (screen) {
          const rawBuffer = Buffer.from(screen);

          if (this.compressionInFlight < this.maxConcurrentCompressions) {
            // Compression slot available, process immediately
            this.compressAndEmit(rawBuffer);
          } else {
            // All slots busy, queue this frame (replacing any older queued frame)
            this.queuedFrame = rawBuffer;
          }
        }
      }
    }, frameTime);

    console.log(`Emulator running at ${fps} FPS`);
  }

  private compressAndEmit(rawBuffer: Buffer): void {
    this.compressionInFlight++;

    sharp(rawBuffer, {
      raw: {
        width: SCREEN_WIDTH,
        height: SCREEN_HEIGHT,
        channels: 4,
      },
    })
      .jpeg({ quality: 75, chromaSubsampling: '4:2:0' })
      .toBuffer()
      .then((compressed) => {
        this.compressionInFlight--;
        if (this.onFrame) this.onFrame(compressed);

        // Process queued frame if available and slot is free
        if (this.queuedFrame && this.compressionInFlight < this.maxConcurrentCompressions) {
          const queued = this.queuedFrame;
          this.queuedFrame = null;
          this.compressAndEmit(queued);
        }
      })
      .catch(() => {
        this.compressionInFlight--;
        // Still try to process queued frame on error
        if (this.queuedFrame && this.compressionInFlight < this.maxConcurrentCompressions) {
          const queued = this.queuedFrame;
          this.queuedFrame = null;
          this.compressAndEmit(queued);
        }
      });
  }

  stop(): void {
    this.isRunning = false;
    if (this.frameInterval) {
      clearInterval(this.frameInterval);
      this.frameInterval = null;
    }
  }

  pressButton(button: string, durationFrames: number = 5): void {
    if (!this.gameboy) return;

    if (BUTTON_MAP[button] === undefined) {
      console.error("Unknown button:", button);
      return;
    }

    console.log(`Pressing button: ${button} for ${durationFrames} frames`);
    this.pendingButton = button;
    this.buttonFramesRemaining = durationFrames;
  }

  saveState(): void {
    if (!this.gameboy) return;

    try {
      // Get the internal gameboy core to access full save state
      const innerGameboy = getInternalGameboy(this.gameboy);
      if (innerGameboy && typeof innerGameboy.saveState === "function") {
        // Full save state - includes CPU, memory, graphics, audio state
        const fullState = innerGameboy.saveState();
        const fullStatePath = this.savePath.replace(/\.sav$/, ".state");
        const stateJson = JSON.stringify(fullState);
        fs.writeFileSync(fullStatePath, stateJson);
        console.log(`Full state saved to: ${fullStatePath} (${(stateJson.length / 1024).toFixed(1)} KB)`);
      }

      // Also save SRAM for backward compatibility
      const saveData = this.gameboy.getSaveData();
      if (saveData && saveData.length > 0) {
        fs.writeFileSync(this.savePath, Buffer.from(saveData));
        console.log(`SRAM backup saved to: ${this.savePath}`);
      }
    } catch (err) {
      console.error("Failed to save:", err);
    }
  }

  getScreenDimensions(): { width: number; height: number } {
    return { width: SCREEN_WIDTH, height: SCREEN_HEIGHT };
  }

  isInitialized(): boolean {
    return this.gameboy !== null;
  }
}
