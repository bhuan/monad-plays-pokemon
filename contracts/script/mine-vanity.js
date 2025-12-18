#!/usr/bin/env node
// Mine for a CREATE2 vanity address off-chain

const { keccak256, encodePacked, toHex, toBytes } = require("viem");
const { execSync } = require("child_process");

// Configuration
const VANITY_PREFIX = process.env.VANITY_PREFIX || "PLAY"; // e.g., "DEAD", "CAFE", "PLAY"
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS || "10000000");
const DEPLOYER_ADDRESS = process.env.DEPLOYER_ADDRESS || "0xD177041D04e77CF1e0918257D65A670c7C214B6C";

// Get bytecode from forge
console.log("Compiling contract...");
execSync("cd /home/bhuan/git/monad-plays-pokemon/contracts && forge build", { stdio: "inherit" });

// Read bytecode from artifacts
const fs = require("fs");
const artifact = JSON.parse(
  fs.readFileSync("/home/bhuan/git/monad-plays-pokemon/contracts/out/MonadPlaysPokemon.sol/MonadPlaysPokemon.json", "utf8")
);
const bytecode = artifact.bytecode.object;
const bytecodeHash = keccak256(bytecode);

console.log("Bytecode hash:", bytecodeHash);
console.log("Deployer:", DEPLOYER_ADDRESS);
console.log("Looking for prefix:", VANITY_PREFIX);
console.log("Max attempts:", MAX_ATTEMPTS);
console.log("");

// CREATE2 address calculation:
// keccak256(0xff ++ deployer ++ salt ++ keccak256(bytecode))[12:]
function computeCreate2Address(deployer, salt, bytecodeHash) {
  const data = encodePacked(
    ["bytes1", "address", "bytes32", "bytes32"],
    ["0xff", deployer, salt, bytecodeHash]
  );
  const hash = keccak256(data);
  return "0x" + hash.slice(26); // Take last 20 bytes
}

// Check if address matches vanity prefix (case insensitive)
function matchesPrefix(address, prefix) {
  return address.slice(2, 2 + prefix.length).toLowerCase() === prefix.toLowerCase();
}

// Mine for vanity address
let found = false;
let salt;
let address;

const startTime = Date.now();
let lastReport = startTime;

for (let i = 0n; i < BigInt(MAX_ATTEMPTS); i++) {
  salt = toHex(i, { size: 32 });
  address = computeCreate2Address(DEPLOYER_ADDRESS, salt, bytecodeHash);

  if (matchesPrefix(address, VANITY_PREFIX)) {
    found = true;
    console.log("\n=== FOUND! ===");
    console.log("Salt:", salt);
    console.log("Salt (decimal):", i.toString());
    console.log("Address:", address);
    break;
  }

  // Progress report every 5 seconds
  const now = Date.now();
  if (now - lastReport > 5000) {
    const elapsed = (now - startTime) / 1000;
    const rate = Number(i) / elapsed;
    console.log(`Checked ${i} salts... (${rate.toFixed(0)}/s)`);
    lastReport = now;
  }
}

if (!found) {
  console.log("\nNo vanity address found within", MAX_ATTEMPTS, "attempts");
  console.log("Try increasing MAX_ATTEMPTS or using a shorter prefix");

  // Still output salt 0 address
  salt = toHex(0n, { size: 32 });
  address = computeCreate2Address(DEPLOYER_ADDRESS, salt, bytecodeHash);
  console.log("\nUsing salt 0:");
  console.log("Salt:", salt);
  console.log("Address:", address);
}

// Output for use in deployment
console.log("\n=== For deployment ===");
console.log(`export SALT=${salt}`);
console.log(`export PREDICTED_ADDRESS=${address}`);
