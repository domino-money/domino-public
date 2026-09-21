// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultReadHelper} from "./DominoVaultReadHelper.sol";

/// @notice Public Domino V1 deployment name for the unchanged read helper.
contract DominoVaultReadHelperV1 is DominoVaultReadHelper {
    constructor(address positionManager_, address stateView_)
        DominoVaultReadHelper(positionManager_, stateView_) {}
}
