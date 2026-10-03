// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AutoExitJourney} from "./AutoExitJourney.sol";

contract AutoExitV4IntegrationTest is AutoExitJourney {
    function _dex() internal pure override returns (uint8) {
        return 4;
    }

    function _zapArtifact() internal pure override returns (string memory) {
        return "DominoZapV4.sol:DominoZapV4";
    }

    function _vaultArtifact() internal pure override returns (string memory) {
        return "DominoV2VaultV4.sol:DominoV2VaultV4";
    }

    function _executorArtifact() internal pure override returns (string memory) {
        return "DominoV2VaultV4.sol:DominoV2VaultExecutorV4";
    }
}
