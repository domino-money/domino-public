// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultFactoryV4} from "./DominoVaultFactoryV4.sol";

/// @notice Public Domino V1 deployment name for the unchanged technical V4 factory.
contract DominoVaultFactoryV1 is DominoVaultFactoryV4 {
    constructor(address poolManager_, address positionManager_, address stateView_, address serviceFeeRecipient_)
        DominoVaultFactoryV4(poolManager_, positionManager_, stateView_, serviceFeeRecipient_) {}
}
