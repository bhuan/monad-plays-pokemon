// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title SimpleDelegation - Minimal EIP-7702 delegation contract
/// @notice Users' EOAs delegate to this contract to enable gasless transactions
/// @dev When an EOA delegates to this contract via EIP-7702, the EOA can execute
///      calls by having a relayer submit transactions on their behalf.
///      The relayer pays gas, but msg.sender to target contracts is the user's EOA.
contract SimpleDelegation {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    /// @notice Nonce for each delegated EOA to prevent replay attacks
    mapping(address => uint256) public nonces;

    /// @notice Emitted when a call is executed
    event Executed(address indexed owner, address indexed to, uint256 value, bytes data);

    /// @notice Error when signature is invalid
    error InvalidSignature();

    /// @notice Error when nonce doesn't match
    error InvalidNonce();

    /// @notice Execute a call on behalf of the delegated EOA
    /// @dev The caller (relayer) pays gas. The EOA owner must sign the call parameters.
    ///      When called on a delegated EOA, address(this) is the EOA's address.
    /// @param to Target contract address
    /// @param value ETH value to send (usually 0 for vote calls)
    /// @param data Calldata for the target contract
    /// @param deadline Timestamp after which the signature expires
    /// @param signature ECDSA signature from the EOA owner
    function execute(
        address to,
        uint256 value,
        bytes calldata data,
        uint256 deadline,
        bytes calldata signature
    ) external payable returns (bytes memory) {
        // The owner is the EOA that delegated to this contract
        // When called via EIP-7702 delegation, address(this) == the EOA
        address owner = address(this);

        // Check deadline
        require(block.timestamp <= deadline, "Signature expired");

        // Get current nonce
        uint256 nonce = nonces[owner];

        // Build the message hash that the owner should have signed
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                owner,      // The delegated EOA
                to,         // Target contract
                value,      // ETH value
                data,       // Calldata
                nonce,      // Replay protection
                deadline,   // Expiry
                block.chainid // Chain ID for cross-chain replay protection
            )
        );

        // Convert to EIP-191 signed message hash
        bytes32 ethSignedMessageHash = messageHash.toEthSignedMessageHash();

        // Recover signer from signature
        address signer = ethSignedMessageHash.recover(signature);

        // Verify the signer is the EOA owner
        if (signer != owner) revert InvalidSignature();

        // Increment nonce to prevent replay
        nonces[owner] = nonce + 1;

        // Execute the call
        // msg.sender to the target contract will be address(this) == the EOA
        (bool success, bytes memory result) = to.call{value: value}(data);
        if (!success) {
            // Bubble up the revert reason from the target contract
            assembly {
                revert(add(result, 0x20), mload(result))
            }
        }

        emit Executed(owner, to, value, data);

        return result;
    }

    /// @notice Get the current nonce for a delegated EOA
    /// @param owner The EOA address
    /// @return The current nonce
    function getNonce(address owner) external view returns (uint256) {
        return nonces[owner];
    }

    /// @notice Compute the message hash that needs to be signed
    /// @dev Helper function for off-chain signature generation
    /// @param owner The delegated EOA address
    /// @param to Target contract address
    /// @param value ETH value
    /// @param data Calldata
    /// @param nonce Current nonce
    /// @param deadline Signature expiry timestamp
    /// @return The message hash (before EIP-191 prefix)
    function getMessageHash(
        address owner,
        address to,
        uint256 value,
        bytes calldata data,
        uint256 nonce,
        uint256 deadline
    ) external view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                owner,
                to,
                value,
                data,
                nonce,
                deadline,
                block.chainid
            )
        );
    }

    /// @notice Allow receiving ETH (for EOAs that might receive funds)
    receive() external payable {}
}
