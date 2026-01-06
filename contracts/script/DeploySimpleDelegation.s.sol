// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {SimpleDelegation} from "../src/SimpleDelegation.sol";

contract DeploySimpleDelegation is Script {
    function run() external returns (SimpleDelegation) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        SimpleDelegation delegation = new SimpleDelegation();

        vm.stopBroadcast();

        return delegation;
    }
}
