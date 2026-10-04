// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IUniswapV3PositionManagerMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IDominoAutoExit} from "../../../src/v2/interfaces/IDominoAutoExit.sol";
import {IDominoAutoExitExtension} from "../../../src/v2/interfaces/IDominoAutoExitExtension.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {IPositionNft} from "../zap/ZapTestKit.sol";
import {IIntegrationAutoExit} from "../integration/IntegrationInterfaces.sol";
import {IntegrationWorld} from "../integration/IntegrationWorld.sol";

/// The vault's side of the attack map on the wired world (IntegrationWorld:
/// Base's deployed Uniswap, the real registry, anchor, vault implementation,
/// executor and factory from their artifacts) with an auto-exit module at
/// the production parameters (observation age 300 s, TWAP floor 600 s):
/// - an exit while the vault is paused;
/// - exitAll, which disables the exit module (owner decision of 3 Oct 2026);
/// - the registry's global halt, at the module and at the vault.
/// Each test asserts the documented behaviour and cites the line of
/// docs/v2/F4_AUTO_EXIT.md ("F4") or docs/v2/F3_VAULT.md ("F3") that makes it one.
abstract contract AutoExitVaultAttacks is IntegrationWorld {
    uint32 internal constant EXIT_MAX_AGE = 300;
    uint32 internal constant EXIT_MIN_TWAP = 600;

    IIntegrationAutoExit internal autoExit;

    function setUp() public virtual override {
        super.setUp();
        autoExit = IIntegrationAutoExit(
            _deploy(
                abi.encodePacked(
                    vm.getCode("DominoAutoExit.sol:DominoAutoExit"),
                    abi.encode(_route(), address(priceAnchor), EXIT_MAX_AGE, EXIT_MIN_TWAP)
                )
            )
        );
        stack = _vaultStack(address(autoExit));
    }

    // ============================================================ helpers

    /// A stop 0.1% under the market's spot on the vault's root, receiving both, 10% slippage.
    function _stop(uint256 nonce) internal view returns (DominoV2Types.ExitMandate memory) {
        uint160 below = uint160(uint256(_spot(market)) * 999 / 1000);
        return DominoV2Types.ExitMandate(
            owner, address(vault), rootId, below, 0, DominoV2Types.RECEIVE_BOTH, address(0), 1000, uint64(clock + 1 days), nonce
        );
    }

    function _register(DominoV2Types.ExitMandate memory m) internal returns (bytes32 id) {
        bytes memory signature =
            _signature(OWNER_KEY, DominoV2Types.digest(autoExit.domainSeparator(), DominoV2Types.hashExitMandate(m)));
        vm.prank(RELAYER);
        id = autoExit.registerMandate(m, signature);
    }

    function _enable() internal {
        vm.prank(owner);
        vault.setExitModule(address(autoExit));
    }

    /// A real swap takes the market's pool under the stop.
    function _fallThrough(DominoV2Types.ExitMandate memory m) internal returns (uint160 price) {
        _trade(market, true, 1e20);
        price = _spot(market);
        _check(price <= m.triggerBelowSqrtPriceX96, "a real swap crosses the stop");
    }

    function _execution(uint160 price) internal view returns (IDominoAutoExit.Execution memory e) {
        e.anchorEvidence = _evidence(market.pool, price);
    }

    function _exit(bytes32 id, IDominoAutoExit.Execution memory e) internal returns (uint256, uint256) {
        vm.prank(OPERATOR);
        return autoExit.execute(id, e);
    }

    // ===================================================== pause (F3 point 9)

    /// A pause stops the vault's own automation, not an exit: executeExit
    /// ignores `paused` (F3 point 9: "the mandate is its own consent,
    /// revocable at any time, as is the module"; F4 line 113). Any registry
    /// operator may pause a vault (F3, A4), so a compromised operator cannot
    /// use a pause to hold an owner's stop back.
    function testAnExitRunsWhileTheVaultIsPausedEvenByAnOperator() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        DominoV2Types.ExitMandate memory m = _stop(1);
        bytes32 id = _register(m);
        _enable();
        vm.prank(OPERATOR);
        vault.pause();
        _check(vault.paused(), "the operator paused the vault");
        bytes memory plan = Plan.encode(_plan());
        vm.prank(OPERATOR);
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        vault.execute(plan);
        uint160 price = _fallThrough(m);
        IDominoAutoExit.Execution memory e = _execution(price);
        (uint256 delivered0, uint256 delivered1) = _exit(id, e);
        _eq(autoExit.mandateStatus(id), 3, "the stop fired on the paused vault");
        _eq(_liquidity(rootId), 0, "the whole root removed");
        _check(delivered0 > 0 && delivered1 > 0, "both currencies delivered");
        _check(vault.paused() && !vault.rootArmed(), "still paused, and out of automation");
    }

    // ==================================================== exitAll (F3, F4)

    /// exitAll ends the sequence: children and reserves to the owner, the root
    /// disarmed, automation paused and, since the owner's decision of 3 Oct
    /// 2026, the exit module disabled (IDominoVault: "Ends the sequence: ...
    /// the exit module is disabled"). Before it, the module stayed enabled and
    /// an active stop still removed the whole root after exitAll (liquidity
    /// the owner added afterwards included) and charged its 20 bps. Now the
    /// stop cannot fire (ExitModuleNotEnabled), the mandate stays active, not
    /// spent, and the root stays the owner's untouched.
    function testExitAllDisablesTheExitModuleSoAnActiveStopNoLongerFires() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        DominoV2Types.ExitMandate memory m = _stop(1);
        bytes32 id = _register(m);
        _enable();
        vm.recordLogs();
        vm.prank(owner);
        vault.exitAll();
        _eq(_count(vm.getRecordedLogs(), address(vault), keccak256("ExitModuleSet(address,uint64)")), 1, "ExitModuleSet(0)");
        _check(vault.paused() && !vault.rootArmed(), "exitAll stopped automation");
        _check(vault.exitModule() == address(0), "exitAll disabled the exit module");
        _eq(autoExit.mandateStatus(id), 1, "the stop is still active, not spent");
        uint128 atExitAll = _liquidity(rootId);
        if (_dex() == DominoV2Types.DEX_V3) {
            // The owner, believing the vault done with, adds to its root on Uniswap.
            vm.startPrank(owner);
            base.approve(manager, type(uint256).max);
            quote.approve(manager, type(uint256).max);
            IUniswapV3PositionManagerMinimal(manager).increaseLiquidity(
                IUniswapV3PositionManagerMinimal.IncreaseLiquidityParams(rootId, 5e19, 5e19, 0, 0, clock + 600)
            );
            vm.stopPrank();
        }
        uint128 held = _liquidity(rootId);
        _check(held >= atExitAll, "the owner's root");
        IDominoAutoExit.Execution memory e = _execution(_fallThrough(m));
        vm.expectRevert(IDominoAutoExitExtension.ExitModuleNotEnabled.selector);
        _exit(id, e);
        _eq(_liquidity(rootId), held, "the root untouched");
    }

    /// After exitAll the owner decides. Enabling the module again is consent
    /// anew: the stop, still active, fires on its next crossing and removes
    /// the root, on which the vault keeps the owner's approval.
    function testAfterExitAllEnablingTheModuleAgainLetsTheStopFire() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        DominoV2Types.ExitMandate memory m = _stop(1);
        bytes32 id = _register(m);
        _enable();
        vm.prank(owner);
        vault.exitAll();
        _check(IPositionNft(manager).getApproved(rootId) == address(vault), "the vault keeps its approval on the root");
        _enable();
        (uint256 delivered0, uint256 delivered1) = _exit(id, _execution(_fallThrough(m)));
        _eq(autoExit.mandateStatus(id), 3, "the stop fired once the owner enabled the module again");
        _eq(_liquidity(rootId), 0, "the whole root removed");
        _check(delivered0 > 0 && delivered1 > 0, "both currencies delivered");
    }

    /// Or revokeMandate ends the stop for good (F4 line 53): enabling the
    /// module afterwards cannot bring it back. Neither path needs the
    /// operator, the registry or the module's consent.
    function testAfterExitAllARevokeEndsTheStopForGood() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        DominoV2Types.ExitMandate memory m = _stop(1);
        bytes32 id = _register(m);
        _enable();
        vm.prank(owner);
        vault.exitAll();
        uint128 liquidity = _liquidity(rootId);
        IDominoAutoExit.Execution memory e = _execution(_fallThrough(m));
        vm.expectRevert(IDominoAutoExitExtension.ExitModuleNotEnabled.selector);
        _exit(id, e);
        _eq(autoExit.mandateStatus(id), 1, "paused with the module, not revoked");
        vm.prank(owner);
        autoExit.revokeMandate(id);
        _enable();
        vm.expectRevert(IDominoAutoExit.MandateNotActive.selector);
        _exit(id, e);
        _eq(_liquidity(rootId), liquidity, "the root untouched");
    }

    // ======================================== the global halt (F4 line 76)

    /// The halt stops exits at the module (AutomationHalted) and, behind it,
    /// at the vault (F3 point 9: "The registry's global halt stops it"): the
    /// enabled module itself calling executeExit is refused. The owner still
    /// revokes, still exits by hand (exitAll reads no registry, F3), and only a
    /// resume scheduled after the halt, a timelock later, lets a stop fire.
    function testTheGlobalHaltStopsAnExitAtTheModuleAndAtTheVault() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        DominoV2Types.ExitMandate memory m = _stop(1);
        bytes32 kept = _register(m);
        m.nonce = 2;
        bytes32 revoked = _register(m);
        _enable();
        IDominoAutoExit.Execution memory e = _execution(_fallThrough(m));
        vm.prank(GUARDIAN);
        registry.haltAutomation();
        vm.expectRevert(IDominoAutoExitExtension.AutomationHalted.selector);
        _exit(kept, e);
        bytes memory instruction = abi.encode(uint8(1), kept, address(autoExit), uint128(0), uint128(0));
        vm.prank(address(autoExit));
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        vault.executeExit(rootId, instruction);
        vm.prank(owner);
        autoExit.revokeMandate(revoked);
        _eq(autoExit.mandateStatus(kept), 1, "the halt spends nothing");
        _eq(autoExit.mandateStatus(revoked), 2, "the owner revokes during the halt");
        uint128 liquidity = _liquidity(rootId);
        _advance(1);
        _governed(DominoV2Types.REGISTRY_RESUME_AUTOMATION, "");
        _exit(kept, _execution(_spot(market)));
        _eq(autoExit.mandateStatus(kept), 3, "the stop fires after the resume");
        _check(liquidity > 0 && _liquidity(rootId) == 0, "the root removed only after the resume");
    }
}

contract AutoExitVaultAttacksV3Test is AutoExitVaultAttacks {
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
}

contract AutoExitVaultAttacksV4Test is AutoExitVaultAttacks {
    function _dex() internal pure override returns (uint8) {
        return DominoV2Types.DEX_V4;
    }

    function _zapArtifact() internal pure override returns (string memory) {
        return "DominoZapV4.sol:DominoZapV4";
    }

    function _vaultArtifact() internal pure override returns (string memory) {
        return "DominoV2VaultV4.sol:DominoV2VaultV4";
    }

    function _executorArtifact() internal pure override returns (string memory) {
        return "DominoV2VaultV4.sol:DominoV2VaultExecutorV4";
    }
}
