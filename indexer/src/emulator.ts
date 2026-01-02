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

      // Party Pokemon data
      // Each Pokemon struct is 44 (0x2C) bytes starting at 0xD16B
      // Current HP at offset 0x01 (2 bytes big-endian)
      // Level at offset 0x21 (1 byte)
      // Max HP at offset 0x22 (2 bytes big-endian)
      const PARTY_DATA_START = 0xD16B;
      const POKEMON_STRUCT_SIZE = 0x2C;
      const partyHp: { current: number; max: number }[] = [];
      const partyLevels: number[] = [];
      for (let i = 0; i < partyCount; i++) {
        const baseAddr = PARTY_DATA_START + (i * POKEMON_STRUCT_SIZE);
        const currentHp = ((memory[baseAddr + 0x01] || 0) << 8) | (memory[baseAddr + 0x02] || 0);
        const level = memory[baseAddr + 0x21] || 0;
        const maxHp = ((memory[baseAddr + 0x22] || 0) << 8) | (memory[baseAddr + 0x23] || 0);
        partyHp.push({ current: currentHp, max: maxHp });
        partyLevels.push(level);
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
        partyLevels,
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
  partyLevels: number[]; // Level of each party Pokemon
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
  // Towns and Cities
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
  // Routes
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
  // Pallet Town
  37: "Red's House 1F",
  38: "Red's House 2F",
  39: "Blue's House",
  40: "Oak's Lab",
  // Viridian City
  41: "Viridian Pokemon Center",
  42: "Viridian Pokemart",
  43: "Viridian School",
  44: "Viridian Nickname House",
  45: "Viridian Gym",
  46: "Diglett's Cave (Route 2)",
  47: "Viridian Forest North Gate",
  48: "Route 2 Trade House",
  49: "Route 2 Gate",
  50: "Viridian Forest South Gate",
  51: "Viridian Forest",
  // Pewter City
  52: "Pewter Museum 1F",
  53: "Pewter Museum 2F",
  54: "Pewter Gym",
  55: "Pewter Nidoran House",
  56: "Pewter Pokemart",
  57: "Pewter Speech House",
  58: "Pewter Pokemon Center",
  // Mt. Moon
  59: "Mt. Moon 1F",
  60: "Mt. Moon B1F",
  61: "Mt. Moon B2F",
  // Cerulean City
  62: "Cerulean Trashed House",
  63: "Cerulean Trade House",
  64: "Cerulean Pokemon Center",
  65: "Cerulean Gym",
  66: "Bike Shop",
  67: "Cerulean Pokemart",
  68: "Mt. Moon Pokemon Center",
  // Route 5-8 Gates
  70: "Route 5 Gate",
  71: "Underground Path (Route 5)",
  72: "Daycare",
  73: "Route 6 Gate",
  74: "Underground Path (Route 6)",
  76: "Route 7 Gate",
  77: "Underground Path (Route 7)",
  79: "Route 8 Gate",
  80: "Underground Path (Route 8)",
  // Rock Tunnel area
  81: "Rock Tunnel Pokemon Center",
  82: "Rock Tunnel 1F",
  83: "Power Plant",
  84: "Route 11 Gate 1F",
  85: "Diglett's Cave (Route 11)",
  86: "Route 11 Gate 2F",
  87: "Route 12 Gate 1F",
  88: "Bill's House",
  // Vermilion City
  89: "Vermilion Pokemon Center",
  90: "Pokemon Fan Club",
  91: "Vermilion Pokemart",
  92: "Vermilion Gym",
  93: "Vermilion Pidgey House",
  94: "Vermilion Dock",
  // S.S. Anne
  95: "S.S. Anne 1F",
  96: "S.S. Anne 2F",
  97: "S.S. Anne 3F",
  98: "S.S. Anne B1F",
  99: "S.S. Anne Bow",
  100: "S.S. Anne Kitchen",
  101: "S.S. Anne Captain's Room",
  102: "S.S. Anne 1F Rooms",
  103: "S.S. Anne 2F Rooms",
  104: "S.S. Anne B1F Rooms",
  // Victory Road
  108: "Victory Road 1F",
  113: "Lance's Room",
  118: "Hall of Fame",
  119: "Underground Path (N-S)",
  120: "Champion's Room",
  121: "Underground Path (W-E)",
  // Celadon City
  122: "Celadon Dept Store 1F",
  123: "Celadon Dept Store 2F",
  124: "Celadon Dept Store 3F",
  125: "Celadon Dept Store 4F",
  126: "Celadon Dept Store Roof",
  127: "Celadon Dept Store Elevator",
  128: "Celadon Mansion 1F",
  129: "Celadon Mansion 2F",
  130: "Celadon Mansion 3F",
  131: "Celadon Mansion Roof",
  132: "Celadon Mansion Roof House",
  133: "Celadon Pokemon Center",
  134: "Celadon Gym",
  135: "Game Corner",
  136: "Celadon Dept Store 5F",
  137: "Game Corner Prize Room",
  138: "Celadon Diner",
  139: "Celadon Chief House",
  140: "Celadon Hotel",
  // Lavender Town
  141: "Lavender Pokemon Center",
  142: "Pokemon Tower 1F",
  143: "Pokemon Tower 2F",
  144: "Pokemon Tower 3F",
  145: "Pokemon Tower 4F",
  146: "Pokemon Tower 5F",
  147: "Pokemon Tower 6F",
  148: "Pokemon Tower 7F",
  149: "Mr. Fuji's House",
  150: "Lavender Pokemart",
  151: "Lavender Cubone House",
  // Fuchsia City
  152: "Fuchsia Pokemart",
  153: "Fuchsia Bill's Grandpa House",
  154: "Fuchsia Pokemon Center",
  155: "Warden's House",
  156: "Safari Zone Gate",
  157: "Fuchsia Gym",
  158: "Fuchsia Meeting Room",
  // Seafoam Islands
  159: "Seafoam Islands B1F",
  160: "Seafoam Islands B2F",
  161: "Seafoam Islands B3F",
  162: "Seafoam Islands B4F",
  163: "Vermilion Old Rod House",
  164: "Fuchsia Good Rod House",
  // Cinnabar Island
  165: "Pokemon Mansion 1F",
  166: "Cinnabar Gym",
  167: "Cinnabar Lab",
  168: "Cinnabar Lab Trade Room",
  169: "Cinnabar Lab Metronome Room",
  170: "Cinnabar Lab Fossil Room",
  171: "Cinnabar Pokemon Center",
  172: "Cinnabar Pokemart",
  // Indigo Plateau / Saffron
  174: "Indigo Plateau Lobby",
  175: "Copycat's House 1F",
  176: "Copycat's House 2F",
  177: "Fighting Dojo",
  178: "Saffron Gym",
  179: "Saffron Pidgey House",
  180: "Saffron Pokemart",
  181: "Silph Co 1F",
  182: "Saffron Pokemon Center",
  183: "Mr. Psychic's House",
  // Route Gates
  184: "Route 15 Gate 1F",
  185: "Route 15 Gate 2F",
  186: "Route 16 Gate 1F",
  187: "Route 16 Gate 2F",
  188: "Route 16 Fly House",
  189: "Route 12 Super Rod House",
  190: "Route 18 Gate 1F",
  191: "Route 18 Gate 2F",
  192: "Seafoam Islands 1F",
  193: "Route 22 Gate",
  194: "Victory Road 2F",
  195: "Route 12 Gate 2F",
  196: "Vermilion Trade House",
  197: "Diglett's Cave",
  198: "Victory Road 3F",
  // Rocket Hideout
  199: "Rocket Hideout B1F",
  200: "Rocket Hideout B2F",
  201: "Rocket Hideout B3F",
  202: "Rocket Hideout B4F",
  203: "Rocket Hideout Elevator",
  // Silph Co
  207: "Silph Co 2F",
  208: "Silph Co 3F",
  209: "Silph Co 4F",
  210: "Silph Co 5F",
  211: "Silph Co 6F",
  212: "Silph Co 7F",
  213: "Silph Co 8F",
  // Pokemon Mansion
  214: "Pokemon Mansion 2F",
  215: "Pokemon Mansion 3F",
  216: "Pokemon Mansion B1F",
  // Safari Zone
  217: "Safari Zone East",
  218: "Safari Zone North",
  219: "Safari Zone West",
  220: "Safari Zone Center",
  221: "Safari Zone Center Rest House",
  222: "Safari Zone Secret House",
  223: "Safari Zone West Rest House",
  224: "Safari Zone East Rest House",
  225: "Safari Zone North Rest House",
  // Cerulean Cave
  226: "Cerulean Cave 2F",
  227: "Cerulean Cave B1F",
  228: "Cerulean Cave 1F",
  229: "Name Rater's House",
  230: "Cerulean Badge House",
  // Rock Tunnel B1F
  232: "Rock Tunnel B1F",
  // More Silph Co
  233: "Silph Co 9F",
  234: "Silph Co 10F",
  235: "Silph Co 11F",
  236: "Silph Co Elevator",
  // Trade/Battle
  239: "Trade Center",
  240: "Colosseum",
  // Elite Four
  245: "Lorelei's Room",
  246: "Bruno's Room",
  247: "Agatha's Room",
};
