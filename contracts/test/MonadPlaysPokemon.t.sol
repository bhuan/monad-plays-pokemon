// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {MonadPlaysPokemon} from "../src/MonadPlaysPokemon.sol";

contract MonadPlaysPokemonTest is Test {
    MonadPlaysPokemon public monadPlaysPokemon;
    address public player1 = address(0x1);
    address public player2 = address(0x2);

    event VoteCast(address indexed player, MonadPlaysPokemon.Action action);

    function setUp() public {
        monadPlaysPokemon = new MonadPlaysPokemon();
    }

    function test_VoteEmitsEvent() public {
        vm.prank(player1);
        vm.expectEmit(true, false, false, true);
        emit VoteCast(player1, MonadPlaysPokemon.Action.UP);
        monadPlaysPokemon.vote(MonadPlaysPokemon.Action.UP);
    }

    function test_MultipleVotes() public {
        vm.prank(player1);
        vm.expectEmit(true, false, false, true);
        emit VoteCast(player1, MonadPlaysPokemon.Action.A);
        monadPlaysPokemon.vote(MonadPlaysPokemon.Action.A);

        vm.prank(player2);
        vm.expectEmit(true, false, false, true);
        emit VoteCast(player2, MonadPlaysPokemon.Action.B);
        monadPlaysPokemon.vote(MonadPlaysPokemon.Action.B);
    }

    function test_AllActions() public {
        MonadPlaysPokemon.Action[8] memory actions = [
            MonadPlaysPokemon.Action.UP,
            MonadPlaysPokemon.Action.DOWN,
            MonadPlaysPokemon.Action.LEFT,
            MonadPlaysPokemon.Action.RIGHT,
            MonadPlaysPokemon.Action.A,
            MonadPlaysPokemon.Action.B,
            MonadPlaysPokemon.Action.START,
            MonadPlaysPokemon.Action.SELECT
        ];

        for (uint8 i = 0; i < actions.length; i++) {
            vm.prank(player1);
            vm.expectEmit(true, false, false, true);
            emit VoteCast(player1, actions[i]);
            monadPlaysPokemon.vote(actions[i]);
        }
    }
}
