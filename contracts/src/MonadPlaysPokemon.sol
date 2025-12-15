// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MonadPlaysPokemon - Decentralized Twitch Plays Pokemon on Monad
/// @notice Gas-minimized contract that emits vote events without storage writes
contract MonadPlaysPokemon {
    /// @notice GameBoy input actions
    enum Action {
        UP,
        DOWN,
        LEFT,
        RIGHT,
        A,
        B,
        START,
        SELECT
    }

    /// @notice Emitted when a player casts a vote
    /// @param player The address of the voter
    /// @param action The action they voted for
    event VoteCast(address indexed player, Action action);

    /// @notice Cast a vote for a game action
    /// @param _action The action to vote for
    function vote(Action _action) external {
        emit VoteCast(msg.sender, _action);
    }
}
