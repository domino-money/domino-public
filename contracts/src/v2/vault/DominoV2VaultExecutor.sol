// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IDominoVault, IDominoVaultExecution} from "../interfaces/IDominoVault.sol";
import {IDominoVaultLedger} from "../interfaces/IDominoVaultLedger.sol";
import {DominoFeeLedger} from "../fees/DominoFeeLedger.sol";
import {DominoFeeRules} from "../fees/DominoFeeRules.sol";
import {TickMath} from "../positions/uniswap/TickMath.sol";
import {DominoSwapFloor} from "../route/DominoSwapFloor.sol";
import {IDominoVaultSwapSteps} from "./IDominoVaultSteps.sol";
import {DominoV2VaultPlan as Plan} from "./DominoV2VaultPlan.sol";
import {DominoV2VaultMath as M} from "./DominoV2VaultMath.sol";
import {DominoV2VaultStorage} from "./DominoV2VaultStorage.sol";

/// @notice The operator's and the exit module's paths of a Domino vault:
/// IDominoVaultExecution.execute and IDominoVault.executeExit.
/// @dev Created by the vault implementation's constructor and reached only by
/// DELEGATECALL from a vault, so it runs in the vault's storage with the
/// vault's balances and approvals. Called directly it refuses everything.
/// The tariff is charged through F1b's DominoFeeLedger, in the vault's
/// ERC-7201 fee storage.
abstract contract DominoV2VaultExecutor is DominoV2VaultStorage, DominoFeeLedger {
    /// A swap's output must fund the add it was made for: after the add its
    /// source may keep at most 1/100 of it (audit A5, no unnecessary swaps).
    uint256 internal constant SWAP_LEFTOVER_DIVISOR = 100;
    /// IDominoAutoExitExtension.ExitInstruction.version (F4).
    uint8 internal constant EXIT_INSTRUCTION_VERSION = 1;

    address private immutable SELF;

    constructor() {
        SELF = address(this);
    }

    /// Per-execution working state; the budget arrays follow plan.budgets.
    struct Run {
        DominoV2Types.PoolRef pool;
        uint160 anchor;
        uint16 tariffBps;
        uint256 rootId;
        uint256[] cap0;
        uint256[] cap1;
        uint256[] gross0;
        uint256[] gross1;
        uint256 fee0;
        uint256 fee1;
    }

    // ============================================================ execution

    /// See IDominoVaultExecution and DominoV2VaultPlan. Returns zero, having only
    /// disarmed the root, when the plan needs a root the vault no longer
    /// controls (the owner changed it or took the approval back).
    function execute(bytes calldata plan) external nonReentrant returns (bytes32 planHash) {
        if (address(this) == SELF) revert IDominoVault.Unauthorized();
        if (!REGISTRY.isOperator(msg.sender)) revert IDominoVault.Unauthorized();
        if (_paused || REGISTRY.automationHalted()) revert IDominoVault.AutomationUnavailable();
        Plan.PlanV1 memory p = Plan.decode(plan);
        if (p.stateNonce != _stateNonce) revert StaleNonce();
        if (block.timestamp > p.deadline) revert PlanExpired();
        uint64 last = _lastExecutionAt;
        if (last != 0 && block.timestamp < uint256(last) + _minimumIntervalSeconds) revert TooSoon();
        planHash = keccak256(abi.encodePacked(block.chainid, address(this), plan));

        Run memory r;
        r.rootId = _rootTokenId;
        bool touchesRoot = _contains(p.collect, r.rootId);
        if (touchesRoot) {
            if (!_rootArmed) revert IDominoVault.AutomationUnavailable();
            uint8 reason = _rootLive();
            if (reason != 0) {
                _disarm(reason);
                return bytes32(0);
            }
        }
        r.pool = _pool();
        (r.anchor,) = PRICE_ANCHOR.anchor(r.pool, p.anchorEvidence, _maxObservationAgeSeconds, _maxPriceImpactBps);
        r.tariffBps = DominoFeeRules.automationFeeBps(_mode);
        _validate(p, r);

        for (uint256 i; i < p.collect.length; ++i) {
            _collect(r.pool, p.collect[i], p.collect[i] == r.rootId);
        }
        uint256 n = p.budgets.length;
        (r.cap0, r.cap1, r.gross0, r.gross1) = (new uint256[](n), new uint256[](n), new uint256[](n), new uint256[](n));
        for (uint256 i; i < n; ++i) {
            (r.cap0[i], r.cap1[i]) = (p.budgets[i].max0, p.budgets[i].max1);
        }
        uint256 swapOut;
        if (p.swap.legs.length != 0) swapOut = _swap(p, r);

        (uint256 destination, uint128 liquidity, uint256 paid0, uint256 paid1) = _add(p, r);

        if (swapOut != 0) {
            address tokenOut = p.swap.zeroForOne ? r.pool.currency1 : r.pool.currency0;
            if (_lots[p.swap.source][tokenOut].charged > swapOut / SWAP_LEFTOVER_DIVISOR) revert InvalidAmount();
        }
        if (touchesRoot) {
            // An owner change inside this transaction would have disarmed the root.
            if (!_rootArmed) revert IDominoVault.AutomationUnavailable();
            _afterRootStep();
        }
        // F1b's ledger: pushed to the registry's recipient, or owed (audit A1).
        _chargeFee(DominoV2Types.FEE_KIND_AUTOMATION, r.pool.currency0, _owner, r.fee0, planHash);
        _chargeFee(DominoV2Types.FEE_KIND_AUTOMATION, r.pool.currency1, _owner, r.fee1, planHash);
        uint64 nonce = ++_stateNonce;
        _lastExecutionAt = uint64(block.timestamp);
        if (p.action == Plan.ACTION_MINT) emit IDominoVault.SuccessorCreated(p.target, destination, nonce);
        emit IDominoVault.Compounded(destination, liquidity, paid0, paid1, r.fee0, r.fee1, nonce);
        emit IDominoVaultExecution.Executed(planHash, p.action, nonce);
    }

    /// Everything the plan asks for that the state can refuse before any step.
    function _validate(Plan.PlanV1 memory p, Run memory r) private view {
        uint256 previous;
        for (uint256 i; i < p.collect.length; ++i) {
            uint256 tokenId = p.collect[i];
            if (tokenId <= previous || !_member[tokenId].active) revert InvalidPlan();
            previous = tokenId;
        }
        IDominoVaultLedger.Member memory destination;
        if (p.action == Plan.ACTION_COMPOUND) {
            destination = _member[p.target];
            // The destination's own fees are collected first: on v4 an increase
            // would otherwise settle them into the add, unaccounted. Being in
            // `collect` also makes it an active member.
            if (!_contains(p.collect, p.target) || p.tickLower != 0 || p.tickUpper != 0) {
                revert InvalidPlan();
            }
        } else if (p.action == Plan.ACTION_MINT) {
            IDominoVaultLedger.Member memory parent = _member[p.target];
            if (!parent.active || parent.successor != 0 || _members.length >= _maxPositions) revert InvalidRoute();
            _checkSuccessor(parent, p.tickLower, p.tickUpper, r.anchor);
            destination = IDominoVaultLedger.Member(true, uint96(p.target), 0, p.tickLower, p.tickUpper);
        } else {
            revert InvalidPlan();
        }
        if (p.minLiquidity == 0 || p.budgets.length == 0) revert InvalidPlan();
        previous = 0;
        bool swapFunded;
        for (uint256 i; i < p.budgets.length; ++i) {
            uint256 source = p.budgets[i].tokenId;
            IDominoVaultLedger.Member memory from = _member[source];
            if (source <= previous || !from.active) revert InvalidPlan();
            previous = source;
            if (!_routable(source, from, p, destination, r.anchor)) revert InvalidRoute();
            if (source == p.swap.source) swapFunded = true;
        }
        Plan.Swap memory s = p.swap;
        if (s.legs.length == 0) {
            if (s.source != 0 || s.zeroForOne || s.amountIn != 0 || s.minAmountOut != 0) revert InvalidPlan();
        } else if (!swapFunded || s.amountIn == 0) {
            revert InvalidPlan();
        }
    }

    /// Domino routing, against the anchor (A6). Fees return to their own
    /// position. A position the price is in funds nothing else, except its
    /// successor once the price is within the trigger distance of its ceiling.
    /// A position the price has left funds any position the price is in.
    /// Simple mode has the root alone, so only the first rule applies there.
    function _routable(uint256 source, IDominoVaultLedger.Member memory from, Plan.PlanV1 memory p, IDominoVaultLedger.Member memory to, uint160 anchor)
        private
        view
        returns (bool)
    {
        bool mint = p.action == Plan.ACTION_MINT;
        if (!mint && source == p.target) return true;
        if (_inRange(from, anchor)) {
            return (mint ? source == p.target : from.successor == p.target) && _nearCeiling(from, anchor);
        }
        return _inRange(to, anchor);
    }

    /// The successor's range, against the parent's ceiling or, when the price
    /// is already past it, the anchor (A3). Prices are quote per base. The
    /// range's own validity (order, bounds, spacing) is the position
    /// adapter's check at the mint.
    function _checkSuccessor(IDominoVaultLedger.Member memory parent, int24 tickLower, int24 tickUpper, uint160 anchor) private view {
        if (!_nearCeiling(parent, anchor)) revert InvalidRoute();
        int24 spacing = _tickSpacing;
        bool inverse = _inverse;
        uint160 ceiling = TickMath.getSqrtPriceAtTick(inverse ? parent.tickLower : parent.tickUpper);
        uint160 basis = _orientedAtLeast(anchor, ceiling, M.BPS) ? anchor : ceiling;
        uint160 floor = TickMath.getSqrtPriceAtTick(inverse ? tickUpper : tickLower);
        uint256 upside = M.BPS + _upsideBps;
        if (
            !_orientedAtLeast(basis, floor, M.BPS) || !_orientedAtLeast(floor, basis, M.BPS - _maxOverlapBps)
                || !_orientedAtLeast(TickMath.getSqrtPriceAtTick(inverse ? tickLower : tickUpper), basis, upside)
                || _orientedAtLeast(TickMath.getSqrtPriceAtTick(inverse ? tickLower + spacing : tickUpper - spacing), basis, upside)
        ) revert InvalidRoute();
    }

    /// The anchor is within the trigger distance below the ceiling, or past it.
    function _nearCeiling(IDominoVaultLedger.Member memory position, uint160 anchor) private view returns (bool) {
        uint160 ceiling = TickMath.getSqrtPriceAtTick(_inverse ? position.tickLower : position.tickUpper);
        return _orientedAtLeast(anchor, ceiling, M.BPS - _triggerDistanceBps);
    }

    function _inRange(IDominoVaultLedger.Member memory position, uint160 anchor) private pure returns (bool) {
        return TickMath.getSqrtPriceAtTick(position.tickLower) <= anchor && anchor < TickMath.getSqrtPriceAtTick(position.tickUpper);
    }

    /// (x / y)^2 >= num / 10000 in the sequence's quote-per-base orientation.
    function _orientedAtLeast(uint160 x, uint160 y, uint256 num) private view returns (bool) {
        return _inverse ? M.ratioAtLeast(y, x, num) : M.ratioAtLeast(x, y, num);
    }

    /// One direction, from one source's lots, its output credited back to the
    /// same source as charged units. Returns the output.
    function _swap(Plan.PlanV1 memory p, Run memory r) private returns (uint256 amountOut) {
        Plan.Swap memory s = p.swap;
        (address tokenIn, address tokenOut) =
            s.zeroForOne ? (r.pool.currency0, r.pool.currency1) : (r.pool.currency1, r.pool.currency0);
        // F1b's floor at the anchor: the pool's whole fee is not slippage (#3409682).
        if (
            s.minAmountOut
                < DominoSwapFloor.minimumOutput(
                    s.amountIn, r.anchor, s.zeroForOne, _swapFeePips(s.zeroForOne), _maxSlippageBps
                )
        ) revert InvalidRoute();
        uint256 index;
        while (p.budgets[index].tokenId != s.source) ++index;
        if (_spend(r, index, s.source, tokenIn, s.zeroForOne, s.amountIn) != s.amountIn) revert InsufficientReserves();
        uint256 beforeIn = _balance(tokenIn);
        uint256 beforeOut = _balance(tokenOut);
        (bool ok, bytes memory reason) =
            _swapModule().delegatecall(abi.encodeCall(IDominoVaultSwapSteps.swap, (s.legs, tokenIn, tokenOut)));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
        amountOut = _balance(tokenOut) - beforeOut;
        if (beforeIn - _balance(tokenIn) != s.amountIn || amountOut < s.minAmountOut) revert InvalidAmount();
        _lots[s.source][tokenOut].charged += _u128(amountOut);
        emit IDominoVaultLedger.Swapped(s.source, s.zeroForOne, s.amountIn, amountOut);
        // The swap may have moved this pool: the add is bounded by the anchor again.
        PRICE_ANCHOR.anchor(r.pool, p.anchorEvidence, _maxObservationAgeSeconds, _maxPriceImpactBps);
        // On v4 a swap through this pool accrues fees to the destination, which
        // the increase would settle unseen: collect them into its own lots.
        if (p.action == Plan.ACTION_COMPOUND && _feesSettleOnModify()) {
            _collect(r.pool, p.target, p.target == r.rootId);
        }
    }

    /// Adds what the budgets can pay, up to the plan's maxima, and allocates
    /// what the add actually took to the budgets in plan order.
    function _add(Plan.PlanV1 memory p, Run memory r)
        private
        returns (uint256 destination, uint128 liquidity, uint256 paid0, uint256 paid1)
    {
        uint256 max0;
        uint256 max1;
        for (uint256 i; i < p.budgets.length; ++i) {
            max0 += _capacity(r, i, p.budgets[i].tokenId, r.pool.currency0, true);
            max1 += _capacity(r, i, p.budgets[i].tokenId, r.pool.currency1, false);
        }
        if (max0 > p.amount0Max) max0 = p.amount0Max;
        if (max1 > p.amount1Max) max1 = p.amount1Max;
        uint256 before0 = _balance(r.pool.currency0);
        uint256 before1 = _balance(r.pool.currency1);
        // max0 and max1 fit 128 bits: each is at most the plan's uint128 maximum.
        if (p.action == Plan.ACTION_COMPOUND) {
            destination = p.target;
            bool isRoot = destination == r.rootId;
            _rootStep(isRoot, true);
            liquidity = _stepIncrease(r.pool, destination, uint128(max0), uint128(max1), p.minLiquidity);
            _rootStep(isRoot, false);
        } else {
            // The position manager mints the successor to the vault.
            (destination, liquidity) =
                _stepMint(r.pool, p.tickLower, p.tickUpper, uint128(max0), uint128(max1), p.minLiquidity);
            if (destination > type(uint96).max) revert InvalidPosition();
            _member[destination] = IDominoVaultLedger.Member(true, uint96(p.target), 0, p.tickLower, p.tickUpper);
            _member[p.target].successor = uint96(destination);
            _members.push(destination);
        }
        // The step pays at most max0 and max1, the budgets' joint capacity;
        // allocation spends exactly what left the vault.
        paid0 = before0 - _balance(r.pool.currency0);
        paid1 = before1 - _balance(r.pool.currency1);
        _allocate(p, r, r.pool.currency0, true, paid0);
        _allocate(p, r, r.pool.currency1, false, paid1);
    }

    function _allocate(Plan.PlanV1 memory p, Run memory r, address token, bool isToken0, uint256 amount) private {
        for (uint256 i; i < p.budgets.length && amount != 0; ++i) {
            amount -= _spend(r, i, p.budgets[i].tokenId, token, isToken0, amount);
        }
        if (amount != 0) revert InsufficientReserves();
    }

    /// What budget `index` can still provide in `token`, net of the tariff.
    function _capacity(Run memory r, uint256 index, uint256 source, address token, bool isToken0)
        private
        view
        returns (uint256)
    {
        IDominoVaultLedger.Lot memory entry = _lots[source][token];
        uint256 cap = isToken0 ? r.cap0[index] : r.cap1[index];
        uint256 prior = isToken0 ? r.gross0[index] : r.gross1[index];
        uint256 charged = entry.charged < cap ? entry.charged : cap;
        uint256 gross = entry.uncharged < cap - charged ? entry.uncharged : cap - charged;
        return charged + M.netOf(prior + gross, r.tariffBps) - M.netOf(prior, r.tariffBps);
    }

    /// Spends up to `want` from budget `index` in `token`: charged units first,
    /// then uncharged gross, cutting the tariff against the budget's cumulative
    /// gross in this execution. Returns what it provided.
    function _spend(Run memory r, uint256 index, uint256 source, address token, bool isToken0, uint256 want)
        private
        returns (uint256 provided)
    {
        uint256 available = _capacity(r, index, source, token, isToken0);
        provided = want < available ? want : available;
        if (provided == 0) return 0;
        IDominoVaultLedger.Lot storage entry = _lots[source][token];
        uint256 cap = isToken0 ? r.cap0[index] : r.cap1[index];
        uint256 charged = entry.charged < cap ? entry.charged : cap;
        if (charged > provided) charged = provided;
        uint256 prior = isToken0 ? r.gross0[index] : r.gross1[index];
        uint256 total = M.grossFor(prior, provided - charged, r.tariffBps);
        uint256 gross = total - prior;
        entry.charged -= uint128(charged);
        entry.uncharged -= uint128(gross);
        uint256 fee = gross - (provided - charged);
        if (isToken0) {
            r.cap0[index] = cap - charged - gross;
            r.gross0[index] = total;
            r.fee0 += fee;
        } else {
            r.cap1[index] = cap - charged - gross;
            r.gross1[index] = total;
            r.fee1 += fee;
        }
    }

    // ============================================================ auto-exit

    /// See IDominoVault.executeExit, for F4's auto-exit module
    /// (docs/v2/F4_AUTO_EXIT.md, "The vault's side"). `instruction` is version
    /// 1 of IDominoAutoExitExtension.ExitInstruction:
    /// abi.encode(uint8 version, bytes32 mandateHash, address recipient,
    /// uint128 amount0Min, uint128 amount1Min), with `recipient` the calling
    /// module. In one call: all the position's liquidity is removed with those
    /// minimums on the principal, and everything withdrawn, principal and the
    /// fees the position accrued, goes to the module, which charges its 0.2%
    /// and delivers to the owner; the position's own reserves (its lots) go to
    /// the owner without any charge, kept as idle when the owner cannot
    /// receive them; the position leaves automation. Nothing calls back into
    /// the module but a native transfer. Ignores pause: the mandate is its own
    /// consent, revocable at any time, as is the module itself.
    function executeExit(uint256 tokenId, bytes calldata instruction)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        // The executor's own storage never has an exit module, so a direct
        // call is refused here as well.
        if (msg.sender != _exitModule) revert IDominoVault.Unauthorized();
        if (REGISTRY.automationHalted()) revert IDominoVault.AutomationUnavailable();
        if (!_member[tokenId].active) revert InvalidPosition();
        (uint8 version,, address recipient, uint128 amount0Min, uint128 amount1Min) =
            abi.decode(instruction, (uint8, bytes32, address, uint128, uint128));
        if (version != EXIT_INSTRUCTION_VERSION || recipient != msg.sender) revert InvalidInstruction();
        bool isRoot = tokenId == _rootTokenId;
        // An exit needs the approval only: the checkpoint and the subscription
        // protect automation fees, and an exit charges none.
        if (isRoot && !_rootApproved()) revert IDominoVault.AutomationUnavailable();
        DominoV2Types.PoolRef memory pool = _pool();
        uint64 nonce = ++_stateNonce;
        uint256 before0 = _balance(pool.currency0);
        uint256 before1 = _balance(pool.currency1);
        _rootStep(isRoot, true);
        _stepWithdraw(pool, tokenId, _liquidity(tokenId), amount0Min, amount1Min);
        _rootStep(isRoot, false);
        amount0 = _balance(pool.currency0) - before0;
        amount1 = _balance(pool.currency1) - before1;
        _pay(pool.currency0, recipient, amount0);
        _pay(pool.currency1, recipient, amount1);
        _release(tokenId, pool.currency0, true);
        _release(tokenId, pool.currency1, true);
        if (isRoot) {
            // Recorded even when already disarmed, so no operator rearms after it.
            if (_rootArmed) emit IDominoVault.RootDisarmed(DISARM_EXITED, nonce);
            _markDisarmed(DISARM_EXITED);
        } else {
            _retire(tokenId);
            _transferPosition(tokenId, _owner);
            emit IDominoVault.ChildWithdrawn(tokenId, nonce);
        }
        emit IDominoVault.ExitExecuted(msg.sender, tokenId, amount0, amount1, nonce);
    }

    function _contains(uint256[] memory list, uint256 value) private pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == value) return true;
        }
        return false;
    }
}
