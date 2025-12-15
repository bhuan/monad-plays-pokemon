// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {MonadPlaysPokemon} from "../src/MonadPlaysPokemon.sol";

contract MonadPlaysPokemonScript is Script {
    function run() public {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        MonadPlaysPokemon monadPlaysPokemon = new MonadPlaysPokemon();

        console.log("MonadPlaysPokemon deployed at:", address(monadPlaysPokemon));

        vm.stopBroadcast();
    }
}
