// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultV4} from "./DominoVaultV4.sol";

/// @notice Public Domino V1 deployment name; implementationVersion remains 4.
contract DominoVaultV1 is DominoVaultV4 {
    constructor(
        address factory_,
        address poolManager_,
        address positionManager_,
        address stateView_,
        address feeRecipient_,
        address readHelper_,
        address engine_
    ) DominoVaultV4(factory_, poolManager_, positionManager_, stateView_, feeRecipient_, readHelper_, engine_) {}
}
