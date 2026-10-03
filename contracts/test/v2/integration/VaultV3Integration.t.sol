// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IUniswapV3PositionManagerMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {IDominoVaultLedger} from "../../../src/v2/interfaces/IDominoVaultLedger.sol";
import {VaultJourney} from "./VaultJourney.sol";

contract VaultV3IntegrationTest is VaultJourney {
    function _dex() internal pure override returns (uint8) {
        return 3;
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

    function _checkpoint() internal view returns (IDominoVaultLedger.RootCheckpoint memory c) {
        (,,,,,,, c.liquidity, c.feeGrowthInside0LastX128, c.feeGrowthInside1LastX128, c.tokensOwed0, c.tokensOwed1) =
            IUniswapV3PositionManagerMinimal(manager).positions(rootId);
    }

    /// On v3 anyone may add to a position: a stranger's dust disarms the root
    /// without spending, an operator may rearm it once for that addition, and
    /// never after the owner's own change.
    function testV3StrangerDustAdditionAllowsOnlyLimitedOperatorRearm() public {
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        IDominoVaultLedger.RootCheckpoint memory prior = _checkpoint();
        vm.startPrank(STRANGER);
        base.approve(manager, 10);
        quote.approve(manager, 10);
        IUniswapV3PositionManagerMinimal(manager).increaseLiquidity(
            IUniswapV3PositionManagerMinimal.IncreaseLiquidityParams(rootId, 10, 10, 0, 0, clock)
        );
        vm.stopPrank();
        uint256 reserves = vault.reserves(address(base)) + vault.reserves(address(quote));
        _check(_execute(_plan()) == bytes32(0) && !vault.rootArmed(), "the dust changed the checkpoint: disarmed");
        _eq(vault.reserves(address(base)) + vault.reserves(address(quote)), reserves, "nothing spent");
        vm.prank(OPERATOR);
        vault.operatorRearm(prior);
        _check(vault.rootArmed(), "rearmed for an addition only");
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        vm.prank(OPERATOR);
        vault.operatorRearm(prior);
        // The owner's own decrease is not an addition: only the owner rearms.
        IDominoVaultLedger.RootCheckpoint memory current = _checkpoint();
        vm.prank(owner);
        IUniswapV3PositionManagerMinimal(manager).decreaseLiquidity(
            IUniswapV3PositionManagerMinimal.DecreaseLiquidityParams(rootId, 1, 0, 0, clock)
        );
        _check(_execute(_plan()) == bytes32(0) && !vault.rootArmed(), "the owner's change disarms");
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        vm.prank(OPERATOR);
        vault.operatorRearm(current);
        _ledgerBalanced();
    }
}
