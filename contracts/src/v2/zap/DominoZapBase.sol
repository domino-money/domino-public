// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2RelayTypes} from "../DominoV2RelayTypes.sol";
import {DominoV2Types} from "../DominoV2Types.sol";
import {IPermit2Signature} from "../external/IPermit2Signature.sol";
import {IDominoPositionActions} from "../interfaces/IDominoPositionActions.sol";
import {IDominoZap} from "../interfaces/IDominoZap.sol";
import {DominoAssistedSwap} from "../route/DominoAssistedSwap.sol";
import {DominoTokenOps} from "../route/DominoTokenOps.sol";

/// @notice Manual position management without custody (#283 S1): create,
/// increase, change range and exit, each in one transaction, for positions
/// that stay in the owner's wallet. DominoZapV3 and DominoZapV4 supply the
/// position steps (F1c adapters); this contract owns the plan rules, consent,
/// the assisted swap (F1b) and the refunds. docs/v2/F2_ZAP.md is the reference.
/// @dev Rules every action follows:
/// - the intent's action, deadline, recipient, pool (and the hooks policy) and
///   routesHash are checked before anything moves; its fee terms are checked
///   by the assisted swap before any leg runs;
/// - an action on an existing position needs the position's current owner,
///   as msg.sender or as the signer, never anyone the position approved;
/// - inputs come from msg.sender (ERC-20 allowance to this contract, native as
///   msg.value) or from the Permit2 signer; nothing is ever pulled from anyone
///   else, so an allowance an owner leaves on this contract serves only them;
/// - every token the action touched is refunded to intent.recipient at the
///   end, except what is owed to the fee recipient, so nothing stays here;
/// - every entry point holds the one action lock, which the executor, the
///   callbacks and flushOwedFees share. No EIP-1271 here (F1b).
abstract contract DominoZapBase is DominoAssistedSwap, IDominoPositionActions, IDominoZap {
    /// One position step, as both adapters report it: delta < 0 was paid into
    /// the pool from this contract, delta > 0 was delivered by it.
    struct Step {
        uint256 tokenId;
        uint128 liquidity;
        int256 delta0;
        int256 delta1;
    }

    /// The four plans in one shape; fields an action does not use are zero.
    /// `action` and `by` travel in memory, not as literal arguments, so the
    /// optimizer keeps one copy of the flow instead of one per entry point.
    struct Action {
        uint8 action;
        uint8 by;
        DominoV2Types.PositionIntent intent;
        DominoV2Types.TokenAmount[] inputs;
        DominoV2Types.SwapLeg[] legs;
        uint128 amount0Max;
        uint128 amount1Max;
        uint160 initSqrtPriceX96;
        uint128 liquidityToRemove;
        uint128 amount0MinRemoved;
        uint128 amount1MinRemoved;
        bool burn;
    }

    /// Who consents: msg.sender, the Permit2 signer (intent.recipient), or the
    /// position's owner through a RelayedPositionAction signature.
    uint8 private constant BY_CALLER = 0;
    uint8 private constant BY_PERMIT = 1;
    uint8 private constant BY_SIGNATURE = 2;

    /// Half the secp256k1 order: a larger s is the malleable twin (EIP-2).
    uint256 private constant MAX_S = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint256 private constant TRANSFER_FROM = 0x23b872dd;

    mapping(address owner => mapping(uint256 word => uint256 bits)) private _relayNonces;

    constructor(RouteConfig memory route) DominoAssistedSwap(route) {}

    /// Native currency only arrives inside an action (the PoolManager's take,
    /// an admitted router, a leg's output); stray ETH is refused.
    receive() external payable {
        if (!_actionLocked()) revert Unauthorized();
    }

    // ------------------------------------------------------------ actions

    function create(CreatePlan memory plan) external payable nonReentrant returns (ActionResult memory) {
        IPermit2Signature.PermitBatchTransferFrom memory none;
        return _act(_fromCreate(plan, BY_CALLER), none, "");
    }

    function createWithPermit(
        CreatePlan memory plan,
        IPermit2Signature.PermitBatchTransferFrom memory permit,
        bytes memory signature
    ) external nonReentrant returns (ActionResult memory) {
        return _act(_fromCreate(plan, BY_PERMIT), permit, signature);
    }

    function increase(IncreasePlan memory plan) external payable nonReentrant returns (ActionResult memory) {
        IPermit2Signature.PermitBatchTransferFrom memory none;
        return _act(_fromIncrease(plan, BY_CALLER), none, "");
    }

    function increaseWithPermit(
        IncreasePlan memory plan,
        IPermit2Signature.PermitBatchTransferFrom memory permit,
        bytes memory signature
    ) external nonReentrant returns (ActionResult memory) {
        return _act(_fromIncrease(plan, BY_PERMIT), permit, signature);
    }

    function changeRange(ChangeRangePlan memory plan) external nonReentrant returns (ActionResult memory) {
        IPermit2Signature.PermitBatchTransferFrom memory none;
        return _act(_fromChangeRange(plan, BY_CALLER), none, "");
    }

    function changeRangeWithSignature(ChangeRangePlan memory plan, bytes memory signature)
        external
        nonReentrant
        returns (ActionResult memory)
    {
        IPermit2Signature.PermitBatchTransferFrom memory none;
        return _act(_fromChangeRange(plan, BY_SIGNATURE), none, signature);
    }

    function exit(ExitPlan memory plan) external nonReentrant returns (ActionResult memory) {
        IPermit2Signature.PermitBatchTransferFrom memory none;
        return _act(_fromExit(plan, BY_CALLER), none, "");
    }

    function exitWithSignature(ExitPlan memory plan, bytes memory signature)
        external
        nonReentrant
        returns (ActionResult memory)
    {
        IPermit2Signature.PermitBatchTransferFrom memory none;
        return _act(_fromExit(plan, BY_SIGNATURE), none, signature);
    }

    // ------------------------------------------------------------- nonces

    function nonceBitmap(address owner, uint256 word) external view returns (uint256) {
        return _relayNonces[owner][word];
    }

    function invalidateNonces(uint256 word, uint256 mask) external nonReentrant {
        _relayNonces[msg.sender][word] |= mask;
        emit NoncesInvalidated(msg.sender, word, mask);
    }

    function domainSeparator() public view returns (bytes32) {
        return DominoV2Types.domainSeparator(block.chainid, address(this));
    }

    // -------------------------------------------------------------- the action

    function _act(Action memory a, IPermit2Signature.PermitBatchTransferFrom memory permit, bytes memory signature)
        private
        returns (ActionResult memory r)
    {
        (uint8 action, uint8 by) = (a.action, a.by);
        DominoV2Types.PositionIntent memory intent = a.intent;
        bytes32 ref = _open(intent, action, a.legs);
        address owner = by == BY_CALLER ? msg.sender : intent.recipient;
        if (action == DominoV2Types.ACTION_CREATE) {
            if (intent.tokenId != 0) revert InvalidPlan();
        } else {
            (address holder, int24 tickLower, int24 tickUpper) = _position(intent.tokenId);
            // Increase and exit name the position's range; change range names the new one.
            if (
                action != DominoV2Types.ACTION_CHANGE_RANGE
                    && (tickLower != intent.tickLower || tickUpper != intent.tickUpper)
            ) revert InvalidPlan();
            if (by == BY_SIGNATURE) {
                owner = holder;
                _verifyRelayed(a, owner, signature);
            }
            if (holder != owner) revert Unauthorized();
        }
        if (by == BY_PERMIT) _pullWithPermit(a, permit, signature, owner, ref);
        else _pullFromCaller(a.inputs, ref);

        DominoV2Types.PoolRef memory pool = intent.pool;
        address recipient = intent.recipient;
        address[] memory tokens = _actionTokens(pool, a.inputs, a.legs);
        Step memory step;
        if (action >= DominoV2Types.ACTION_CHANGE_RANGE) {
            if (action == DominoV2Types.ACTION_EXIT && a.liquidityToRemove < intent.minLiquidity) {
                revert InsufficientLiquidity();
            }
            // An exit without conversion pays the recipient directly.
            step = _withdraw(
                intent.tokenId,
                pool,
                a.liquidityToRemove,
                a.amount0MinRemoved,
                a.amount1MinRemoved,
                action == DominoV2Types.ACTION_EXIT && a.legs.length == 0 ? recipient : address(this),
                a.burn
            );
            _record(ref, owner, pool, step, false);
        }
        (, r.feeAmount) = _assistedSwap(a.legs, tokens, intent.feeBps, intent.feeToken, owner, ref);
        r.feeToken = intent.feeToken;
        if (action != DominoV2Types.ACTION_EXIT) {
            if (a.initSqrtPriceX96 != 0) _initialize(pool, a.initSqrtPriceX96);
            _prepare(pool);
            uint128 amount0 = _available(pool.currency0, a.amount0Max);
            uint128 amount1 = _available(pool.currency1, a.amount1Max);
            step = action == DominoV2Types.ACTION_INCREASE
                ? _addLiquidity(intent.tokenId, pool, amount0, amount1, intent.minLiquidity)
                : _mint(pool, intent.tickLower, intent.tickUpper, amount0, amount1, intent.minLiquidity, recipient);
            _record(ref, owner, pool, step, true);
        }
        if (action != DominoV2Types.ACTION_EXIT || a.legs.length != 0) _refund(tokens, recipient);
        emit PositionActionExecuted(action, recipient, step.tokenId, intent.tokenId, step.liquidity, ref);
        r.tokenId = step.tokenId;
        r.liquidity = step.liquidity;
        r.amount0 = _magnitude(step.delta0);
        r.amount1 = _magnitude(step.delta1);
    }

    function _fromCreate(CreatePlan memory p, uint8 by) private pure returns (Action memory a) {
        (a.action, a.by) = (DominoV2Types.ACTION_CREATE, by);
        (a.intent, a.inputs, a.legs) = (p.intent, p.inputs, p.legs);
        (a.amount0Max, a.amount1Max, a.initSqrtPriceX96) = (p.amount0Max, p.amount1Max, p.initSqrtPriceX96);
    }

    function _fromIncrease(IncreasePlan memory p, uint8 by) private pure returns (Action memory a) {
        (a.action, a.by) = (DominoV2Types.ACTION_INCREASE, by);
        (a.intent, a.inputs, a.legs, a.amount0Max, a.amount1Max) =
            (p.intent, p.inputs, p.legs, p.amount0Max, p.amount1Max);
    }

    function _fromChangeRange(ChangeRangePlan memory p, uint8 by) private pure returns (Action memory a) {
        (a.action, a.by) = (DominoV2Types.ACTION_CHANGE_RANGE, by);
        (a.intent, a.legs, a.amount0Max, a.amount1Max) = (p.intent, p.legs, p.amount0Max, p.amount1Max);
        (a.liquidityToRemove, a.amount0MinRemoved, a.amount1MinRemoved, a.burn) =
            (p.liquidityToRemove, p.amount0MinRemoved, p.amount1MinRemoved, p.burnOld);
    }

    function _fromExit(ExitPlan memory p, uint8 by) private pure returns (Action memory a) {
        (a.action, a.by) = (DominoV2Types.ACTION_EXIT, by);
        (a.intent, a.legs) = (p.intent, p.legs);
        (a.liquidityToRemove, a.amount0MinRemoved, a.amount1MinRemoved, a.burn) =
            (p.liquidityToRemove, p.amount0MinRemoved, p.amount1MinRemoved, p.burn);
    }

    // ---------------------------------------------------------- the plan

    /// The checks that need nothing but the intent and the legs; returns the
    /// intent hash (its EIP-712 digest on this zap), the action's reference in
    /// every event and in FeeCharged.ref.
    function _open(DominoV2Types.PositionIntent memory intent, uint8 action, DominoV2Types.SwapLeg[] memory legs)
        private
        view
        returns (bytes32)
    {
        if (intent.action != action) revert InvalidPlan();
        if (block.timestamp > intent.deadline) revert PlanExpired();
        if (intent.recipient == address(0) || intent.recipient == address(this)) revert InvalidPlan();
        _checkPool(intent.pool);
        if (intent.routesHash != DominoV2Types.routesHash(legs)) revert InvalidPlan();
        return DominoV2Types.digest(domainSeparator(), DominoV2Types.hashPositionIntent(intent));
    }

    /// The owner's EIP-712 signature of the relayed action on this zap, and
    /// its nonce, used once.
    function _verifyRelayed(Action memory a, address owner, bytes memory signature) private {
        bytes32 hash = DominoV2Types.digest(
            domainSeparator(),
            DominoV2RelayTypes.hashRelayedPositionAction(
                DominoV2RelayTypes.RelayedPositionAction(
                    a.intent,
                    a.liquidityToRemove,
                    a.amount0MinRemoved,
                    a.amount1MinRemoved,
                    a.amount0Max,
                    a.amount1Max,
                    a.burn
                )
            )
        );
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (uint256(s) > MAX_S) revert InvalidSignature();
        // owner is the NFT's holder, never zero, so a failed recovery (zero) never matches.
        if (ecrecover(hash, v, r, s) != owner) revert InvalidSignature();
        uint256 nonce = a.intent.nonce;
        uint256 bit = 1 << (nonce & 0xff);
        uint256 bits = _relayNonces[owner][nonce >> 8];
        if (bits & bit != 0) revert NonceUsed(owner, nonce);
        _relayNonces[owner][nonce >> 8] = bits | bit;
    }

    // -------------------------------------------------------------- tokens

    /// From msg.sender: ERC-20s through its allowance to this contract, the
    /// native currency as msg.value, which must be exactly the native inputs.
    function _pullFromCaller(DominoV2Types.TokenAmount[] memory inputs, bytes32 ref) private {
        uint256 native;
        for (uint256 i; i < inputs.length; ++i) {
            (address token, uint256 amount) = (inputs[i].token, inputs[i].amount);
            if (token == address(0)) native += amount;
            else _transferIn(token, amount);
            emit InputPulled(ref, msg.sender, token, amount);
        }
        if (native != msg.value) revert InvalidPlan();
    }

    /// From the owner through Permit2, with the intent as the witness: the
    /// permit must list exactly the plan's inputs, in order, and carry the
    /// intent's nonce (Permit2 itself refuses a list of another length).
    function _pullWithPermit(
        Action memory a,
        IPermit2Signature.PermitBatchTransferFrom memory permit,
        bytes memory signature,
        address owner,
        bytes32 ref
    ) private {
        DominoV2Types.TokenAmount[] memory inputs = a.inputs;
        uint256 count = inputs.length;
        if (permit.nonce != a.intent.nonce) revert InvalidPlan();
        IPermit2Signature.SignatureTransferDetails[] memory details =
            new IPermit2Signature.SignatureTransferDetails[](count);
        for (uint256 i; i < count; ++i) {
            (address token, uint256 amount) = (inputs[i].token, inputs[i].amount);
            if (token == address(0) || permit.permitted[i].token != token || permit.permitted[i].amount != amount) {
                revert InvalidPlan();
            }
            details[i] = IPermit2Signature.SignatureTransferDetails(address(this), amount);
            emit InputPulled(ref, owner, token, amount);
        }
        IPermit2Signature(PERMIT2).permitWitnessTransferFrom(
            permit,
            details,
            owner,
            DominoV2Types.hashPositionIntent(a.intent),
            DominoV2Types.PERMIT2_WITNESS_TYPE_STRING,
            signature
        );
    }

    /// transferFrom(msg.sender, this, amount); tokens that return nothing are
    /// accepted, an address without code never is.
    function _transferIn(address token, uint256 amount) private {
        bool ok;
        assembly ("memory-safe") {
            let free := mload(0x40)
            mstore(free, shl(224, TRANSFER_FROM))
            mstore(add(free, 0x04), caller())
            mstore(add(free, 0x24), address())
            mstore(add(free, 0x44), amount)
            mstore(0x00, 0)
            ok := call(gas(), token, 0, free, 0x64, 0x00, 0x20)
            ok := and(ok, or(and(gt(returndatasize(), 0x1f), eq(mload(0x00), 1)),
                and(iszero(returndatasize()), gt(extcodesize(token), 0))))
        }
        if (!ok) revert DominoTokenOps.TokenCallFailed(token);
    }

    /// The action's tokens, once each: native (so no leg may move it unless it
    /// trades it), the pool currencies, the inputs and every leg's output. A
    /// leg's input is always one of these. The executor keeps the ones no leg
    /// trades still; the refund empties all of them.
    function _actionTokens(
        DominoV2Types.PoolRef memory pool,
        DominoV2Types.TokenAmount[] memory inputs,
        DominoV2Types.SwapLeg[] memory legs
    ) private pure returns (address[] memory set) {
        set = new address[](3 + inputs.length + legs.length);
        uint256 count = _addToken(set, 0, address(0));
        count = _addToken(set, count, pool.currency0);
        count = _addToken(set, count, pool.currency1);
        for (uint256 i; i < inputs.length; ++i) {
            count = _addToken(set, count, inputs[i].token);
        }
        for (uint256 i; i < legs.length; ++i) {
            count = _addToken(set, count, legs[i].tokenOut);
        }
        assembly ("memory-safe") {
            mstore(set, count)
        }
    }

    function _addToken(address[] memory set, uint256 count, address token) private pure returns (uint256) {
        for (uint256 i; i < count; ++i) {
            if (set[i] == token) return count;
        }
        set[count] = token;
        return count + 1;
    }

    /// What this contract may put into the position: its balance not owed to
    /// the fee recipient, up to the plan's cap.
    function _available(address currency, uint128 cap) private view returns (uint128) {
        uint256 held = _unowedBalance(currency);
        return held < cap ? uint128(held) : cap;
    }

    /// Everything the action touched goes to the recipient; owed fees stay.
    function _refund(address[] memory tokens, address recipient) private {
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            uint256 amount = _unowedBalance(token);
            if (amount != 0) {
                uint256 held = DominoTokenOps.selfBalance(token);
                DominoTokenOps.transfer(token, recipient, amount);
                // A token that debits more than it moves (a sender-side fee)
                // would spend what is owed in it.
                if (DominoTokenOps.selfBalance(token) + amount < held) revert DominoTokenOps.TokenCallFailed(token);
                emit Refunded(recipient, token, amount);
            }
        }
    }

    function _record(bytes32 ref, address owner, DominoV2Types.PoolRef memory pool, Step memory step, bool added)
        private
    {
        int256 liquidity = int256(uint256(step.liquidity));
        emit PositionLiquidityChanged(
            ref, owner, step.tokenId, pool, added ? liquidity : -liquidity, step.delta0, step.delta1
        );
    }

    function _magnitude(int256 delta) private pure returns (uint256) {
        return delta < 0 ? uint256(-delta) : uint256(delta);
    }

    // ------------------------------------------------- the version's steps

    /// Reverts InvalidPlan for a pool this zap does not manage (another dex,
    /// or a hooked v4 pool under the default policy).
    function _checkPool(DominoV2Types.PoolRef memory pool) internal view virtual;

    /// The position's current owner and range; reverts for a token that does not exist.
    function _position(uint256 tokenId)
        internal
        view
        virtual
        returns (address owner, int24 tickLower, int24 tickUpper);

    function _initialize(DominoV2Types.PoolRef memory pool, uint160 sqrtPriceX96) internal virtual;

    /// Called before the amounts of an addition are measured (v3 wraps native).
    function _prepare(DominoV2Types.PoolRef memory pool) internal virtual;

    function _mint(
        DominoV2Types.PoolRef memory pool,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0,
        uint128 amount1,
        uint128 minLiquidity,
        address owner
    ) internal virtual returns (Step memory);

    function _addLiquidity(
        uint256 tokenId,
        DominoV2Types.PoolRef memory pool,
        uint128 amount0,
        uint128 amount1,
        uint128 minLiquidity
    ) internal virtual returns (Step memory);

    function _withdraw(
        uint256 tokenId,
        DominoV2Types.PoolRef memory pool,
        uint128 liquidity,
        uint128 amount0Min,
        uint128 amount1Min,
        address recipient,
        bool burn
    ) internal virtual returns (Step memory);
}
