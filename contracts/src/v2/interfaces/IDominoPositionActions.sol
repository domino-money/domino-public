// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IPermit2Signature} from "../external/IPermit2Signature.sol";

/// @notice Manual position management (#283, S1): create, increase, change
/// range and exit, each in one transaction, on Uniswap v3 or v4.
/// @dev Implemented by the stateless zap (positions in the owner's wallet).
/// The vault does not implement it in V2.0 (owner decision of 3 Oct 2026).
/// Rules every implementation enforces:
/// - the intent's action, pool, ticks, minimum liquidity, fee, routes hash,
///   recipient and deadline bind the plan; routesHash covers every swap leg;
/// - the assisted-swap fee is FEE_ASSISTED_SWAP_BPS of the swapped amount,
///   charged once per action in the token the charge-currency rule selects
///   (DominoFeeRules: the best-ranked charge currency anywhere in the route,
///   a tie going to the input, then the output, then a route hop; with none
///   in the route, the first leg's input), and the intent's feeToken must
///   equal that selection; no swap, no fee;
/// - a swap leg is accepted by its effect: exactly amountIn of tokenIn leaves,
///   at least minAmountOut of tokenOut arrives, no other balance moves and no
///   allowance survives the call;
/// - every unused input and every withdrawn amount goes to the recipient in
///   the same transaction; nothing is left in the contract.
interface IDominoPositionActions {
    error InvalidPlan();
    error PlanExpired();
    error FeeMismatch();
    error SwapEffectMismatch();
    error InsufficientLiquidity();
    error Unauthorized();

    /// intent.action = ACTION_CREATE, intent.tokenId = 0. Inputs are pulled
    /// from the caller (or the Permit2 signer); the NFT goes to intent.recipient.
    /// initSqrtPriceX96 != 0 initializes the pool only if it is uninitialized.
    struct CreatePlan {
        DominoV2Types.PositionIntent intent;
        DominoV2Types.TokenAmount[] inputs;
        DominoV2Types.SwapLeg[] legs;
        uint128 amount0Max;
        uint128 amount1Max;
        uint160 initSqrtPriceX96;
    }

    /// intent.action = ACTION_INCREASE on intent.tokenId.
    struct IncreasePlan {
        DominoV2Types.PositionIntent intent;
        DominoV2Types.TokenAmount[] inputs;
        DominoV2Types.SwapLeg[] legs;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    /// intent.action = ACTION_CHANGE_RANGE: remove liquidity from
    /// intent.tokenId, collect its fees, swap, mint the new range
    /// (intent.tickLower/tickUpper) to intent.recipient.
    struct ChangeRangePlan {
        DominoV2Types.PositionIntent intent;
        uint128 liquidityToRemove;
        uint128 amount0MinRemoved;
        uint128 amount1MinRemoved;
        DominoV2Types.SwapLeg[] legs;
        uint128 amount0Max;
        uint128 amount1Max;
        bool burnOld;
    }

    /// intent.action = ACTION_EXIT: remove liquidity, collect fees, optionally
    /// convert through legs, deliver to intent.recipient.
    struct ExitPlan {
        DominoV2Types.PositionIntent intent;
        uint128 liquidityToRemove;
        uint128 amount0MinRemoved;
        uint128 amount1MinRemoved;
        DominoV2Types.SwapLeg[] legs;
        bool burn;
    }

    struct ActionResult {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0;
        uint256 amount1;
        address feeToken;
        uint256 feeAmount;
    }

    event PositionActionExecuted(
        uint8 indexed action,
        address indexed recipient,
        uint256 indexed tokenId,
        uint256 previousTokenId,
        uint128 liquidity,
        bytes32 intentHash
    );
    event Refunded(address indexed recipient, address indexed token, uint256 amount);

    function domainSeparator() external view returns (bytes32);

    function create(CreatePlan calldata plan) external payable returns (ActionResult memory result);
    function createWithPermit(
        CreatePlan calldata plan,
        IPermit2Signature.PermitBatchTransferFrom calldata permit,
        bytes calldata signature
    ) external returns (ActionResult memory result);

    function increase(IncreasePlan calldata plan) external payable returns (ActionResult memory result);
    function increaseWithPermit(
        IncreasePlan calldata plan,
        IPermit2Signature.PermitBatchTransferFrom calldata permit,
        bytes calldata signature
    ) external returns (ActionResult memory result);

    function changeRange(ChangeRangePlan calldata plan) external returns (ActionResult memory result);
    function exit(ExitPlan calldata plan) external returns (ActionResult memory result);
}
