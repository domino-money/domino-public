// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IPermit2Signature} from "../../../src/v2/external/IPermit2Signature.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoZap} from "../../../src/v2/interfaces/IDominoZap.sol";
import {DominoActionLock} from "../../../src/v2/route/DominoActionLock.sol";
import {DominoTokenOps} from "../../../src/v2/route/DominoTokenOps.sol";
import {IPositionNft, ZapVm} from "../zap/ZapTestKit.sol";
import {IIntegrationProbe} from "./IntegrationInterfaces.sol";
import {IntegrationWorld} from "./IntegrationWorld.sol";

/// @notice S1 (F2) on the wired world: the owner's create, increase, change of
/// range and exit through the real zap, the deployed router and pools, with
/// the 65 bps tariff in the currency the registry's ranks select.
abstract contract ZapJourney is IntegrationWorld {
    /// The owner creates on `m` from `amount` of `input`, half of it swapped
    /// through the market's deep pool.
    function _swapCreate(Market memory m, address input, address output, uint128 amount, address feeToken, uint256 nonce)
        internal
        view
        returns (IDominoPositionActions.CreatePlan memory p)
    {
        p.inputs = _inputs(input, amount);
        p.legs = _oneLeg(_deepLeg(m, input, output, amount / 2));
        p.intent = _intent(DominoV2Types.ACTION_CREATE, m.pool, 0, -600, 600, 1, p.legs, feeToken, owner, nonce);
        p.amount0Max = type(uint128).max;
        p.amount1Max = type(uint128).max;
    }

    /// Every Refunded receipt names the owner, and the owner's balances moved
    /// by exactly the refunds less what it paid in; the relayer's not at all.
    function _refundedOnlyTo(
        ZapVm.Log[] memory logs,
        uint256[3] memory ownerBefore,
        uint256[3] memory paid,
        uint256[3] memory relayerBefore
    ) internal view {
        address[3] memory currencies = [address(base), address(quote), address(second)];
        uint256[3] memory refunded;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(zap) || logs[i].topics[0] != REFUNDED) continue;
            _check(address(uint160(uint256(logs[i].topics[1]))) == owner, "refund receipt names the owner");
            address token = address(uint160(uint256(logs[i].topics[2])));
            uint256 amount = abi.decode(logs[i].data, (uint256));
            for (uint256 j; j < 3; ++j) if (token == currencies[j]) refunded[j] += amount;
        }
        uint256[3] memory ownerNow = _holdings(owner);
        uint256[3] memory relayerNow = _holdings(RELAYER);
        for (uint256 j; j < 3; ++j) {
            _eq(ownerNow[j] + paid[j], ownerBefore[j] + refunded[j], "owner moved by its refunds less its inputs");
            _eq(relayerNow[j], relayerBefore[j], "relayer keeps nothing of the action");
        }
    }

    function testSignedCreateRelayedRangeAndConvertedExitRefundOnlyTheOwner() public {
        // A relayer submits the owner's Permit2-witnessed create through the deployed router.
        IDominoPositionActions.CreatePlan memory create;
        create.inputs = _inputs(address(quote), 10e18);
        create.legs = _oneLeg(_routerLeg(address(quote), address(base), 5e18));
        create.intent = _intent(DominoV2Types.ACTION_CREATE, main.pool, 0, -600, 600, 1, create.legs, address(quote), owner, 7);
        create.amount0Max = type(uint128).max;
        create.amount1Max = type(uint128).max;
        IPermit2Signature.PermitBatchTransferFrom memory permit = _permit(create.inputs, 7, DEADLINE);
        bytes memory signature = _signature(OWNER_KEY, _permitDigest(permit, address(zap), create.intent));
        uint256[3] memory ownerBefore = _holdings(owner);
        uint256[3] memory relayerBefore = _holdings(RELAYER);
        vm.recordLogs();
        uint256 start = gasleft();
        vm.prank(RELAYER);
        IDominoPositionActions.ActionResult memory created = zap.createWithPermit(create, permit, signature);
        _logGas(_dex() == DominoV2Types.DEX_V3 ? "v3 create+router+Permit2" : "v4 create+router+Permit2", start - gasleft());
        ZapVm.Log[] memory logs = vm.getRecordedLogs();
        _eq(created.feeAmount, uint256(5e18) * 65 / 10_000, "65 bps once, on the ranked input");
        _eq(quote.balanceOf(FEE_RECIPIENT), created.feeAmount, "tariff delivered");
        _check(created.feeToken == address(quote) && IPositionNft(manager).ownerOf(created.tokenId) == owner, "owner's NFT");
        _eq(_count(logs, address(zap), ACTION_EXECUTED), 1, "one action receipt");
        _eq(_count(logs, address(zap), FEE_CHARGED), 1, "one tariff receipt");
        _check(_count(logs, address(zap), REFUNDED) > 0, "leftovers refunded");
        _refundedOnlyTo(logs, ownerBefore, [uint256(0), 10e18, 0], relayerBefore);
        _cleanZap();

        // The owner adds through a direct pool leg.
        vm.prank(owner);
        IPositionNft(manager).approve(address(zap), created.tokenId);
        IDominoPositionActions.IncreasePlan memory increase;
        increase.inputs = _inputs(address(quote), 2e18);
        increase.legs = _oneLeg(_deepLeg(main, address(quote), address(base), 1e18));
        increase.intent = _intent(
            DominoV2Types.ACTION_INCREASE, main.pool, created.tokenId, -600, 600, 1, increase.legs, address(quote), owner, 8
        );
        increase.amount0Max = type(uint128).max;
        increase.amount1Max = type(uint128).max;
        uint128 priorLiquidity = _liquidity(created.tokenId);
        start = gasleft();
        vm.prank(owner);
        zap.increase(increase);
        _logGas(_dex() == DominoV2Types.DEX_V3 ? "v3 increase+pool" : "v4 increase+pool", start - gasleft());
        _check(_liquidity(created.tokenId) > priorLiquidity, "increase persisted");
        _cleanZap();

        // A relayer moves the range with the owner's signature.
        IDominoPositionActions.ChangeRangePlan memory change;
        change.legs = _oneLeg(_deepLeg(main, address(quote), address(base), 1e17));
        change.intent = _intent(
            DominoV2Types.ACTION_CHANGE_RANGE, main.pool, created.tokenId, -1200, 1200, 1, change.legs, address(quote), owner, 9
        );
        change.liquidityToRemove = _liquidity(created.tokenId);
        change.amount0Max = type(uint128).max;
        change.amount1Max = type(uint128).max;
        change.burnOld = true;
        bytes memory relayed = _signature(OWNER_KEY, _relayedDigest(address(zap), _relayedChange(change)));
        ownerBefore = _holdings(owner);
        relayerBefore = _holdings(RELAYER);
        vm.recordLogs();
        start = gasleft();
        vm.prank(RELAYER);
        IDominoPositionActions.ActionResult memory changed = zap.changeRangeWithSignature(change, relayed);
        _logGas(_dex() == DominoV2Types.DEX_V3 ? "v3 relayed range+pool" : "v4 relayed range+pool", start - gasleft());
        _check(changed.tokenId != created.tokenId && IPositionNft(manager).ownerOf(changed.tokenId) == owner, "successor NFT");
        _refundedOnlyTo(vm.getRecordedLogs(), ownerBefore, [uint256(0), 0, 0], relayerBefore);
        _cleanZap();

        // A relayer exits it with a conversion into the rank-1 currency.
        vm.prank(owner);
        IPositionNft(manager).approve(address(zap), changed.tokenId);
        IDominoPositionActions.ExitPlan memory exit;
        exit.legs = _oneLeg(_deepLeg(main, address(base), address(quote), 1e17));
        exit.intent =
            _intent(DominoV2Types.ACTION_EXIT, main.pool, changed.tokenId, -1200, 1200, 0, exit.legs, address(quote), owner, 10);
        uint128 whole = _liquidity(changed.tokenId);
        exit.liquidityToRemove = whole;
        exit.burn = true;
        relayed = _signature(OWNER_KEY, _relayedDigest(address(zap), _relayedExit(exit)));
        ownerBefore = _holdings(owner);
        relayerBefore = _holdings(RELAYER);
        uint256 feeBefore = quote.balanceOf(FEE_RECIPIENT);
        vm.recordLogs();
        start = gasleft();
        vm.prank(RELAYER);
        IDominoPositionActions.ActionResult memory exited = zap.exitWithSignature(exit, relayed);
        _logGas(_dex() == DominoV2Types.DEX_V3 ? "v3 relayed exit+conversion" : "v4 relayed exit+conversion", start - gasleft());
        logs = vm.getRecordedLogs();
        (,, uint256 convertedOut) = abi.decode(_first(logs, address(zap), LEG_EXECUTED).data, (address, uint256, uint256));
        _check(exited.feeToken == address(quote), "ranked output is the exit's fee currency");
        _eq(exited.feeAmount, convertedOut * 65 / 10_000, "65 bps of the measured ranked output only");
        _eq(quote.balanceOf(FEE_RECIPIENT) - feeBefore, exited.feeAmount, "exit tariff delivered");
        _refundedOnlyTo(logs, ownerBefore, [uint256(0), 0, 0], relayerBefore);
        _eq(exited.liquidity, whole, "the whole position removed (and burned)");
        _cleanZap();
    }

    function testRelayedActionCannotBeReplayedOnALivePosition() public {
        uint256 id = _mintPosition(main, -600, 600, 0);
        vm.prank(owner);
        IPositionNft(manager).approve(address(zap), id);
        IDominoPositionActions.ExitPlan memory exit;
        exit.legs = _noLegs();
        exit.intent = _intent(DominoV2Types.ACTION_EXIT, main.pool, id, -600, 600, 0, exit.legs, address(0), owner, 21);
        exit.liquidityToRemove = _liquidity(id) / 4;
        bytes memory signature = _signature(OWNER_KEY, _relayedDigest(address(zap), _relayedExit(exit)));
        uint256[3] memory ownerBefore = _holdings(owner);
        vm.prank(RELAYER);
        IDominoPositionActions.ActionResult memory result = zap.exitWithSignature(exit, signature);
        uint256[3] memory ownerNow = _holdings(owner);
        _eq(ownerNow[0] - ownerBefore[0], result.amount0, "a plain exit pays the owner directly");
        _eq(ownerNow[1] - ownerBefore[1], result.amount1, "both currencies");
        uint128 left = _liquidity(id);
        _check(left > 0, "the position is still live");
        // The same signed action again: the position could serve it, the nonce refuses it.
        vm.expectRevert(abi.encodeWithSelector(IDominoZap.NonceUsed.selector, owner, uint256(21)));
        vm.prank(RELAYER);
        zap.exitWithSignature(exit, signature);
        _eq(_liquidity(id), left, "the replay removed nothing");
        // A nonce the owner voided before any use is refused the same way.
        vm.prank(owner);
        zap.invalidateNonces(0, 1 << 22);
        exit.intent.nonce = 22;
        signature = _signature(OWNER_KEY, _relayedDigest(address(zap), _relayedExit(exit)));
        vm.expectRevert(abi.encodeWithSelector(IDominoZap.NonceUsed.selector, owner, uint256(22)));
        vm.prank(RELAYER);
        zap.exitWithSignature(exit, signature);
        _eq(zap.nonceBitmap(owner, 0), (1 << 21) | (1 << 22), "both nonces spent, nothing else");
        _eq(_liquidity(id), left, "the voided action removed nothing");
        _cleanZap();
    }

    function testDeferredTariffIsNeverSpentByLaterOwnerActions() public {
        quote.setBlocked(FEE_RECIPIENT, true);
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory created =
            zap.create(_swapCreate(main, address(quote), address(base), 10e18, address(quote), 1));
        uint256 owed = created.feeAmount;
        _eq(zap.owedFees(address(quote)), owed, "create tariff owed");
        _cleanZap();

        // An increase in the owed currency: the add and the refund leave the debt in place.
        vm.prank(owner);
        IPositionNft(manager).approve(address(zap), created.tokenId);
        IDominoPositionActions.IncreasePlan memory increase;
        increase.inputs = _inputs(address(quote), 2e18);
        increase.legs = _oneLeg(_deepLeg(main, address(quote), address(base), 1e18));
        increase.intent = _intent(
            DominoV2Types.ACTION_INCREASE, main.pool, created.tokenId, -600, 600, 1, increase.legs, address(quote), owner, 2
        );
        increase.amount0Max = type(uint128).max;
        increase.amount1Max = type(uint128).max;
        uint256[3] memory before = _holdings(owner);
        vm.recordLogs();
        vm.prank(owner);
        owed += zap.increase(increase).feeAmount;
        _eq(zap.owedFees(address(quote)), owed, "both tariffs owed");
        _eq(quote.balanceOf(address(zap)), owed, "the earlier debt was neither added nor refunded");
        _refundedOnlyTo(vm.getRecordedLogs(), before, [uint256(0), 2e18, 0], _holdings(RELAYER));

        // An exit converting into the owed currency: only the unowed output is refunded.
        IDominoPositionActions.ExitPlan memory exit;
        exit.legs = _oneLeg(_deepLeg(main, address(base), address(quote), 1e18));
        exit.intent =
            _intent(DominoV2Types.ACTION_EXIT, main.pool, created.tokenId, -600, 600, 0, exit.legs, address(quote), owner, 3);
        exit.liquidityToRemove = _liquidity(created.tokenId);
        exit.burn = true;
        before = _holdings(owner);
        vm.recordLogs();
        vm.prank(owner);
        owed += zap.exit(exit).feeAmount;
        _eq(zap.owedFees(address(quote)), owed, "three tariffs owed");
        _eq(quote.balanceOf(address(zap)), owed, "the exit's refund left every owed unit");
        _refundedOnlyTo(vm.getRecordedLogs(), before, [uint256(0), 0, 0], _holdings(RELAYER));

        quote.setBlocked(FEE_RECIPIENT, false);
        vm.prank(STRANGER);
        _eq(zap.flushOwedFees(address(quote)), owed, "anyone flushes the whole debt");
        _eq(quote.balanceOf(FEE_RECIPIENT), owed, "recipient paid exactly once");
        _cleanZap();
    }

    function testTokenCallbackMeetsTheSharedLock() public {
        IIntegrationProbe probe = _probe();
        probe.arm(address(zap), abi.encodeCall(zap.invalidateNonces, (0, 1)));
        quote.setHook(address(probe), abi.encodeCall(probe.fire, ()));
        vm.prank(owner);
        zap.create(_swapCreate(main, address(quote), address(base), 10e18, address(quote), 12));
        quote.setHook(address(0), "");
        _check(probe.calls() > 0 && probe.successes() == 0, "every nested call failed");
        _check(probe.lastError() == DominoActionLock.ReentrantCall.selector, "refused by the shared lock");
        _eq(zap.nonceBitmap(address(probe), 0), 0, "no nonce was voided from inside the action");
        _cleanZap();
    }

    function testHostileTokenFailureRollsBackEveryInput() public {
        IDominoPositionActions.CreatePlan memory p = _swapCreate(main, address(quote), address(base), 10e18, address(quote), 11);
        quote.setHook(address(zap), abi.encodeWithSignature("invalidateNonces(uint256,uint256)", 0, 1));
        uint256[3] memory before = _holdings(owner);
        vm.expectRevert(abi.encodeWithSelector(DominoTokenOps.TokenCallFailed.selector, address(quote)));
        vm.prank(owner);
        zap.create(p);
        uint256[3] memory after_ = _holdings(owner);
        _eq(after_[1], before[1], "hostile token: atomic rollback");
        quote.setHook(address(0), "");
        _cleanZap();
    }

    function testFeeCurrencyFollowsTheRankRuleSecondRankHopAndFallback() public {
        // (base, second): no rank-1 currency in the pool. Base to second
        // delivers the rank-2 currency, so the tariff is 65 bps of the
        // measured output, in `second`; naming the input is refused.
        IDominoPositionActions.CreatePlan memory p = _swapCreate(side, address(base), address(second), 10e18, address(base), 31);
        vm.expectRevert(IDominoPositionActions.FeeMismatch.selector);
        vm.prank(owner);
        zap.create(p);
        p = _swapCreate(side, address(base), address(second), 10e18, address(second), 31);
        vm.recordLogs();
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory rank2 = zap.create(p);
        (,, uint256 delivered) =
            abi.decode(_first(vm.getRecordedLogs(), address(zap), LEG_EXECUTED).data, (address, uint256, uint256));
        _check(rank2.feeToken == address(second), "rank-2 output selected");
        _eq(rank2.feeAmount, delivered * 65 / 10_000, "65 bps of the rank-2 output");
        _eq(second.balanceOf(FEE_RECIPIENT), rank2.feeAmount, "rank-2 tariff delivered");
        _cleanZap();

        // second -> quote -> base: the rank-1 currency is only a hop between
        // two legs and still outranks the rank-2 input.
        p.inputs = _inputs(address(second), 10e18);
        p.legs = _twoLegs(
            _deepLeg(inverse, address(second), address(quote), 5e18),
            _poolLeg(main.deep, address(quote), address(base), 49e17, 48e17)
        );
        p.intent = _intent(DominoV2Types.ACTION_CREATE, side.pool, 0, -600, 600, 1, p.legs, address(quote), owner, 32);
        uint256[3] memory before = _holdings(owner);
        vm.recordLogs();
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory hop = zap.create(p);
        ZapVm.Log[] memory logs = vm.getRecordedLogs();
        (,, uint256 carried) = abi.decode(_first(logs, address(zap), LEG_EXECUTED).data, (address, uint256, uint256));
        _check(hop.feeToken == address(quote) && carried > 49e17, "the hop currency, on what it carried");
        _eq(hop.feeAmount, carried * 65 / 10_000, "65 bps of the hop's measured amount");
        _eq(quote.balanceOf(FEE_RECIPIENT), hop.feeAmount, "hop tariff delivered");
        _refundedOnlyTo(logs, before, [uint256(0), 0, 10e18], _holdings(RELAYER));
        _cleanZap();

        // Delisted through the timelock, `second` is no charge currency: a
        // route without one pays in its first leg's input.
        _governed(DominoV2Types.REGISTRY_CHARGE_CURRENCY, abi.encode(address(second), uint8(0)));
        p = _swapCreate(side, address(base), address(second), 10e18, address(second), 33);
        p.intent.deadline = uint64(clock + 600);
        vm.expectRevert(IDominoPositionActions.FeeMismatch.selector);
        vm.prank(owner);
        zap.create(p);
        p.intent.feeToken = address(base);
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory fallback_ = zap.create(p);
        _check(fallback_.feeToken == address(base), "fallback: the first leg's input");
        _eq(fallback_.feeAmount, uint256(5e18) * 65 / 10_000, "65 bps of the input it spent");
        _eq(base.balanceOf(FEE_RECIPIENT), fallback_.feeAmount, "fallback tariff delivered");
        _cleanZap();
    }

    function testRouterRemovalAndReadmissionReachTheZap() public {
        IDominoPositionActions.CreatePlan memory p;
        p.inputs = _inputs(address(quote), 10e18);
        p.legs = _oneLeg(_routerLeg(address(quote), address(base), 5e18));
        p.intent = _intent(DominoV2Types.ACTION_CREATE, main.pool, 0, -600, 600, 1, p.legs, address(quote), owner, 41);
        p.amount0Max = type(uint128).max;
        p.amount1Max = type(uint128).max;
        vm.prank(GUARDIAN);
        registry.removeRouter(chain.router);
        vm.expectRevert(IDominoPositionActions.InvalidPlan.selector);
        vm.prank(owner);
        zap.create(p);
        // Re-admission needs a change scheduled after the removal, and its full timelock.
        _advance(1);
        bytes32 change = registry.scheduleChange(DominoV2Types.REGISTRY_ROUTER, abi.encode(chain.router, uint16(212)));
        _advance(TIMELOCK);
        registry.executeChange(change);
        p.legs = _oneLeg(_routerLeg(address(quote), address(base), 5e18));
        p.intent = _intent(DominoV2Types.ACTION_CREATE, main.pool, 0, -600, 600, 1, p.legs, address(quote), owner, 41);
        p.intent.deadline = uint64(clock + 600);
        vm.prank(owner);
        IDominoPositionActions.ActionResult memory created = zap.create(p);
        _eq(created.feeAmount, uint256(5e18) * 65 / 10_000, "the re-admitted router serves the zap");
        _cleanZap();
    }
}
