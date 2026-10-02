// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";

/// The plan encoding F6 builds and the vault decodes, pinned to a golden
/// computed independently with eth_abi 5.2.0 (`0x01 ‖ encode([PlanV1], [plan])`,
/// type string in docs/v2/F3_VAULT.md).
contract DominoV2VaultPlanTest {
    bytes32 internal constant GOLDEN = 0x890394e7f13c2a4a3f22faf01049af9cfb5c3ecfe20f8b72ba6df3d5aabdaff6;
    uint256 internal constant GOLDEN_LENGTH = 1313;

    error Mismatch(string what);

    function _golden() internal pure returns (Plan.PlanV1 memory p) {
        p.action = Plan.ACTION_MINT;
        p.stateNonce = 7;
        p.deadline = 1790871000;
        p.target = 1234;
        p.tickLower = 5400;
        p.tickUpper = 10080;
        p.amount0Max = type(uint128).max;
        p.amount1Max = 5000;
        p.minLiquidity = 1;
        p.collect = new uint256[](1);
        p.collect[0] = 1234;
        p.budgets = new Plan.Budget[](2);
        p.budgets[0] = Plan.Budget(1234, 1000, 2000);
        p.budgets[1] = Plan.Budget(5678, 3, 4);
        p.swap.source = 1234;
        p.swap.zeroForOne = true;
        p.swap.amountIn = 970;
        p.swap.minAmountOut = 957;
        p.swap.legs = new DominoV2Types.SwapLeg[](1);
        p.swap.legs[0] = DominoV2Types.SwapLeg(
            1,
            0x00000000000000000000000000000000000000AA,
            0x1111111111111111111111111111111111111111,
            0x2222222222222222222222222222222222222222,
            970,
            957,
            hex"deadbeef"
        );
        p.anchorEvidence = hex"a0b1";
    }

    function decode(bytes calldata raw) external pure returns (Plan.PlanV1 memory) {
        return Plan.decode(raw);
    }

    function testEncodingMatchesTheGolden() public pure {
        bytes memory raw = Plan.encode(_golden());
        if (raw.length != GOLDEN_LENGTH || keccak256(raw) != GOLDEN) revert Mismatch("golden");
        if (uint8(raw[0]) != Plan.VERSION_1) revert Mismatch("version byte");
    }

    function testDecodingRoundTrips() public view {
        bytes memory raw = Plan.encode(_golden());
        Plan.PlanV1 memory p = this.decode(raw);
        if (keccak256(abi.encode(p)) != keccak256(abi.encode(_golden()))) revert Mismatch("round trip");
    }
}
