// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ZapJourney} from "./ZapJourney.sol";

contract ZapV3IntegrationTest is ZapJourney {
    function _dex() internal pure override returns (uint8) {
        return 3;
    }

    function _zapArtifact() internal pure override returns (string memory) {
        return "DominoZapV3.sol:DominoZapV3";
    }

    function _vaultArtifact() internal pure override returns (string memory) {
        return "DominoV2VaultV3.sol:DominoV2VaultV3";
    }

    function _executorArtifact() internal pure override returns (string memory) {
        return "DominoV2VaultV3.sol:DominoV2VaultExecutorV3";
    }
}
