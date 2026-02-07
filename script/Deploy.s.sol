// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Script, console } from "forge-std/Script.sol";
import { ReputationToken } from "../src/ReputationToken.sol";
import { MentionQuest } from "../src/MentionQuest.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address oracle = vm.envOr("ORACLE_ADDRESS", deployer);

        console.log("Deploying MentionFi to MegaETH...");
        console.log("Deployer:", deployer);
        console.log("Oracle:", oracle);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy ReputationToken
        ReputationToken repToken = new ReputationToken();
        console.log("ReputationToken deployed:", address(repToken));

        // Deploy MentionQuest
        MentionQuest quest = new MentionQuest(address(repToken));
        console.log("MentionQuest deployed:", address(quest));

        // Configure
        repToken.setMinter(address(quest), true);
        console.log("MentionQuest authorized as minter");

        quest.setOracle(oracle, true);
        console.log("Oracle authorized:", oracle);

        vm.stopBroadcast();

        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("ReputationToken:", address(repToken));
        console.log("MentionQuest:", address(quest));
        console.log("");
        console.log("Next steps:");
        console.log("1. Agents call repToken.register() to get initial reputation");
        console.log("2. Create quests via quest.createQuest()");
        console.log("3. Oracle resolves via quest.resolveQuest()");
    }
}
