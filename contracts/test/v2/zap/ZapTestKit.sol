// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2RelayTypes} from "../../../src/v2/DominoV2RelayTypes.sol";
import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IPermit2Signature} from "../../../src/v2/external/IPermit2Signature.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";

/// @notice The Foundry cheatcodes the F2 suites use (no forge-std here).
interface ZapVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function deal(address account, uint256 balance) external;
    function etch(address target, bytes calldata code) external;
    function store(address target, bytes32 slot, bytes32 value) external;
    function load(address target, bytes32 slot) external view returns (bytes32);
    function warp(uint256 timestamp) external;
    function chainId(uint256 id) external;
    function getCode(string calldata artifact) external view returns (bytes memory);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
    function expectRevert() external;
    function expectRevert(bytes calldata data) external;
    function expectRevert(bytes4 selector) external;
    function expectPartialRevert(bytes4 selector) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function snapshotState() external returns (uint256);
    function revertToState(uint256 id) external returns (bool);
}

/// Permit2's views and nonce invalidation the suites call.
interface IPermit2Views {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function invalidateUnorderedNonces(uint256 wordPos, uint256 mask) external;
    function nonceBitmap(address owner, uint256 wordPos) external view returns (uint256);
    function allowance(address user, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

/// The zap surface the suites drive: IDominoPositionActions, IDominoZap and the fee ledger.
interface IZap is IDominoPositionActions {
    function changeRangeWithSignature(ChangeRangePlan calldata plan, bytes calldata signature)
        external
        returns (ActionResult memory);
    function exitWithSignature(ExitPlan calldata plan, bytes calldata signature) external returns (ActionResult memory);
    function nonceBitmap(address owner, uint256 word) external view returns (uint256);
    function invalidateNonces(uint256 word, uint256 mask) external;
    function positionManager() external view returns (address);
    function hookedPoolsAllowed() external view returns (bool);
    function owedFees(address token) external view returns (uint256);
    function flushOwedFees(address token) external returns (uint256);
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// ERC721 calls on either position manager.
interface IPositionNft {
    function ownerOf(uint256 id) external view returns (address);
    function approve(address spender, uint256 id) external;
    function setApprovalForAll(address operator, bool approved) external;
    function getApproved(uint256 id) external view returns (address);
    function transferFrom(address from, address to, uint256 id) external;
}

/// @notice Shared helpers of the F2 suites: assertions, signing, plan
/// builders and the Permit2 runtime.
abstract contract ZapTestBase {
    ZapVm internal constant vm = ZapVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant ETH = address(0);
    address internal constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;
    uint160 internal constant PRICE_ONE = uint160(1 << 96);
    /// The suites' clock and chain; restored by constant because via-IR may
    /// re-read block.timestamp/block.chainid after a vm.warp/vm.chainId.
    uint256 internal constant NOW = 1_790_000_000;
    uint256 internal constant CHAIN = 31337;
    uint64 internal constant DEADLINE = 1_790_003_600;

    bytes32 internal constant FEE_CHARGED = keccak256("FeeCharged(uint8,address,address,uint256,bytes32)");
    bytes32 internal constant FEE_DEFERRED = keccak256("FeeDeferred(address,uint256,uint256)");
    bytes32 internal constant REFUNDED = keccak256("Refunded(address,address,uint256)");
    bytes32 internal constant INPUT_PULLED = keccak256("InputPulled(bytes32,address,address,uint256)");
    bytes32 internal constant ACTION_EXECUTED =
        keccak256("PositionActionExecuted(uint8,address,uint256,uint256,uint128,bytes32)");
    bytes32 internal constant LIQUIDITY_CHANGED = keccak256(
        "PositionLiquidityChanged(bytes32,address,uint256,(uint8,address,address,uint24,int24,address),int256,int256,int256)"
    );
    bytes32 internal constant LEG_EXECUTED = keccak256("SwapLegExecuted(uint8,address,address,address,uint256,uint256)");
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    error Unexpected(string what);
    error Mismatch(string what, uint256 actual, uint256 expected);

    // ------------------------------------------------------------ asserts

    function _check(bool condition, string memory what) internal pure {
        if (!condition) revert Unexpected(what);
    }

    function _eq(uint256 actual, uint256 expected, string memory what) internal pure {
        if (actual != expected) revert Mismatch(what, actual, expected);
    }

    function _balance(address token, address account) internal view returns (uint256) {
        if (token == ETH) return account.balance;
        (bool ok, bytes memory out) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", account));
        _check(ok && out.length == 32, "balanceOf");
        return abi.decode(out, (uint256));
    }

    function _allowance(address token, address owner, address spender) internal view returns (uint256) {
        (bool ok, bytes memory out) =
            token.staticcall(abi.encodeWithSignature("allowance(address,address)", owner, spender));
        _check(ok && out.length == 32, "allowance");
        return abi.decode(out, (uint256));
    }

    /// The number of recorded logs from `emitter` with topic0 `signature`.
    function _count(ZapVm.Log[] memory logs, address emitter, bytes32 signature) internal pure returns (uint256 found) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == signature) ++found;
        }
    }

    function _first(ZapVm.Log[] memory logs, address emitter, bytes32 signature)
        internal
        pure
        returns (ZapVm.Log memory)
    {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == signature) {
                return logs[i];
            }
        }
        revert Unexpected("log not found");
    }

    /// Prints a measured gas figure with forge's console (visible with -vv).
    function _logGas(string memory what, uint256 gas) internal view {
        (bool ok,) = CONSOLE.staticcall(abi.encodeWithSignature("log(string,uint256)", what, gas));
        ok;
    }

    function _deploy(bytes memory init) internal returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create(0, add(init, 0x20), mload(init))
        }
        _check(deployed != address(0), "deployment");
    }

    // ------------------------------------------------------------- plans

    function _sorted(address a, address b) internal pure returns (address, address) {
        return a < b ? (a, b) : (b, a);
    }

    function _routesHash(DominoV2Types.SwapLeg[] memory legs) internal pure returns (bytes32) {
        return DominoV2Types.routesHash(legs);
    }

    function _noLegs() internal pure returns (DominoV2Types.SwapLeg[] memory) {
        return new DominoV2Types.SwapLeg[](0);
    }

    function _oneLeg(DominoV2Types.SwapLeg memory leg) internal pure returns (DominoV2Types.SwapLeg[] memory legs) {
        legs = new DominoV2Types.SwapLeg[](1);
        legs[0] = leg;
    }

    function _inputs(address token, uint128 amount) internal pure returns (DominoV2Types.TokenAmount[] memory list) {
        list = new DominoV2Types.TokenAmount[](1);
        list[0] = DominoV2Types.TokenAmount(token, amount);
    }

    function _noInputs() internal pure returns (DominoV2Types.TokenAmount[] memory) {
        return new DominoV2Types.TokenAmount[](0);
    }

    /// An intent with the given action, pool and range, signed fee terms for
    /// `legs` (65 bps in `feeToken`, or none without legs), the legs' hash.
    function _intent(
        uint8 action,
        DominoV2Types.PoolRef memory pool,
        uint256 tokenId,
        int24 tickLower,
        int24 tickUpper,
        uint128 minLiquidity,
        DominoV2Types.SwapLeg[] memory legs,
        address feeToken,
        address recipient,
        uint256 nonce
    ) internal pure returns (DominoV2Types.PositionIntent memory intent) {
        intent.action = action;
        intent.pool = pool;
        intent.tokenId = tokenId;
        intent.tickLower = tickLower;
        intent.tickUpper = tickUpper;
        intent.minLiquidity = minLiquidity;
        if (legs.length != 0) (intent.feeBps, intent.feeToken) = (DominoV2Types.FEE_ASSISTED_SWAP_BPS, feeToken);
        intent.routesHash = DominoV2Types.routesHash(legs);
        intent.recipient = recipient;
        intent.nonce = nonce;
        intent.deadline = DEADLINE;
    }

    // ------------------------------------------------------------ signing

    function _signature(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// The batch permit of `inputs` with the intent's nonce.
    function _permit(DominoV2Types.TokenAmount[] memory inputs, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (IPermit2Signature.PermitBatchTransferFrom memory permit)
    {
        permit.permitted = new IPermit2Signature.TokenPermissions[](inputs.length);
        for (uint256 i; i < inputs.length; ++i) {
            permit.permitted[i] = IPermit2Signature.TokenPermissions(inputs[i].token, inputs[i].amount);
        }
        permit.nonce = nonce;
        permit.deadline = deadline;
    }

    /// What the owner's wallet signs: PermitBatchWitnessTransferFrom with the
    /// PositionIntent witness, `spender` the zap, on Permit2's domain.
    function _permitDigest(
        IPermit2Signature.PermitBatchTransferFrom memory permit,
        address spender,
        DominoV2Types.PositionIntent memory intent
    ) internal view returns (bytes32) {
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,",
                DominoV2Types.PERMIT2_WITNESS_TYPE_STRING
            )
        );
        bytes32[] memory hashes = new bytes32[](permit.permitted.length);
        for (uint256 i; i < hashes.length; ++i) {
            hashes[i] = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted[i]));
        }
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
                keccak256(abi.encodePacked(hashes)),
                spender,
                permit.nonce,
                permit.deadline,
                DominoV2Types.hashPositionIntent(intent)
            )
        );
        return DominoV2Types.digest(IPermit2Views(PERMIT2).DOMAIN_SEPARATOR(), structHash);
    }

    function _relayedDigest(address zap, DominoV2RelayTypes.RelayedPositionAction memory action)
        internal
        view
        returns (bytes32)
    {
        return DominoV2Types.digest(
            DominoV2Types.domainSeparator(block.chainid, zap), DominoV2RelayTypes.hashRelayedPositionAction(action)
        );
    }

    function _relayedExit(IDominoPositionActions.ExitPlan memory plan)
        internal
        pure
        returns (DominoV2RelayTypes.RelayedPositionAction memory)
    {
        return DominoV2RelayTypes.RelayedPositionAction(
            plan.intent, plan.liquidityToRemove, plan.amount0MinRemoved, plan.amount1MinRemoved, 0, 0, plan.burn
        );
    }

    function _relayedChange(IDominoPositionActions.ChangeRangePlan memory plan)
        internal
        pure
        returns (DominoV2RelayTypes.RelayedPositionAction memory)
    {
        return DominoV2RelayTypes.RelayedPositionAction(
            plan.intent,
            plan.liquidityToRemove,
            plan.amount0MinRemoved,
            plan.amount1MinRemoved,
            plan.amount0Max,
            plan.amount1Max,
            plan.burnOld
        );
    }

    /// The intent hash every event and FeeCharged carry.
    function _intentHash(address zap, DominoV2Types.PositionIntent memory intent) internal view returns (bytes32) {
        return DominoV2Types.digest(
            DominoV2Types.domainSeparator(block.chainid, zap), DominoV2Types.hashPositionIntent(intent)
        );
    }
}
