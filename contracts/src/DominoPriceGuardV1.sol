// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoPriceGuardV4} from "./DominoPriceGuardV4.sol";

/// @notice Public Domino V1 deployment name for the unchanged technical V4 price guard.
contract DominoPriceGuardV1 is DominoPriceGuardV4 {
    constructor(address publisher_, address stateView_, uint256 maxDeviationBps_, address guardian_)
        DominoPriceGuardV4(publisher_, stateView_, maxDeviationBps_, guardian_) {}
}
