// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {IDominoVaultLedger} from "../../../src/v2/interfaces/IDominoVaultLedger.sol";
import {TickMath} from "../../../src/v2/positions/uniswap/TickMath.sol";
import {DominoSwapFloor} from "../../../src/v2/route/DominoSwapFloor.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {HarnessV3} from "../vault/VaultHarness.sol";
import {MockToken, MockV3PositionManager} from "../vault/VaultMocks.sol";

/// Everyone who can touch one Domino-compound vault (three positions) on the
/// v3 unit model, driven by the fuzzer:
/// - the pool: fees accrue to any member;
/// - the operator: compounds of any member, with or without a swap of one
///   side first, successor mints near a ceiling, and a pause;
/// - the owner: withdrawals to any recipient, child withdrawals, recovery of
///   donations, policy and limits (in and out of the ceilings), pause and
///   resume, changing the root behind the vault's back and rearming it,
///   exitAll;
/// - the fee recipient going dark and back;
/// - strangers: donations, flushes of owed fees, returnReserves.
/// Each action keeps the ghost state the invariants read. What can only be
/// seen inside one call (a tariff above the mode's rate on what an execution
/// consumed, a withdrawal that paid other than exactly, owed fees that fell
/// without a flush) is counted there, and an invariant fails on the count.
contract VaultLedgerHandler is HarnessV3 {
    address internal constant SECOND_WALLET = address(0xC0FFEE);
    address internal constant THIRD_WALLET = address(0xBEEF);
    uint16 internal constant DOMINO_TARIFF_BPS = 400;

    uint64 public highestNonce;
    uint256[] public everMembers;
    mapping(uint256 => bool) public everRetired;

    // Rules broken inside one call; every invariant run expects zero.
    uint256 public nonceDrops;
    uint256 public owedLosses;
    uint256 public tariffBreaches;
    uint256 public inexactWithdrawals;
    uint256 public strayPayments;

    // Successes per action, so a campaign that only ever reverted cannot pass quietly.
    uint256 public compounds;
    uint256 public swappedCompounds;
    uint256 public mints;
    uint256 public withdrawals;
    uint256 public childWithdrawals;
    uint256 public recoveries;
    uint256 public flushes;
    uint256 public exits;
    uint256 public rearms;
    uint256 public settings;

    constructor() {
        setUp();
        _domino(3);
        highestNonce = vault.stateNonce();
        everMembers.push(rootId);
    }

    // ============================================================== ghosts

    /// Owed fees may only fall through a flush; the nonce never falls.
    modifier observed(bool flushing) {
        uint256 owed0 = vault.owedFees(address(token0));
        uint256 owed1 = vault.owedFees(address(token1));
        _;
        if (!flushing && (vault.owedFees(address(token0)) < owed0 || vault.owedFees(address(token1)) < owed1)) {
            ++owedLosses;
        }
        uint64 nonce = vault.stateNonce();
        if (nonce < highestNonce) ++nonceDrops;
        else highestNonce = nonce;
    }

    function memberCount() external view returns (uint256) {
        return everMembers.length;
    }

    function _pick(uint256 seed) internal view returns (uint256) {
        uint256[] memory members = vault.positions();
        return members[seed % members.length];
    }

    function _token(uint256 seed) internal view returns (MockToken) {
        return seed % 2 == 0 ? token0 : token1;
    }

    function _wallet(uint256 seed) internal pure returns (address) {
        uint256 pick = seed % 3;
        return pick == 0 ? OWNER : pick == 1 ? SECOND_WALLET : THIRD_WALLET;
    }

    // ================================================================ pool

    function poolActivity(uint256 seed, uint256 fee0, uint256 fee1) external observed(false) {
        _accrue(_pick(seed), fee0 % 1e12, fee1 % 1e12);
    }

    // ============================================================ operator

    /// What `tokenId` could spend in each token after its own collect.
    function _available(uint256 tokenId) internal view returns (uint256 amount0, uint256 amount1) {
        IDominoVaultLedger.Lot memory lot0 = vault.lot(tokenId, address(token0));
        IDominoVaultLedger.Lot memory lot1 = vault.lot(tokenId, address(token1));
        (,,,,,,,,,, uint128 owed0, uint128 owed1) = npm.positions(tokenId);
        amount0 = uint256(lot0.uncharged) + lot0.charged + owed0 + npm.pending0(tokenId);
        amount1 = uint256(lot1.uncharged) + lot1.charged + owed1 + npm.pending1(tokenId);
    }

    function _baseplan(uint8 action, uint256 target) internal view returns (Plan.PlanV1 memory p) {
        p.action = action;
        p.stateNonce = vault.stateNonce();
        p.deadline = uint64(block.timestamp + 300);
        p.target = target;
        p.amount0Max = type(uint128).max;
        p.amount1Max = type(uint128).max;
        p.minLiquidity = 1;
        p.collect = _one(target);
        p.budgets = new Plan.Budget[](1);
        p.budgets[0] = _budget(target);
        p.anchorEvidence = hex"a0";
    }

    /// The swap that leaves the source as much of one token as of the other
    /// (the unit model adds liquidity unit for unit), paid by a venue at
    /// exactly the anchor's price, with the strictest floor the vault could
    /// ask (no pool fee, the owner's slippage).
    function _balancingSwap(Plan.PlanV1 memory p, uint256 source) internal returns (bool swapped) {
        (uint256 a0, uint256 a1) = _available(source);
        uint160 price = anchor.anchorPrice();
        uint256 ratio = uint256(price) * price; // token1 per token0, X192
        bool zeroForOne = a0 > a1;
        // a0 - x = a1 + x * p, or a1 - y = a0 + y / p.
        uint256 amountIn =
            zeroForOne ? (a0 - a1) * (1 << 192) / ((1 << 192) + ratio) : (a1 - a0) * ratio / ((1 << 192) + ratio);
        if (amountIn < 1000 || amountIn > type(uint128).max) return false;
        if (zeroForOne) venue.setRate(ratio, 1 << 192);
        else venue.setRate(1 << 192, ratio);
        uint256 minOut = DominoSwapFloor.minimumOutput(amountIn, price, zeroForOne, 0, vault.limits().maxSlippageBps);
        _withSwap(p, source, zeroForOne, uint128(amountIn), uint128(minOut));
        swapped = true;
    }

    /// Runs `p` as the operator and checks the tariff: per token, the fee the
    /// recipient got or is owed is at most the mode's rate on what the
    /// execution took from uncharged lots (charged units are never charged
    /// again; principal is never in a lot).
    function _run(Plan.PlanV1 memory p, bool swapped) internal returns (bool ok) {
        uint256[2] memory gross;
        uint256[2] memory fee;
        MockToken[2] memory tokens = [token0, token1];
        uint256[2] memory collected;
        (collected[0], collected[1]) = _pending(p.collect);
        for (uint256 t; t < 2; ++t) {
            gross[t] = collected[t] + _uncharged(p.budgets, address(tokens[t]));
            fee[t] = tokens[t].balanceOf(RECIPIENT) + vault.owedFees(address(tokens[t]));
        }
        vm.prank(OPERATOR);
        try vault.execute(Plan.encode(p)) returns (bytes32 planHash) {
            ok = planHash != bytes32(0);
        } catch {
            return false;
        }
        for (uint256 t; t < 2; ++t) {
            gross[t] -= _uncharged(p.budgets, address(tokens[t]));
            fee[t] = tokens[t].balanceOf(RECIPIENT) + vault.owedFees(address(tokens[t])) - fee[t];
            // ceil(gross x rate): one rounding unit per budget.
            if (fee[t] * 10_000 > gross[t] * DOMINO_TARIFF_BPS + 9_999 * p.budgets.length) ++tariffBreaches;
        }
        if (ok && swapped) ++swappedCompounds;
    }

    function _pending(uint256[] memory ids) internal view returns (uint256 amount0, uint256 amount1) {
        for (uint256 i; i < ids.length; ++i) {
            (,,,,,,,,,, uint128 owed0, uint128 owed1) = npm.positions(ids[i]);
            amount0 += owed0 + npm.pending0(ids[i]);
            amount1 += owed1 + npm.pending1(ids[i]);
        }
    }

    function _uncharged(Plan.Budget[] memory budgets, address token) internal view returns (uint256 total) {
        for (uint256 i; i < budgets.length; ++i) {
            total += vault.lot(budgets[i].tokenId, token).uncharged;
        }
    }

    function compound(uint256 seed, bool swap) external observed(false) {
        uint256 target = _pick(seed);
        vm.warp(block.timestamp + vault.policy().minimumIntervalSeconds);
        Plan.PlanV1 memory p = _baseplan(Plan.ACTION_COMPOUND, target);
        bool swapped = swap && _balancingSwap(p, target);
        if (_run(p, swapped)) ++compounds;
    }

    /// A successor of a member with none, near its ceiling: the anchor 200
    /// ticks under the ceiling, the floor 600 under it and the first spaced
    /// tick at least 1.5x the ceiling price above it (the suite's geometry).
    function mintSuccessor(uint256 seed) external observed(false) {
        uint256 parent = _pick(seed);
        IDominoVaultLedger.Member memory m = vault.member(parent);
        if (m.successor != 0 || m.tickUpper + 4080 > TickMath.MAX_TICK) return;
        uint160 price = TickMath.getSqrtPriceAtTick(m.tickUpper - 200);
        anchor.set(price, price);
        vm.warp(block.timestamp + vault.policy().minimumIntervalSeconds);
        Plan.PlanV1 memory p = _baseplan(Plan.ACTION_MINT, parent);
        (p.tickLower, p.tickUpper) = (m.tickUpper - 600, m.tickUpper + 4080);
        uint256 next = npm.nextId();
        if (_run(p, false) && vault.member(next).active) {
            ++mints;
            everMembers.push(next);
        }
    }

    function operatorPauses() external observed(false) {
        vm.prank(OPERATOR);
        vault.pause();
    }

    // =============================================================== owner

    /// Exactly `amount`, to the named wallet, without any charge: the reserves
    /// fall by it, the wallet gains it and the owed fees do not move.
    function withdrawReserves(uint256 seed, uint256 amount, uint256 walletSeed) external observed(false) {
        MockToken token = _token(seed);
        uint256 reserves = vault.reserves(address(token));
        if (reserves == 0) return;
        amount = amount % reserves + 1;
        address wallet = _wallet(walletSeed);
        uint256 before = token.balanceOf(wallet);
        uint256 owed = vault.owedFees(address(token));
        vm.prank(OWNER);
        try vault.withdrawReserves(address(token), amount, wallet) {
            ++withdrawals;
            if (
                token.balanceOf(wallet) != before + amount || vault.reserves(address(token)) != reserves - amount
                    || vault.owedFees(address(token)) != owed
            ) ++inexactWithdrawals;
        } catch {}
    }

    function withdrawChild(uint256 seed) external observed(false) {
        uint256[] memory members = vault.positions();
        if (members.length < 2) return;
        uint256 child = members[1 + seed % (members.length - 1)];
        vm.prank(OWNER);
        try vault.withdrawChild(child) {
            ++childWithdrawals;
            everRetired[child] = true;
            if (npm.ownerOf(child) != OWNER) ++strayPayments;
        } catch {}
    }

    /// Recovers part of what the vault holds beyond its owed fees and reserves.
    function recoverDonation(uint256 seed, uint256 amount) external observed(false) {
        MockToken token = _token(seed);
        uint256 held = token.balanceOf(address(vault));
        uint256 claimed = vault.owedFees(address(token)) + vault.reserves(address(token));
        if (held <= claimed) return;
        amount = amount % (held - claimed) + 1;
        uint256 before = token.balanceOf(OWNER);
        vm.prank(OWNER);
        try vault.recoverToken(address(token), amount) {
            ++recoveries;
            if (token.balanceOf(OWNER) != before + amount) ++strayPayments;
        } catch {}
    }

    /// Any policy and limits, most of them past a ceiling; the vault keeps only valid ones.
    function setPolicyAndLimits(uint256 seed) external observed(false) {
        IDominoVault.Policy memory policy = IDominoVault.Policy({
            mode: DominoV2Types.MODE_DOMINO,
            triggerDistanceBps: uint16(seed % 2500),
            maxOverlapBps: uint16((seed >> 16) % 2500),
            minimumIntervalSeconds: uint32((seed >> 32) % 1200),
            maxPositions: uint8(1 + (seed >> 64) % 4)
        });
        IDominoVault.Limits memory limits = IDominoVault.Limits({
            maxSlippageBps: uint16((seed >> 80) % 1200),
            maxPriceImpactBps: uint16((seed >> 96) % 700),
            maxObservationAgeSeconds: uint32((seed >> 112) % 400),
            upsideBps: uint32(1 + (seed >> 128) % 10_000)
        });
        vm.startPrank(OWNER);
        try vault.setPolicy(policy) {
            ++settings;
        } catch {}
        try vault.setLimits(limits) {
            ++settings;
        } catch {}
        vm.stopPrank();
    }

    function pauseOrResume(bool pausing) external observed(false) {
        vm.prank(OWNER);
        if (pausing) vault.pause();
        else vault.resume();
    }

    /// The owner removes a unit of the root's liquidity through the Uniswap
    /// app: the next execution that touches the root disarms it.
    function ownerChangesRoot() external observed(false) {
        if (_liquidityOf(rootId) <= 1) return;
        _ownerChangesRoot();
    }

    function rearm() external observed(false) {
        vm.startPrank(OWNER);
        try vault.rearm(true) {
            ++rearms;
            if (vault.paused()) vault.resume();
        } catch {}
        vm.stopPrank();
    }

    /// Every child to the owner, every reserve the owner can receive paid out.
    function exitAll() external observed(false) {
        uint256[] memory members = vault.positions();
        vm.prank(OWNER);
        try vault.exitAll() {
            ++exits;
            for (uint256 i = 1; i < members.length; ++i) {
                everRetired[members[i]] = true;
                if (npm.ownerOf(members[i]) != OWNER) ++strayPayments;
            }
        } catch {}
    }

    function ownerCannotReceive(bool blocked) external observed(false) {
        token0.setBlocked(OWNER, blocked);
        token1.setBlocked(OWNER, blocked);
    }

    // ===================================================== recipient, others

    function recipientGoesDark(bool dark) external observed(false) {
        token0.setBlocked(RECIPIENT, dark);
        token1.setBlocked(RECIPIENT, dark);
    }

    function flush(uint256 seed) external observed(true) {
        MockToken token = _token(seed);
        uint256 owed = vault.owedFees(address(token));
        uint256 before = token.balanceOf(RECIPIENT);
        vm.prank(STRANGER);
        try vault.flushOwedFees(address(token)) returns (uint256 amount) {
            if (amount != 0) ++flushes;
            if (amount != owed || token.balanceOf(RECIPIENT) != before + owed || vault.owedFees(address(token)) != 0) {
                ++strayPayments;
            }
        } catch {
            if (vault.owedFees(address(token)) != owed) ++owedLosses;
        }
    }

    function donate(uint256 seed, uint256 amount) external observed(false) {
        _token(seed).mint(address(vault), amount % 1e12);
    }

    /// Anyone may return a closed vault's reserves; here the root is open, so
    /// nothing may move.
    function returnReserves() external observed(false) {
        uint256 held0 = token0.balanceOf(address(vault));
        uint256 held1 = token1.balanceOf(address(vault));
        vm.prank(STRANGER);
        try vault.returnReserves() {
            if (_liquidityOf(rootId) != 0) ++strayPayments;
        } catch {
            if (token0.balanceOf(address(vault)) != held0 || token1.balanceOf(address(vault)) != held1) ++strayPayments;
        }
    }

    // ================================================================ reads

    function vaultUnderTest() external view returns (address) {
        return address(vault);
    }

    function tokens() external view returns (address, address) {
        return (address(token0), address(token1));
    }

    function root() external view returns (uint256) {
        return rootId;
    }

    function positionManager() external view returns (MockV3PositionManager) {
        return npm;
    }
}

/// The vault's ledger under every sequence the handler can produce:
/// - I1: in each pool token, the vault holds at least what it owes the fee
///   recipient plus every reserve the owner may withdraw;
/// - I2: owed fees fall only through a flush, which pays exactly them;
/// - I3: no execution charges more than the mode's tariff on what it took
///   from uncharged lots, and owner withdrawals are exact and free;
/// - I12: the state nonce only grows;
/// - the sequence: the root first, active members only, at most the policy's
///   maximum, successor links between active members, retired children never
///   active again and held by the owner;
/// - the owner's limits stay inside the vault's ceilings (3 Oct 2026).
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
contract DominoV2VaultLedgerInvariantsTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    VaultLedgerHandler internal handler;
    ILedgerView internal vault;

    function setUp() public {
        handler = new VaultLedgerHandler();
        vault = ILedgerView(handler.vaultUnderTest());
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    /// The actions only: the handler also inherits the harness's setUp.
    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](17);
        selectors[0] = VaultLedgerHandler.poolActivity.selector;
        selectors[1] = VaultLedgerHandler.compound.selector;
        selectors[2] = VaultLedgerHandler.mintSuccessor.selector;
        selectors[3] = VaultLedgerHandler.operatorPauses.selector;
        selectors[4] = VaultLedgerHandler.withdrawReserves.selector;
        selectors[5] = VaultLedgerHandler.withdrawChild.selector;
        selectors[6] = VaultLedgerHandler.recoverDonation.selector;
        selectors[7] = VaultLedgerHandler.setPolicyAndLimits.selector;
        selectors[8] = VaultLedgerHandler.pauseOrResume.selector;
        selectors[9] = VaultLedgerHandler.ownerChangesRoot.selector;
        selectors[10] = VaultLedgerHandler.rearm.selector;
        selectors[11] = VaultLedgerHandler.exitAll.selector;
        selectors[12] = VaultLedgerHandler.ownerCannotReceive.selector;
        selectors[13] = VaultLedgerHandler.recipientGoesDark.selector;
        selectors[14] = VaultLedgerHandler.flush.selector;
        selectors[15] = VaultLedgerHandler.donate.selector;
        selectors[16] = VaultLedgerHandler.returnReserves.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    /// The handler is only evidence if its actions reach the vault: a scripted
    /// pass through the ledger-moving actions, each succeeding at least once,
    /// with every invariant checked after it.
    function testTheHandlerReachesEveryAction() public {
        handler.poolActivity(0, 4000, 4000);
        handler.compound(0, false);
        handler.poolActivity(0, 9000, 1000);
        handler.compound(0, true);
        // Unbalanced and unswapped: the add leaves token0 in the root's lots.
        handler.poolActivity(0, 9000, 1000);
        handler.compound(0, false);
        handler.recipientGoesDark(true);
        handler.poolActivity(0, 5000, 5000);
        handler.mintSuccessor(0);
        handler.recipientGoesDark(false);
        handler.flush(0);
        handler.poolActivity(1, 3000, 3000);
        handler.compound(1, false);
        handler.donate(1, 777);
        handler.recoverDonation(1, 100);
        handler.withdrawReserves(0, 50, 1);
        handler.setPolicyAndLimits(600 << 32 | 3 << 64);
        handler.withdrawChild(0);
        handler.ownerChangesRoot();
        handler.rearm();
        handler.exitAll();
        require(handler.compounds() >= 2 && handler.swappedCompounds() == 1, "compounds never reached the vault");
        require(handler.mints() == 1 && handler.childWithdrawals() == 1, "the successor path never reached the vault");
        require(
            handler.flushes() == 1 && handler.recoveries() == 1 && handler.withdrawals() == 1 && handler.rearms() == 1
                && handler.exits() == 1,
            "an owner or settlement action never reached the vault"
        );
        _all();
    }

    function _all() internal view {
        invariant_everyPoolTokenIsBacked();
        invariant_owedFeesFallOnlyByAFlush();
        invariant_noChargeAboveTheTariffAndOwnerWithdrawalsAreExact();
        invariant_theStateNonceOnlyGrows();
        invariant_theSequenceIsConsistent();
        invariant_theOwnersLimitsStayWithinTheCeilings();
    }

    function invariant_everyPoolTokenIsBacked() public view {
        (address token0, address token1) = handler.tokens();
        address[2] memory pair = [token0, token1];
        for (uint256 i; i < 2; ++i) {
            uint256 held = MockToken(pair[i]).balanceOf(address(vault));
            require(held >= vault.owedFees(pair[i]) + vault.reserves(pair[i]), "a pool token is not backed");
        }
    }

    function invariant_owedFeesFallOnlyByAFlush() public view {
        require(handler.owedLosses() == 0, "owed fees fell without a flush");
    }

    function invariant_noChargeAboveTheTariffAndOwnerWithdrawalsAreExact() public view {
        require(handler.tariffBreaches() == 0, "an execution charged more than its tariff");
        require(handler.inexactWithdrawals() == 0, "an owner withdrawal was not exact and free");
        require(handler.strayPayments() == 0, "a payment went other than where it should");
    }

    function invariant_theStateNonceOnlyGrows() public view {
        require(handler.nonceDrops() == 0 && vault.stateNonce() == handler.highestNonce(), "the nonce moved backwards");
    }

    function invariant_theSequenceIsConsistent() public view {
        uint256[] memory members = vault.positions();
        require(members.length >= 1 && members[0] == handler.root(), "the root is not first");
        require(members.length <= vault.policy().maxPositions, "more members than the policy allows");
        MockV3PositionManager npm = handler.positionManager();
        for (uint256 i; i < members.length; ++i) {
            IDominoVaultLedger.Member memory m = vault.member(members[i]);
            require(m.active && !handler.everRetired(members[i]), "a listed member is not active");
            if (i != 0) require(npm.ownerOf(members[i]) == address(vault), "a successor is not held by the vault");
            if (m.successor != 0) {
                IDominoVaultLedger.Member memory next = vault.member(m.successor);
                require(next.active && next.parent == members[i], "a successor link is broken");
            }
        }
        for (uint256 i; i < handler.memberCount(); ++i) {
            uint256 id = handler.everMembers(i);
            if (handler.everRetired(id)) require(!vault.member(id).active, "a retired child is active again");
        }
    }

    function invariant_theOwnersLimitsStayWithinTheCeilings() public view {
        IDominoVault.Limits memory limits = vault.limits();
        IDominoVault.Policy memory policy = vault.policy();
        require(
            limits.maxSlippageBps <= 1_000 && limits.maxPriceImpactBps <= 500 && limits.maxObservationAgeSeconds != 0
                && limits.maxObservationAgeSeconds <= 300 && policy.minimumIntervalSeconds >= 600,
            "a limit is past the vault's ceiling"
        );
    }
}

/// The vault surface the invariants read.
interface ILedgerView {
    function positions() external view returns (uint256[] memory);
    function member(uint256 tokenId) external view returns (IDominoVaultLedger.Member memory);
    function reserves(address token) external view returns (uint256);
    function owedFees(address token) external view returns (uint256);
    function stateNonce() external view returns (uint64);
    function policy() external view returns (IDominoVault.Policy memory);
    function limits() external view returns (IDominoVault.Limits memory);
}
