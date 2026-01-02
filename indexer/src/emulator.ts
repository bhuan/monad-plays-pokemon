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

  // Pokemon Red Memory Addresses
  // Source: https://datacrystal.tcrf.net/wiki/Pokémon_Red_and_Blue/RAM_map
  getGameState(): GameState | null {
    if (!this.gameboy) return null;

    try {
      const memory = this.gameboy.getMemory();
      if (!memory || memory.length < 0xD400) return null;

      // Badges at 0xD356 - each bit represents a badge
      const badgeByte = memory[0xD356] || 0;
      const badges = {
        boulder: !!(badgeByte & 0x01),
        cascade: !!(badgeByte & 0x02),
        thunder: !!(badgeByte & 0x04),
        rainbow: !!(badgeByte & 0x08),
        soul: !!(badgeByte & 0x10),
        marsh: !!(badgeByte & 0x20),
        volcano: !!(badgeByte & 0x40),
        earth: !!(badgeByte & 0x80),
      };
      const badgeCount = Object.values(badges).filter(Boolean).length;

      // Map ID at 0xD35E
      const mapId = memory[0xD35E] || 0;
      const location = MAP_NAMES[mapId] || `Unknown (${mapId})`;

      // Player position
      const playerY = memory[0xD361] || 0;
      const playerX = memory[0xD362] || 0;

      // Party count at 0xD163
      const partyCount = Math.min(memory[0xD163] || 0, 6);

      // Party Pokemon species at 0xD164-0xD169
      // Pokemon Red uses internal IDs that differ from Pokedex numbers
      const partySpecies: number[] = [];
      for (let i = 0; i < partyCount; i++) {
        const internalId = memory[0xD164 + i] || 0;
        const pokedexNum = INTERNAL_TO_POKEDEX[internalId] || 0;
        partySpecies.push(pokedexNum);
      }

      // Party Pokemon HP data
      // Each Pokemon struct is 44 (0x2C) bytes starting at 0xD16B
      // Current HP at offset 0x01 (2 bytes big-endian)
      // Max HP at offset 0x22 (2 bytes big-endian)
      const PARTY_DATA_START = 0xD16B;
      const POKEMON_STRUCT_SIZE = 0x2C;
      const partyHp: { current: number; max: number }[] = [];
      for (let i = 0; i < partyCount; i++) {
        const baseAddr = PARTY_DATA_START + (i * POKEMON_STRUCT_SIZE);
        const currentHp = ((memory[baseAddr + 0x01] || 0) << 8) | (memory[baseAddr + 0x02] || 0);
        const maxHp = ((memory[baseAddr + 0x22] || 0) << 8) | (memory[baseAddr + 0x23] || 0);
        partyHp.push({ current: currentHp, max: maxHp });
      }

      // Money at 0xD347-D349 (BCD encoded, big-endian)
      const moneyBcd1 = memory[0xD347] || 0;
      const moneyBcd2 = memory[0xD348] || 0;
      const moneyBcd3 = memory[0xD349] || 0;
      const money = decodeBCD(moneyBcd1) * 10000 + decodeBCD(moneyBcd2) * 100 + decodeBCD(moneyBcd3);

      return {
        badges,
        badgeCount,
        mapId,
        location,
        playerX,
        playerY,
        partyCount,
        partySpecies,
        partyHp,
        money,
      };
    } catch (err) {
      console.error("Failed to read game state:", err);
      return null;
    }
  }
}

// Decode BCD (Binary Coded Decimal) byte to number
function decodeBCD(byte: number): number {
  return ((byte >> 4) & 0x0F) * 10 + (byte & 0x0F);
}

// Game state interface
export interface GameState {
  badges: {
    boulder: boolean;
    cascade: boolean;
    thunder: boolean;
    rainbow: boolean;
    soul: boolean;
    marsh: boolean;
    volcano: boolean;
    earth: boolean;
  };
  badgeCount: number;
  mapId: number;
  location: string;
  playerX: number;
  playerY: number;
  partyCount: number;
  partySpecies: number[]; // Pokedex numbers of party Pokemon
  partyHp: { current: number; max: number }[]; // HP for each party Pokemon
  money: number;
}

// Pokemon Red internal ID to Pokedex number mapping
// Pokemon Red/Blue use internal IDs that differ from Pokedex order
const INTERNAL_TO_POKEDEX: Record<number, number> = {
  0x01: 112, // Rhydon
  0x02: 115, // Kangaskhan
  0x03: 32,  // Nidoran♂
  0x04: 35,  // Clefairy
  0x05: 21,  // Spearow
  0x06: 100, // Voltorb
  0x07: 34,  // Nidoking
  0x08: 80,  // Slowbro
  0x09: 2,   // Ivysaur
  0x0A: 103, // Exeggutor
  0x0B: 108, // Lickitung
  0x0C: 102, // Exeggcute
  0x0D: 88,  // Grimer
  0x0E: 94,  // Gengar
  0x0F: 29,  // Nidoran♀
  0x10: 31,  // Nidoqueen
  0x11: 104, // Cubone
  0x12: 111, // Rhyhorn
  0x13: 131, // Lapras
  0x14: 59,  // Arcanine
  0x15: 151, // Mew
  0x16: 130, // Gyarados
  0x17: 90,  // Shellder
  0x18: 72,  // Tentacool
  0x19: 92,  // Gastly
  0x1A: 123, // Scyther
  0x1B: 120, // Staryu
  0x1C: 9,   // Blastoise
  0x1D: 127, // Pinsir
  0x1E: 114, // Tangela
  0x21: 58,  // Growlithe
  0x22: 95,  // Onix
  0x23: 22,  // Fearow
  0x24: 16,  // Pidgey
  0x25: 79,  // Slowpoke
  0x26: 64,  // Kadabra
  0x27: 75,  // Graveler
  0x28: 113, // Chansey
  0x29: 67,  // Machoke
  0x2A: 122, // Mr. Mime
  0x2B: 106, // Hitmonlee
  0x2C: 107, // Hitmonchan
  0x2D: 24,  // Arbok
  0x2E: 47,  // Parasect
  0x2F: 54,  // Psyduck
  0x30: 96,  // Drowzee
  0x31: 76,  // Golem
  0x33: 126, // Magmar
  0x35: 125, // Electabuzz
  0x36: 82,  // Magneton
  0x37: 109, // Koffing
  0x39: 56,  // Mankey
  0x3A: 86,  // Seel
  0x3B: 50,  // Diglett
  0x3C: 128, // Tauros
  0x40: 83,  // Farfetch'd
  0x41: 48,  // Venonat
  0x42: 149, // Dragonite
  0x46: 84,  // Doduo
  0x47: 60,  // Poliwag
  0x48: 124, // Jynx
  0x49: 146, // Moltres
  0x4A: 144, // Articuno
  0x4B: 145, // Zapdos
  0x4C: 132, // Ditto
  0x4D: 52,  // Meowth
  0x4E: 98,  // Krabby
  0x52: 37,  // Vulpix
  0x53: 38,  // Ninetales
  0x54: 25,  // Pikachu
  0x55: 26,  // Raichu
  0x58: 147, // Dratini
  0x59: 148, // Dragonair
  0x5A: 140, // Kabuto
  0x5B: 141, // Kabutops
  0x5C: 116, // Horsea
  0x5D: 117, // Seadra
  0x60: 27,  // Sandshrew
  0x61: 28,  // Sandslash
  0x62: 138, // Omanyte
  0x63: 139, // Omastar
  0x64: 39,  // Jigglypuff
  0x65: 40,  // Wigglytuff
  0x66: 133, // Eevee
  0x67: 136, // Flareon
  0x68: 135, // Jolteon
  0x69: 134, // Vaporeon
  0x6A: 66,  // Machop
  0x6B: 41,  // Zubat
  0x6C: 23,  // Ekans
  0x6D: 46,  // Paras
  0x6E: 61,  // Poliwhirl
  0x6F: 62,  // Poliwrath
  0x70: 13,  // Weedle
  0x71: 14,  // Kakuna
  0x72: 15,  // Beedrill
  0x74: 85,  // Dodrio
  0x75: 57,  // Primeape
  0x76: 51,  // Dugtrio
  0x77: 49,  // Venomoth
  0x78: 87,  // Dewgong
  0x7B: 10,  // Caterpie
  0x7C: 11,  // Metapod
  0x7D: 12,  // Butterfree
  0x7E: 68,  // Machamp
  0x80: 55,  // Golduck
  0x81: 97,  // Hypno
  0x82: 42,  // Golbat
  0x83: 150, // Mewtwo
  0x84: 143, // Snorlax
  0x85: 129, // Magikarp
  0x88: 89,  // Muk
  0x8A: 99,  // Kingler
  0x8B: 91,  // Cloyster
  0x8D: 101, // Electrode
  0x8E: 36,  // Clefable
  0x8F: 110, // Weezing
  0x90: 53,  // Persian
  0x91: 105, // Marowak
  0x93: 93,  // Haunter
  0x94: 63,  // Abra
  0x95: 65,  // Alakazam
  0x96: 17,  // Pidgeotto
  0x97: 18,  // Pidgeot
  0x98: 121, // Starmie
  0x99: 1,   // Bulbasaur
  0x9A: 3,   // Venusaur
  0x9B: 73,  // Tentacruel
  0x9D: 118, // Goldeen
  0x9E: 119, // Seaking
  0xA3: 77,  // Ponyta
  0xA4: 78,  // Rapidash
  0xA5: 19,  // Rattata
  0xA6: 20,  // Raticate
  0xA7: 33,  // Nidorino
  0xA8: 30,  // Nidorina
  0xA9: 74,  // Geodude
  0xAA: 137, // Porygon
  0xAB: 142, // Aerodactyl
  0xAD: 81,  // Magnemite
  0xB0: 4,   // Charmander
  0xB1: 7,   // Squirtle
  0xB2: 5,   // Charmeleon
  0xB3: 8,   // Wartortle
  0xB4: 6,   // Charizard
  0xB9: 43,  // Oddish
  0xBA: 44,  // Gloom
  0xBB: 45,  // Vileplume
  0xBC: 69,  // Bellsprout
  0xBD: 70,  // Weepinbell
  0xBE: 71,  // Victreebel
}

// Pokemon Red map IDs to location names
// Source: https://github.com/pret/pokered/blob/master/constants/map_constants.asm
const MAP_NAMES: Record<number, string> = {
  0: "Pallet Town",
  1: "Viridian City",
  2: "Pewter City",
  3: "Cerulean City",
  4: "Lavender Town",
  5: "Vermilion City",
  6: "Celadon City",
  7: "Fuchsia City",
  8: "Cinnabar Island",
  9: "Indigo Plateau",
  10: "Saffron City",
  12: "Route 1",
  13: "Route 2",
  14: "Route 3",
  15: "Route 4",
  16: "Route 5",
  17: "Route 6",
  18: "Route 7",
  19: "Route 8",
  20: "Route 9",
  21: "Route 10",
  22: "Route 11",
  23: "Route 12",
  24: "Route 13",
  25: "Route 14",
  26: "Route 15",
  27: "Route 16",
  28: "Route 17",
  29: "Route 18",
  30: "Route 19",
  31: "Route 20",
  32: "Route 21",
  33: "Route 22",
  34: "Route 23",
  35: "Route 24",
  36: "Route 25",
  37: "Red's House 1F",
  38: "Red's House 2F",
  39: "Blue's House",
  40: "Oak's Lab",
  41: "Pokemon Center (generic)",
  42: "Viridian Pokemart",
  43: "Viridian School",
  44: "Viridian Gym",
  45: "Museum 1F",
  46: "Museum 2F",
  47: "Pewter Gym",
  48: "Pewter Pokemart",
  49: "Pewter House",
  50: "Cerulean House",
  51: "Cerulean Gym",
  52: "Cerulean Bike Shop",
  53: "Cerulean Pokemart",
  54: "Mt. Moon 1F",
  55: "Mt. Moon B1F",
  56: "Mt. Moon B2F",
  57: "Cerulean House 2",
  58: "Viridian Forest",
  59: "S.S. Anne 1F",
  60: "S.S. Anne 2F",
  61: "S.S. Anne B1F",
  62: "S.S. Anne Deck",
  63: "S.S. Anne Kitchen",
  64: "S.S. Anne Captain's Room",
  65: "Pokemon Fan Club",
  66: "Vermilion Pokemart",
  67: "Vermilion Gym",
  68: "Vermilion House 1",
  69: "Pokemon Tower 1F",
  70: "Pokemon Tower 2F",
  71: "Pokemon Tower 3F",
  72: "Pokemon Tower 4F",
  73: "Pokemon Tower 5F",
  74: "Pokemon Tower 6F",
  75: "Pokemon Tower 7F",
  76: "Celadon Mansion 1F",
  77: "Celadon Mansion 2F",
  78: "Celadon Mansion 3F",
  79: "Celadon Mansion Roof",
  80: "Celadon Mansion Roof House",
  81: "Celadon Pokemart 1F",
  82: "Celadon Pokemart 2F",
  83: "Celadon Pokemart 3F",
  84: "Celadon Pokemart 4F",
  85: "Celadon Pokemart Roof",
  86: "Celadon Pokemart Elevator",
  87: "Celadon Game Corner",
  88: "Celadon Game Corner Prize",
  89: "Celadon Diner",
  90: "Celadon House",
  91: "Celadon Hotel",
  92: "Lavender Pokemart",
  93: "Lavender House 1",
  94: "Lavender House 2",
  95: "Fuchsia Pokemart",
  96: "Fuchsia House 1",
  97: "Fuchsia House 2",
  98: "Safari Zone Entrance",
  99: "Fuchsia Gym",
  100: "Fuchsia Meeting Room",
  108: "Cinnabar Gym",
  109: "Cinnabar Lab",
  110: "Cinnabar Lab 1",
  111: "Cinnabar Lab 2",
  112: "Cinnabar Lab 3",
  113: "Cinnabar Pokemart",
  114: "Cinnabar Pokemon Center",
  115: "Indigo Plateau Lobby",
  116: "Copycat's House 1F",
  117: "Copycat's House 2F",
  118: "Fighting Dojo",
  119: "Saffron Gym",
  120: "Saffron House 1",
  121: "Saffron Pokemart",
  122: "Silph Co 1F",
  123: "Silph Co 2F",
  124: "Silph Co 3F",
  125: "Silph Co 4F",
  126: "Silph Co 5F",
  127: "Silph Co 6F",
  128: "Silph Co 7F",
  129: "Silph Co 8F",
  130: "Silph Co 9F",
  131: "Silph Co 10F",
  132: "Silph Co 11F",
  133: "Silph Co Elevator",
  134: "Saffron House 2",
  193: "Rock Tunnel 1F",
  194: "Rock Tunnel B1F",
  197: "Safari Zone East",
  198: "Safari Zone North",
  199: "Safari Zone West",
  200: "Safari Zone Center",
  201: "Safari Zone Rest House 1",
  213: "Victory Road 1F",
  214: "Victory Road 2F",
  215: "Victory Road 3F",
  216: "Lorelei's Room",
  217: "Bruno's Room",
  218: "Agatha's Room",
  219: "Lance's Room",
  220: "Champion's Room",
  221: "Hall of Fame",
  222: "Underground Path (N-S)",
  225: "Celadon Gym",
  226: "Unknown Dungeon 1F",
  227: "Unknown Dungeon 2F",
  228: "Unknown Dungeon B1F",
  229: "Power Plant",
  230: "Seafoam Islands 1F",
  231: "Seafoam Islands B1F",
  232: "Seafoam Islands B2F",
  233: "Seafoam Islands B3F",
  234: "Seafoam Islands B4F",
  235: "Pokemon Mansion 1F",
  236: "Pokemon Mansion 2F",
  237: "Pokemon Mansion 3F",
  238: "Pokemon Mansion B1F",
  239: "Diglett's Cave",
};
