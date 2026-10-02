// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {VaultHarness, HarnessV3} from "./VaultHarness.sol";

/// An exit module that refuses any call: the vault never calls back into it.
contract SilentModule {
    fallback() external payable {
        revert("no callbacks");
    }
}

/// executeExit for F4's auto-exit module (docs/v2/F4_AUTO_EXIT.md, "The vault's
/// side"): consent through setExitModule, the module alone may call, F4's
/// version-1 instruction, everything the position holds to the module (its
/// principal and the fees it accrued), the position's own reserves to the
/// owner without any charge, the position out of automation. Exact amounts on
/// the v3 unit model; DominoV2VaultUniswapV4.t.sol exits on the deployed v4
/// managers.
abstract contract ExitSuite is VaultHarness {
    function _armed() internal returns (bytes memory instruction) {
        _simple();
        vm.prank(OWNER);
        vault.setExitModule(EXIT_MODULE);
        instruction = _exitInstruction(0, 0);
    }

    /// A compound of 1000 + 1060 adds 980, each side's gross 999 (cut 19), and
    /// leaves the root lots of 1 token0 and 61 token1.
    function _withReserves() internal returns (bytes memory instruction) {
        instruction = _armed();
        _accrue(rootId, 1000, 1060);
        _execute(_plan());
        (uint128 left0,) = _lot(rootId, address(token0));
        (uint128 left1,) = _lot(rootId, address(token1));
        _eq(left0, 1, "the root's reserve0");
        _eq(left1, 61, "the root's reserve1");
    }

    function testExitNeedsTheOwnersConsent() public {
        _simple();
        bytes memory instruction = _exitInstruction(0, 0);
        vm.prank(EXIT_MODULE);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.executeExit(rootId, instruction);
        vm.prank(OWNER);
        vault.setExitModule(EXIT_MODULE);
        vm.prank(STRANGER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.executeExit(rootId, instruction);
        vm.prank(OPERATOR);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.executeExit(rootId, instruction);
        vm.prank(OWNER);
        vault.setExitModule(address(0));
        vm.prank(EXIT_MODULE);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.executeExit(rootId, instruction);
    }

    /// Principal and the position's accrued fees to the module; the root's
    /// reserve to the owner; no tariff on any of it.
    function testRootExitDeliversThePositionToTheModuleAndItsReservesToTheOwner() public {
        bytes memory instruction = _withReserves();
        _accrue(rootId, 100, 50);
        uint256 principal = ROOT_LIQUIDITY + 980;
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.ReservesWithdrawn(address(token0), 1, 4);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.ReservesWithdrawn(address(token1), 61, 4);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(6, 4);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.ExitExecuted(EXIT_MODULE, rootId, principal + 100, principal + 50, 4);
        vm.prank(EXIT_MODULE);
        (uint256 amount0, uint256 amount1) = vault.executeExit(rootId, instruction);
        _eq(amount0, principal + 100, "amount0");
        _eq(amount1, principal + 50, "amount1");
        _eq(token0.balanceOf(EXIT_MODULE), principal + 100, "principal and fees0 to the module");
        _eq(token1.balanceOf(EXIT_MODULE), principal + 50, "principal and fees1 to the module");
        _eq(token0.balanceOf(OWNER), 1, "reserve0 to the owner");
        _eq(token1.balanceOf(OWNER), 61, "reserve1 to the owner");
        _eq(token0.balanceOf(RECIPIENT), 19, "only the compound's tariff");
        _eq(token1.balanceOf(RECIPIENT), 19, "only the compound's tariff");
        _eq(_liquidityOf(rootId), 0, "emptied");
        _true(_ownerOfNft(rootId) == OWNER, "the empty root stays in the wallet");
        _true(!vault.rootArmed(), "disarmed");
        _eq(vault.reserves(address(token0)) + vault.reserves(address(token1)), 0, "nothing left");
    }

    function testExitRefusesAnotherInstructionVersion() public {
        _armed();
        bytes memory instruction = abi.encode(uint8(2), keccak256("mandate"), EXIT_MODULE, uint128(0), uint128(0));
        vm.prank(EXIT_MODULE);
        vm.expectRevert(DominoV2VaultStorage.InvalidInstruction.selector);
        vault.executeExit(rootId, instruction);
    }

    function testExitPaysOnlyTheCallingModule() public {
        _armed();
        bytes memory instruction = abi.encode(uint8(1), keccak256("mandate"), STRANGER, uint128(0), uint128(0));
        vm.prank(EXIT_MODULE);
        vm.expectRevert(DominoV2VaultStorage.InvalidInstruction.selector);
        vault.executeExit(rootId, instruction);
    }

    function testExitHonoursTheRemovalMinimums() public {
        _armed();
        bytes memory tooMuch = _exitInstruction(uint128(ROOT_LIQUIDITY + 1), 0);
        vm.prank(EXIT_MODULE);
        vm.expectRevert();
        vault.executeExit(rootId, tooMuch);
        bytes memory exact = _exitInstruction(uint128(ROOT_LIQUIDITY), uint128(ROOT_LIQUIDITY));
        vm.prank(EXIT_MODULE);
        vault.executeExit(rootId, exact);
    }

    function testExitStopsUnderTheGlobalHalt() public {
        bytes memory instruction = _armed();
        registry.setHalted(true);
        vm.prank(EXIT_MODULE);
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        vault.executeExit(rootId, instruction);
    }

    function testExitOnlyOfAMember() public {
        bytes memory instruction = _armed();
        vm.prank(EXIT_MODULE);
        vm.expectRevert(DominoV2VaultStorage.InvalidPosition.selector);
        vault.executeExit(rootId + 50, instruction);
    }

    function testExitOfTheRootNeedsItsApproval() public {
        bytes memory instruction = _armed();
        _approveNft(OWNER, rootId, STRANGER);
        vm.prank(EXIT_MODULE);
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        vault.executeExit(rootId, instruction);
    }

    /// The mandate is its own consent: pause stops automation, not exits, and
    /// a root the owner touched still exits.
    function testExitIgnoresPauseAndAnOwnerChange() public {
        bytes memory instruction = _armed();
        vm.prank(OWNER);
        vault.pause();
        _ownerChangesRoot();
        vm.prank(EXIT_MODULE);
        vault.executeExit(rootId, instruction);
        _eq(_liquidityOf(rootId), 0, "emptied");
    }

    function testExitKeepsReservesTheOwnerCannotReceive() public {
        bytes memory instruction = _withReserves();
        token1.setBlocked(OWNER, true);
        vm.prank(EXIT_MODULE);
        vault.executeExit(rootId, instruction);
        _eq(vault.idleReserves(address(token1)), 61, "kept idle");
        _eq(token1.balanceOf(EXIT_MODULE), ROOT_LIQUIDITY + 980, "the exit went through");
    }

    /// Tokens move to the module by transfer; nothing calls into it.
    function testTheVaultNeverCallsBackIntoTheModule() public {
        bytes memory instruction = _withReserves();
        vm.etch(EXIT_MODULE, address(new SilentModule()).code);
        vm.prank(EXIT_MODULE);
        vault.executeExit(rootId, instruction);
        _eq(token0.balanceOf(EXIT_MODULE), ROOT_LIQUIDITY + 980, "delivered");
    }

    function testMalformedInstructionIsRefused() public {
        _armed();
        vm.prank(EXIT_MODULE);
        vm.expectRevert();
        vault.executeExit(rootId, hex"01");
    }
}

contract DominoV2VaultExitV3Test is ExitSuite, HarnessV3 {}
