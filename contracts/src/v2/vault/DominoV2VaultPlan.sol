// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";

/// @notice The operator's execution plan for IDominoVaultExecution.execute.
/// @dev Wire format: one version byte, then the ABI encoding of the version's
/// struct. Version 1 is `0x01 ‖ abi.encode(PlanV1)`. A new version gets a new
/// byte and a new struct; a vault rejects every byte it does not know. The
/// field-by-field rules are in docs/v2/F3_VAULT.md.
library DominoV2VaultPlan {
    error InvalidPlan();

    uint8 internal constant VERSION_1 = 1;

    /// Increase an existing member (the root or a successor).
    uint8 internal constant ACTION_COMPOUND = 1;
    /// Mint a new successor of `target` (Domino-compound only).
    uint8 internal constant ACTION_MINT = 2;

    /// A member whose fee balances may fund this execution, with the most the
    /// execution may debit from it per pool token, the tariff included.
    struct Budget {
        uint256 tokenId;
        uint128 max0;
        uint128 max1;
    }

    /// One swap direction, funded by one source and credited back to it.
    /// No swap is the all-zero value with no legs.
    struct Swap {
        uint256 source;
        bool zeroForOne;
        uint128 amountIn;
        uint128 minAmountOut;
        DominoV2Types.SwapLeg[] legs;
    }

    struct PlanV1 {
        uint8 action;
        uint64 stateNonce;
        uint64 deadline;
        uint256 target;
        int24 tickLower;
        int24 tickUpper;
        uint128 amount0Max;
        uint128 amount1Max;
        uint128 minLiquidity;
        uint256[] collect;
        Budget[] budgets;
        Swap swap;
        bytes anchorEvidence;
    }

    function decode(bytes calldata plan) internal pure returns (PlanV1 memory decoded) {
        if (plan.length == 0 || uint8(plan[0]) != VERSION_1) revert InvalidPlan();
        decoded = abi.decode(plan[1:], (PlanV1));
    }

    function encode(PlanV1 memory plan) internal pure returns (bytes memory) {
        return bytes.concat(bytes1(VERSION_1), abi.encode(plan));
    }
}
