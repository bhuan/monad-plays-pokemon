// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {MonadPlaysPokemon} from "../src/MonadPlaysPokemon.sol";

/// @notice CREATE2 factory for deterministic deployments
contract Create2Factory {
    event Deployed(address addr, bytes32 salt);

    function deploy(bytes32 salt, bytes memory bytecode) external returns (address addr) {
        assembly {
            addr := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
            if iszero(extcodesize(addr)) {
                revert(0, 0)
            }
        }
        emit Deployed(addr, salt);
    }

    function computeAddress(bytes32 salt, bytes32 bytecodeHash) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            address(this),
            salt,
            bytecodeHash
        )))));
    }
}

contract DeployCreate2Script is Script {
    // Deterministic deployment proxy (deployed on most chains at this address)
    // If not available, we'll deploy our own factory first
    address constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() public {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        // Get desired vanity prefix (e.g., "DEAD", "CAFE", "1337", "PLAY")
        string memory vanityPrefix = vm.envOr("VANITY_PREFIX", string("DEAD"));
        uint256 maxAttempts = vm.envOr("MAX_ATTEMPTS", uint256(1000000));

        vm.startBroadcast(deployerPrivateKey);

        // Get the bytecode of MonadPlaysPokemon
        bytes memory bytecode = type(MonadPlaysPokemon).creationCode;
        bytes32 bytecodeHash = keccak256(bytecode);

        console.log("Bytecode hash:", vm.toString(bytecodeHash));
        console.log("Looking for vanity prefix:", vanityPrefix);

        // First, check if deterministic deployer exists
        address factory;
        if (DETERMINISTIC_DEPLOYER.code.length > 0) {
            factory = DETERMINISTIC_DEPLOYER;
            console.log("Using existing deterministic deployer at:", factory);
        } else {
            // Deploy our own CREATE2 factory
            Create2Factory newFactory = new Create2Factory();
            factory = address(newFactory);
            console.log("Deployed CREATE2 factory at:", factory);
        }

        // Mine for vanity address
        bytes32 salt;
        address predictedAddress;
        bool found = false;

        bytes memory vanityBytes = bytes(vanityPrefix);

        for (uint256 i = 0; i < maxAttempts; i++) {
            salt = bytes32(i);

            // Compute CREATE2 address
            predictedAddress = address(uint160(uint256(keccak256(abi.encodePacked(
                bytes1(0xff),
                factory,
                salt,
                bytecodeHash
            )))));

            // Check if it matches vanity prefix (after 0x)
            if (matchesVanity(predictedAddress, vanityBytes)) {
                found = true;
                console.log("Found vanity address after", i, "attempts!");
                break;
            }

            if (i % 100000 == 0 && i > 0) {
                console.log("Searched", i, "salts...");
            }
        }

        if (!found) {
            console.log("No vanity address found within", maxAttempts, "attempts");
            console.log("Using salt 0, address:", predictedAddress);
            salt = bytes32(0);
            predictedAddress = address(uint160(uint256(keccak256(abi.encodePacked(
                bytes1(0xff),
                factory,
                salt,
                bytecodeHash
            )))));
        }

        console.log("Salt:", vm.toString(salt));
        console.log("Predicted address:", predictedAddress);

        // Deploy via deterministic deployer (it expects salt || bytecode)
        if (factory == DETERMINISTIC_DEPLOYER) {
            // Deterministic deployer expects: salt ++ initcode
            bytes memory payload = abi.encodePacked(salt, bytecode);
            (bool success, bytes memory result) = factory.call(payload);
            require(success, "Deployment failed");

            address deployed;
            assembly {
                deployed := mload(add(result, 20))
            }
            // For deterministic deployer, the returned address might be different format
            // Just verify deployment
            require(predictedAddress.code.length > 0, "Contract not deployed at expected address");
            console.log("MonadPlaysPokemon deployed at:", predictedAddress);
        } else {
            // Use our factory
            Create2Factory(factory).deploy(salt, bytecode);
            console.log("MonadPlaysPokemon deployed at:", predictedAddress);
        }

        vm.stopBroadcast();
    }

    function matchesVanity(address addr, bytes memory prefix) internal pure returns (bool) {
        bytes memory addrHex = addressToHexBytes(addr);

        for (uint i = 0; i < prefix.length; i++) {
            // Case-insensitive comparison
            bytes1 a = prefix[i];
            bytes1 b = addrHex[i];

            // Convert to lowercase for comparison
            if (a >= 0x41 && a <= 0x5A) a = bytes1(uint8(a) + 32);
            if (b >= 0x41 && b <= 0x5A) b = bytes1(uint8(b) + 32);

            if (a != b) return false;
        }
        return true;
    }

    function addressToHexBytes(address addr) internal pure returns (bytes memory) {
        bytes memory result = new bytes(40);
        bytes memory hexChars = "0123456789abcdef";

        uint160 value = uint160(addr);
        for (uint i = 0; i < 20; i++) {
            uint8 b = uint8(value >> (8 * (19 - i)));
            result[i * 2] = hexChars[b >> 4];
            result[i * 2 + 1] = hexChars[b & 0x0f];
        }
        return result;
    }
}
