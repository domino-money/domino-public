// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IPermit2Signature} from "../../../src/v2/external/IPermit2Signature.sol";
import {IUniswapV3PositionManagerMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IDominoAutoExit} from "../../../src/v2/interfaces/IDominoAutoExit.sol";
import {IDominoAutoExitExtension} from "../../../src/v2/interfaces/IDominoAutoExitExtension.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {IIntegrationAutoExit, IIntegrationVault} from "../integration/IntegrationInterfaces.sol";
import {IntegrationWorld} from "../integration/IntegrationWorld.sol";
import {IPermit2Views, IPositionNft, ZapVm} from "../zap/ZapTestKit.sol";

/// The cheatcode the world's ZapVm lacks.
interface ExpectCallVm {
    function expectCall(address callee, bytes calldata data, uint64 count) external;
}

/// @notice Attack map item 13 where the registry meets the products, on the
/// wired v3 world (docs/v2/INTEGRATION_TESTS.md): the real registry, anchor,
/// zap, vault and auto-exit module over the Uniswap bytecode deployed on
/// Base, governance through the registry's own timelock (one hour here).
///
/// - A charge-currency rank change between an S1 intent's signature and its
///   execution: the zap's FeeMismatch reverts the action rather than charge
///   in another currency (DominoFeeRules.requireAssistedSwapTerms; F1b doc:
///   "requireAssistedSwapTerms reverts FeeMismatch otherwise, before anything
///   moves"). The signed terms bind the token, not the rank.
/// - The guardian's halt stops the vault's operator executions and the
///   auto-exit module, until a resume scheduled after the latest halt runs;
///   under it the owner still exits everything.
///
/// The currencies: `quote` is rank 1, `second` rank 2, `base` unranked.
/// `inverse` is the (quote, second) market, whose routes hold both ranks.
contract DominoWiredRegistryAttacksTest is IntegrationWorld {
    ExpectCallVm internal constant calls = ExpectCallVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    IIntegrationAutoExit internal autoExit;

    function _dex() internal pure override returns (uint8) {
        return DominoV2Types.DEX_V3;
    }

    function _zapArtifact() internal pure override returns (string memory) {
        return "DominoZapV3.sol:DominoZapV3";
    }

    function _vaultArtifact() internal pure override returns (string memory) {
        return "DominoV2VaultV3.sol:DominoV2VaultV3";
    }

    function _executorArtifact() internal pure override returns (string memory) {
        return "DominoV2VaultV3.sol:DominoV2VaultExecutorV3";
    }

    function setUp() public override {
        super.setUp();
        autoExit = IIntegrationAutoExit(
            _deploy(
                abi.encodePacked(
                    vm.getCode("DominoAutoExit.sol:DominoAutoExit"),
                    abi.encode(_route(), address(priceAnchor), ANCHOR_MAX_AGE, ANCHOR_MIN_TWAP)
                )
            )
        );
        stack = _vaultStack(address(autoExit));
    }

    // ============================================================= helpers

    function _rank(address token, uint8 rank) internal {
        _governed(DominoV2Types.REGISTRY_CHARGE_CURRENCY, abi.encode(token, rank));
    }

    /// The owner's create on `inverse` from `second` alone, half swapped into
    /// quote through the deep pool: the rule picks quote (rank 1, output)
    /// over second (rank 2, input). Valid for three days.
    function _createFromSecond(uint256 nonce, address feeToken)
        internal
        view
        returns (IDominoPositionActions.CreatePlan memory p)
    {
        p.inputs = _inputs(address(second), 10e18);
        p.legs = _oneLeg(_deepLeg(inverse, address(second), address(quote), 5e18));
        p.intent = _intent(DominoV2Types.ACTION_CREATE, inverse.pool, 0, -600, 600, 1, p.legs, feeToken, owner, nonce);
        p.intent.deadline = uint64(clock + 3 days);
        p.amount0Max = type(uint128).max;
        p.amount1Max = type(uint128).max;
    }

    function _same(uint256[3] memory a, uint256[3] memory b, string memory what) internal pure {
        for (uint256 i; i < 3; ++i) {
            _eq(a[i], b[i], what);
        }
    }

    /// Triggers 0.1% either side of the market's price, for three days.
    function _bothTriggers() internal view returns (DominoV2Types.ExitMandate memory) {
        uint160 price = _spot(market);
        return DominoV2Types.ExitMandate(
            owner,
            address(vault),
            rootId,
            uint160(uint256(price) * 999 / 1000),
            uint160(uint256(price) * 1001 / 1000),
            DominoV2Types.RECEIVE_BOTH,
            address(0),
            1000,
            uint64(clock + 3 days),
            1
        );
    }

    function _register(DominoV2Types.ExitMandate memory m) internal returns (bytes32 id) {
        bytes memory signature =
            _signature(OWNER_KEY, DominoV2Types.digest(autoExit.domainSeparator(), DominoV2Types.hashExitMandate(m)));
        vm.prank(RELAYER);
        id = autoExit.registerMandate(m, signature);
    }

    function _exitNow(bytes32 id) internal returns (bool ok, bytes memory out) {
        IDominoAutoExit.Execution memory e;
        e.anchorEvidence = _evidence(market.pool, _spot(market));
        e.amount0MinRemoved = 1;
        e.amount1MinRemoved = 1;
        vm.prank(OPERATOR);
        (ok, out) = address(autoExit).call(abi.encodeCall(IDominoAutoExit.execute, (id, e)));
    }

    /// A vault on `main` with its owner's mandate (both triggers) and the
    /// auto-exit module enabled, and trading fees on its root.
    function _automatedVault() internal returns (bytes32 mandate) {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        mandate = _register(_bothTriggers());
        vm.prank(owner);
        vault.setExitModule(address(autoExit));
        _accrueFees(main);
    }

    /// A real swap lifts the pool past the mandate's upper trigger.
    function _crossUpper() internal {
        uint160 trigger = uint160(uint256(_spot(market)) * 1001 / 1000);
        _trade(market, false, 1e20);
        _check(_spot(market) >= trigger, "the pool crossed the upper trigger");
    }

    // ============================================== charge-currency ranks, S1

    /// The owner signs a Permit2-witnessed create whose fee terms name quote,
    /// the rule's selection at signing. Governance then moves quote below
    /// second through the timelock. The relayer's submission reverts with
    /// FeeMismatch: nothing is pulled, nothing charged, the Permit2 nonce
    /// stays unspent. Once governance restores the rank, the same signature
    /// executes with exactly the signed terms.
    function testARankChangeAfterSigningRevertsTheSignedCreate() public {
        IDominoPositionActions.CreatePlan memory p = _createFromSecond(41, address(quote));
        IPermit2Signature.PermitBatchTransferFrom memory permit = _permit(p.inputs, 41, clock + 3 days);
        bytes memory signature = _signature(OWNER_KEY, _permitDigest(permit, address(zap), p.intent));
        _rank(address(quote), 3);
        uint256[3] memory ownerBefore = _holdings(owner);
        uint256[3] memory feesBefore = _holdings(FEE_RECIPIENT);
        vm.expectRevert(IDominoPositionActions.FeeMismatch.selector);
        vm.prank(RELAYER);
        zap.createWithPermit(p, permit, signature);
        _same(_holdings(owner), ownerBefore, "nothing was pulled from the owner");
        _same(_holdings(FEE_RECIPIENT), feesBefore, "nothing was charged in any currency");
        _eq(IPermit2Views(PERMIT2).nonceBitmap(owner, 0) & (1 << 41), 0, "the permit nonce is unspent");
        _cleanZap();

        _rank(address(quote), 1);
        vm.recordLogs();
        vm.prank(RELAYER);
        IDominoPositionActions.ActionResult memory r = zap.createWithPermit(p, permit, signature);
        (,, uint256 delivered) =
            abi.decode(_first(vm.getRecordedLogs(), address(zap), LEG_EXECUTED).data, (address, uint256, uint256));
        _check(r.feeToken == address(quote), "charged in the signed currency");
        _eq(r.feeAmount, delivered * 65 / 10_000, "65 bps of the measured quote output");
        _eq(quote.balanceOf(FEE_RECIPIENT) - feesBefore[1], r.feeAmount, "delivered in quote");
        _eq(second.balanceOf(FEE_RECIPIENT), feesBefore[2], "nothing in second");
        _cleanZap();
    }

    /// The same race in one block: governance's execution of the rank change
    /// lands before the owner's own create (no signature, msg.sender pays).
    /// The create reverts instead of charging in second; paying in second
    /// takes the owner's new terms.
    function testARankChangeLandingFirstInTheBlockRevertsTheCreate() public {
        IDominoPositionActions.CreatePlan memory p = _createFromSecond(0, address(quote));
        bytes32 change =
            registry.scheduleChange(DominoV2Types.REGISTRY_CHARGE_CURRENCY, abi.encode(address(quote), uint8(3)));
        _advance(TIMELOCK);
        registry.executeChange(change);
        uint256[3] memory ownerBefore = _holdings(owner);
        vm.expectRevert(IDominoPositionActions.FeeMismatch.selector);
        vm.prank(owner);
        zap.create(p);
        _same(_holdings(owner), ownerBefore, "a mismatched create moves nothing");
        p.intent.feeToken = address(second);
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory r = zap.create(p);
        _check(r.feeToken == address(second), "the owner's new terms");
        _eq(r.feeAmount, uint256(5e18) * 65 / 10_000, "65 bps of the second it spent");
        _cleanZap();
    }

    /// A relayed exit converting second into quote, signed while quote led:
    /// after the rank change it reverts and removes nothing, its relay nonce
    /// unspent. The owner's plain exit (no swap, so no fee terms) never reads
    /// a rank and goes through. With the rank restored the relayed exit runs
    /// as signed.
    function testARankChangeRevertsARelayedConvertingExitButNeverAPlainOne() public {
        uint256 id = _mintPosition(inverse, -600, 600, 0);
        vm.prank(owner);
        IPositionNft(manager).approve(address(zap), id);
        uint128 liquidity = _liquidity(id);
        IDominoPositionActions.ExitPlan memory converting;
        converting.legs = _oneLeg(_deepLeg(inverse, address(second), address(quote), 1e18));
        converting.intent =
            _intent(DominoV2Types.ACTION_EXIT, inverse.pool, id, -600, 600, 0, converting.legs, address(quote), owner, 51);
        converting.intent.deadline = uint64(clock + 3 days);
        converting.liquidityToRemove = liquidity / 2;
        bytes memory signature = _signature(OWNER_KEY, _relayedDigest(address(zap), _relayedExit(converting)));
        _rank(address(quote), 3);
        vm.expectRevert(IDominoPositionActions.FeeMismatch.selector);
        vm.prank(RELAYER);
        zap.exitWithSignature(converting, signature);
        _eq(_liquidity(id), liquidity, "a mismatched exit removes nothing");
        _eq(zap.nonceBitmap(owner, 0), 0, "the relay nonce is unspent");

        IDominoPositionActions.ExitPlan memory plain;
        plain.legs = _noLegs();
        plain.intent = _intent(DominoV2Types.ACTION_EXIT, inverse.pool, id, -600, 600, 0, plain.legs, address(0), owner, 0);
        plain.intent.deadline = uint64(clock + 3 days);
        plain.liquidityToRemove = liquidity / 4;
        uint256[3] memory ownerBefore = _holdings(owner);
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory taken = zap.exit(plain);
        uint256[3] memory ownerNow = _holdings(owner);
        _check(taken.amount0 > 0 && taken.amount1 > 0 && taken.feeAmount == 0, "the plain exit paid both, no fee");
        _eq(ownerNow[1] - ownerBefore[1], taken.amount0, "quote (currency0) to the owner");
        _eq(ownerNow[2] - ownerBefore[2], taken.amount1, "second (currency1) to the owner");

        _rank(address(quote), 1);
        vm.prank(RELAYER);
        IDominoPositionActions.ActionResult memory exited = zap.exitWithSignature(converting, signature);
        _check(exited.feeToken == address(quote) && exited.feeAmount > 0, "the signed terms, once the rank is back");
        _cleanZap();
    }

    // ====================================================== the global halt

    /// The guardian halts: the operator's compound fails AutomationUnavailable
    /// and the auto-exit AutomationHalted, with the pool past the trigger; the
    /// mandate stays active and the root untouched. A resume queued before the
    /// halt is void, one queued in the second of a second halt too; only one
    /// queued after the latest halt lifts it, a full timelock later, and both
    /// automations then run.
    function testTheHaltStopsBothAutomationsUntilAResumeScheduledAfterIt() public {
        bytes32 mandate = _automatedVault();
        bytes32 early = registry.scheduleChange(DominoV2Types.REGISTRY_RESUME_AUTOMATION, "");
        _advance(1);
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        uint128 liquidity = _liquidity(rootId);
        Plan.PlanV1 memory compound = _plan();
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        _execute(compound);
        _crossUpper();
        (bool ok, bytes memory out) = _exitNow(mandate);
        _check(!ok && bytes4(out) == IDominoAutoExitExtension.AutomationHalted.selector, "the auto-exit ran halted");
        _check(autoExit.mandateStatus(mandate) == 1 && _liquidity(rootId) == liquidity, "nothing consumed or moved");

        _advance(TIMELOCK);
        vm.expectRevert(IDominoRegistry.InvalidChange.selector);
        registry.executeChange(early);
        bytes32 between = registry.scheduleChange(DominoV2Types.REGISTRY_RESUME_AUTOMATION, "");
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        _advance(1);
        bytes32 fresh = registry.scheduleChange(DominoV2Types.REGISTRY_RESUME_AUTOMATION, "");
        _advance(TIMELOCK);
        vm.expectRevert(IDominoRegistry.InvalidChange.selector);
        registry.executeChange(between);
        compound = _plan();
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        _execute(compound);
        registry.executeChange(fresh);

        _execute(_plan());
        _check(_liquidity(rootId) > liquidity, "the compound runs once the halt is lifted");
        (ok,) = _exitNow(mandate);
        _check(ok && autoExit.mandateStatus(mandate) == 3 && _liquidity(rootId) == 0, "and so does the auto-exit");
        _ledgerBalanced();
    }

    /// Under the real registry's halt the owner still revokes its mandate,
    /// withdraws reserves, takes liquidity out through the zap (a plain exit
    /// reads no rank), has the rest of the reserves returned once it closes
    /// the root on Uniswap, and ends the sequence: everything is the owner's.
    function testUnderTheHaltTheOwnerStillExitsEverything() public {
        bytes32 mandate = _automatedVault();
        Plan.PlanV1 memory p = _plan();
        p.budgets[0] = Plan.Budget(rootId, 1e9, 1e9);
        _execute(p);
        (address c0, address c1) = (market.pool.currency0, market.pool.currency1);
        uint256 reserve0 = vault.reserves(c0);
        uint256 reserve1 = vault.reserves(c1);
        _check(reserve0 > 0 && reserve1 > 0, "reserves in both currencies");
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        _check(registry.automationHalted(), "halted");

        uint256 owner0 = _balance(c0, owner);
        uint256 owner1 = _balance(c1, owner);
        vm.startPrank(owner);
        autoExit.revokeMandate(mandate);
        vault.withdrawReserves(c0, reserve0 / 2, owner);
        IPositionNft(manager).approve(address(zap), rootId);
        vm.stopPrank();
        IDominoPositionActions.ExitPlan memory plain;
        plain.legs = _noLegs();
        plain.intent = _intent(DominoV2Types.ACTION_EXIT, main.pool, rootId, -600, 600, 0, plain.legs, address(0), owner, 0);
        plain.liquidityToRemove = _liquidity(rootId) / 2;
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory taken = zap.exit(plain);
        uint128 left = _liquidity(rootId);
        vm.startPrank(owner);
        IUniswapV3PositionManagerMinimal(manager).decreaseLiquidity(
            IUniswapV3PositionManagerMinimal.DecreaseLiquidityParams(rootId, left, 0, 0, clock)
        );
        (uint256 closed0, uint256 closed1) = IUniswapV3PositionManagerMinimal(manager).collect(
            IUniswapV3PositionManagerMinimal.CollectParams(rootId, owner, type(uint128).max, type(uint128).max)
        );
        vm.stopPrank();
        vm.prank(STRANGER);
        (uint256 paid0, uint256 paid1) = vault.returnReserves();
        vm.prank(owner);
        vault.exitAll();

        _eq(autoExit.mandateStatus(mandate), 2, "revoked under the halt");
        _eq(paid0, reserve0 - reserve0 / 2, "the rest of currency0 returned");
        _eq(paid1, reserve1, "all of currency1 returned");
        _eq(_balance(c0, owner) - owner0, reserve0 + taken.amount0 + closed0, "currency0: reserves and the position");
        _eq(_balance(c1, owner) - owner1, reserve1 + taken.amount1 + closed1, "currency1: reserves and the position");
        _eq(vault.reserves(c0) + vault.reserves(c1), 0, "nothing left in the vault for the owner");
        _check(vault.paused() && !vault.rootArmed() && IPositionNft(manager).ownerOf(rootId) == owner, "sequence ended");
        _check(registry.automationHalted(), "all of it while halted");
        _ledgerBalanced();
    }

    /// F3 doc, decision 2: a vault's quote is "the pool's best-ranked charge
    /// currency at creation", fixed for the sequence's life. A later rank
    /// change does not turn an existing vault's prices upside down; only a
    /// vault created after it reads the pool the other way.
    function testARankChangeNeverFlipsAnExistingVaultsQuote() public {
        _createVault(inverse, DominoV2Types.MODE_DOMINO, -600, 600);
        _check(vault.quoteCurrency() == address(quote), "quote leads at creation");
        _rank(address(quote), 3);
        _check(vault.quoteCurrency() == address(quote), "the existing vault keeps its quote");
        (IIntegrationVault later,) = _openVault(stack, inverse, DominoV2Types.MODE_DOMINO, -600, 600);
        _check(later.quoteCurrency() == address(second), "a vault created after the change reads second");
    }

    /// With the registry gone (every call to it reverts), automation fails
    /// closed, and the owner still leaves all three products without a
    /// single call to it: the auto-exit mandate's revocation, the vault's
    /// withdrawal, return and exitAll, and the zap's plain exit (no swap, so
    /// no fee terms and no rank to read).
    function testWithTheRegistryGoneTheOwnerStillExitsWithoutCallingIt() public {
        bytes32 mandate = _automatedVault();
        Plan.PlanV1 memory p = _plan();
        p.budgets[0] = Plan.Budget(rootId, 1e9, 1e9);
        _execute(p);
        (address c0, address c1) = (market.pool.currency0, market.pool.currency1);
        uint256 reserve0 = vault.reserves(c0);
        uint256 reserve1 = vault.reserves(c1);
        Plan.PlanV1 memory next = _plan();
        _crossUpper();
        vm.etch(address(registry), hex"5f5ffd");
        vm.expectRevert();
        _execute(next);
        (bool ok,) = _exitNow(mandate);
        _check(!ok && autoExit.mandateStatus(mandate) == 1, "the auto-exit fails closed");

        calls.expectCall(address(registry), "", 0);
        uint256 owner0 = _balance(c0, owner);
        uint256 owner1 = _balance(c1, owner);
        vm.startPrank(owner);
        autoExit.revokeMandate(mandate);
        vault.withdrawReserves(c1, reserve1, owner);
        IPositionNft(manager).approve(address(zap), rootId);
        vm.stopPrank();
        IDominoPositionActions.ExitPlan memory plain;
        plain.legs = _noLegs();
        plain.intent = _intent(DominoV2Types.ACTION_EXIT, main.pool, rootId, -600, 600, 0, plain.legs, address(0), owner, 0);
        plain.liquidityToRemove = _liquidity(rootId);
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory taken = zap.exit(plain);
        vm.prank(STRANGER);
        (uint256 paid0,) = vault.returnReserves();
        vm.prank(owner);
        vault.exitAll();
        _eq(autoExit.mandateStatus(mandate), 2, "revoked");
        _eq(paid0, reserve0, "currency0 reserves returned");
        _eq(_balance(c0, owner) - owner0, reserve0 + taken.amount0, "currency0 to the owner");
        _eq(_balance(c1, owner) - owner1, reserve1 + taken.amount1, "currency1 to the owner");
        _check(_liquidity(rootId) == 0 && vault.reserves(c0) + vault.reserves(c1) == 0, "nothing left behind");
        _ledgerBalanced();
    }

    /// The owner's ExitMandate signs no fee currency: F4_AUTO_EXIT.md, "The
    /// fee": the token "follows the charge-currency rule of F0, with ranks
    /// from IDominoRegistry.chargeCurrencyRank", read at execution. So a rank
    /// change between a mandate's signature and its execution moves the 0.2%
    /// into the other currency (still 20 bps of the position valued at the
    /// anchor). Accepted design, and the difference from S1, whose intent
    /// signs its feeToken: two identical positions exit at the same price,
    /// one before and one after governance moves quote below second.
    function testARankChangeMovesTheAutoExitFeeWhichNoMandateSigns() public {
        _createVault(inverse, DominoV2Types.MODE_SIMPLE, -600, 600);
        bytes32 first = _register(_bothTriggers());
        vm.prank(owner);
        vault.setExitModule(address(autoExit));
        (IIntegrationVault twin, uint256 twinRoot) = _openVault(stack, inverse, DominoV2Types.MODE_SIMPLE, -600, 600);
        DominoV2Types.ExitMandate memory m = _bothTriggers();
        (m.vault, m.tokenId, m.nonce) = (address(twin), twinRoot, 2);
        bytes32 second_ = _register(m);
        vm.prank(owner);
        twin.setExitModule(address(autoExit));
        _crossUpper();

        vm.recordLogs();
        (bool ok,) = _exitNow(first);
        _check(ok, "the first mandate executed");
        address before = _autoExitFeeToken(vm.getRecordedLogs());
        _rank(address(quote), 3);
        vm.recordLogs();
        (ok,) = _exitNow(second_);
        _check(ok, "the second mandate executed");
        address afterwards = _autoExitFeeToken(vm.getRecordedLogs());
        _check(before == address(quote), "with quote leading, the 0.2% is in quote");
        _check(afterwards == address(second), "after the rank change, the same mandate shape pays in second");
    }

    /// The token of the auto-exit's only FeeCharged.
    function _autoExitFeeToken(ZapVm.Log[] memory logs) internal view returns (address token) {
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(autoExit) || logs[i].topics[0] != FEE_CHARGED) continue;
            _eq(uint256(logs[i].topics[1]), DominoV2Types.FEE_KIND_AUTO_EXIT, "the auto-exit tariff");
            token = address(uint160(uint256(logs[i].topics[2])));
            ++found;
        }
        _eq(found, 1, "one tariff, in one currency");
    }
}
