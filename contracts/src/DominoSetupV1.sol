// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoSetup} from "./DominoSetup.sol";

/// @notice Public Domino V1 deployment name for the unchanged Setup implementation.
contract DominoSetupV1 is DominoSetup {
    constructor(address manager_, address positions_, address view_, address recipient_, uint16 feeBps_, uint64 version_)
        DominoSetup(manager_, positions_, view_, recipient_, feeBps_, version_) {}
}
