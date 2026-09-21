// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoExecutionEngineV4} from "./DominoExecutionEngineV4.sol";

/// @notice Public Domino V1 deployment name for the unchanged technical V4 execution engine.
contract DominoExecutionEngineV1 is DominoExecutionEngineV4 {
    constructor(address factory_, address readHelper_, address routingHelper_, address priceGuard_)
        DominoExecutionEngineV4(factory_, readHelper_, routingHelper_, priceGuard_) {}
}
