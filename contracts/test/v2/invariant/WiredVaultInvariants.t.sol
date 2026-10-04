// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {IntegrationWorld} from "../integration/IntegrationWorld.sol";
import {ZapVm} from "../zap/ZapTestKit.sol";

/// One owner's Auto-compound vault on the wired world (the registry, price
/// anchor, swap module and the Uniswap bytecode deployed on Base), driven by
/// the fuzzer:
/// - traders moving the pool and earning the root fees;
/// - the operator's compounds, with or without a swap leg through the deep
///   pool, each against a fresh signed observation;
/// - the owner's withdrawals to any wallet, pause and resume;
/// - the fee recipient going dark and back, flushes, and strangers trying
///   returnReserves on an open root.
/// The unit-model harness (VaultLedgerInvariants) covers successors,
/// donations and owner changes; this one checks the same ledger against
/// real collects, adds and swaps.
abstract contract WiredVaultHandler is IntegrationWorld {
    uint16 internal constant SIMPLE_TARIFF_BPS = 200;
    address internal constant SECOND_WALLET = address(0xC0FFEE);

    uint64 public highestNonce;
    uint256 public nonceDrops;
    uint256 public owedLosses;
    uint256 public tariffBreaches;
    uint256 public inexactWithdrawals;

    uint256 public compounds;
    uint256 public swappedCompounds;
    uint256 public withdrawals;
    uint256 public flushes;

    constructor() {
        setUp();
        stack = _vaultStack(address(0));
        _createVault(main, DominoV2Types.MODE_SIMPLE, -600, 600);
        highestNonce = vault.stateNonce();
    }

    modifier observed(bool flushing) {
        uint256 owed0 = vault.owedFees(market.pool.currency0);
        uint256 owed1 = vault.owedFees(market.pool.currency1);
        _;
        if (
            !flushing
                && (vault.owedFees(market.pool.currency0) < owed0 || vault.owedFees(market.pool.currency1) < owed1)
        ) ++owedLosses;
        uint64 nonce = vault.stateNonce();
        if (nonce < highestNonce) ++nonceDrops;
        else highestNonce = nonce;
    }

    function trade(bool zeroForOne, uint256 amount) external observed(false) {
        _trade(main, zeroForOne, 1e17 + amount % 5e19);
    }

    /// What the root's collects moved into its lots during the recorded call.
    function _collected(ZapVm.Log[] memory logs) internal view returns (uint256 amount0, uint256 amount1) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault) || logs[i].topics[0] != FEES_COLLECTED) continue;
            (uint256 a0, uint256 a1) = abi.decode(logs[i].data, (uint256, uint256));
            (amount0, amount1) = (amount0 + a0, amount1 + a1);
        }
    }

    /// A compound of the root, optionally swapping a little of one side first,
    /// against an observation signed at the current spot. Per currency, what
    /// the recipient got or is owed is at most 2% of what the execution took
    /// from the root's uncharged lots.
    function compound(bool swap, bool zeroForOne, uint256 amount) external observed(false) {
        _advance(600);
        Plan.PlanV1 memory p = _plan();
        if (swap) {
            uint128 amountIn = uint128(1e6 + amount % 1e12);
            (address tokenIn, address tokenOut) = zeroForOne
                ? (market.pool.currency0, market.pool.currency1)
                : (market.pool.currency1, market.pool.currency0);
            p.swap = Plan.Swap(
                rootId,
                zeroForOne,
                amountIn,
                _floor(main, amountIn, _spot(main), zeroForOne, 100),
                _oneLeg(_poolLeg(main.deep, tokenIn, tokenOut, amountIn, 1))
            );
        }
        (address c0, address c1) = (market.pool.currency0, market.pool.currency1);
        uint256[2] memory uncharged = [uint256(vault.lot(rootId, c0).uncharged), uint256(vault.lot(rootId, c1).uncharged)];
        uint256[2] memory fee = [_balance(c0, FEE_RECIPIENT) + vault.owedFees(c0), _balance(c1, FEE_RECIPIENT) + vault.owedFees(c1)];
        bytes memory plan = Plan.encode(p);
        vm.recordLogs();
        vm.prank(OPERATOR);
        try vault.execute(plan) returns (bytes32 planHash) {
            if (planHash == bytes32(0)) return;
            ++compounds;
            if (swap) ++swappedCompounds;
        } catch {
            return;
        }
        (uint256 collected0, uint256 collected1) = _collected(vm.getRecordedLogs());
        uint256[2] memory gross = [
            uncharged[0] + collected0 - vault.lot(rootId, c0).uncharged,
            uncharged[1] + collected1 - vault.lot(rootId, c1).uncharged
        ];
        fee[0] = _balance(c0, FEE_RECIPIENT) + vault.owedFees(c0) - fee[0];
        fee[1] = _balance(c1, FEE_RECIPIENT) + vault.owedFees(c1) - fee[1];
        for (uint256 t; t < 2; ++t) {
            if (fee[t] * 10_000 > gross[t] * SIMPLE_TARIFF_BPS + 9_999) ++tariffBreaches;
        }
    }

    function withdrawReserves(bool second, uint256 amount, bool toOtherWallet) external observed(false) {
        address token = second ? market.pool.currency1 : market.pool.currency0;
        uint256 reserves = vault.reserves(token);
        if (reserves == 0) return;
        amount = amount % reserves + 1;
        address wallet = toOtherWallet ? SECOND_WALLET : owner;
        uint256 before = _balance(token, wallet);
        uint256 owed = vault.owedFees(token);
        vm.prank(owner);
        try vault.withdrawReserves(token, amount, wallet) {
            ++withdrawals;
            if (_balance(token, wallet) != before + amount || vault.reserves(token) != reserves - amount || vault.owedFees(token) != owed) {
                ++inexactWithdrawals;
            }
        } catch {}
    }

    function pauseOrResume(bool pausing) external observed(false) {
        vm.prank(owner);
        if (pausing) vault.pause();
        else vault.resume();
    }

    function recipientGoesDark(bool dark) external observed(false) {
        base.setBlocked(FEE_RECIPIENT, dark);
        quote.setBlocked(FEE_RECIPIENT, dark);
    }

    function flush(bool second) external observed(true) {
        address token = second ? market.pool.currency1 : market.pool.currency0;
        vm.prank(STRANGER);
        try vault.flushOwedFees(token) returns (uint256 amount) {
            if (amount != 0) ++flushes;
        } catch {}
    }

    function strangerReturnsReserves() external observed(false) {
        vm.prank(STRANGER);
        try vault.returnReserves() {} catch {}
    }

    /// Reverts unless the vault's balances are exactly its ledger (reserves
    /// plus owed fees) with no allowance left (IntegrationWorld's check).
    function ledgerBalanced() external view {
        _ledgerBalanced();
    }

    function stateNonce() external view returns (uint64) {
        return vault.stateNonce();
    }
}

contract WiredVaultHandlerV3 is WiredVaultHandler {
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
}

contract WiredVaultHandlerV4 is WiredVaultHandler {
    function _dex() internal pure override returns (uint8) {
        return 4;
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

/// The ledger, the tariff, the owner's exact withdrawals, owed fees and the
/// nonce of a vault on real Uniswap bytecode, under every sequence.
abstract contract WiredVaultInvariants {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    WiredVaultHandler internal handler;

    function _handler() internal virtual returns (WiredVaultHandler);

    function setUp() public {
        handler = _handler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = WiredVaultHandler.trade.selector;
        selectors[1] = WiredVaultHandler.compound.selector;
        selectors[2] = WiredVaultHandler.withdrawReserves.selector;
        selectors[3] = WiredVaultHandler.pauseOrResume.selector;
        selectors[4] = WiredVaultHandler.recipientGoesDark.selector;
        selectors[5] = WiredVaultHandler.flush.selector;
        selectors[6] = WiredVaultHandler.strangerReturnsReserves.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    function testTheHandlerReachesEveryAction() public {
        handler.trade(true, 1e19);
        handler.trade(false, 1e19);
        handler.compound(false, false, 0);
        handler.trade(true, 2e19);
        handler.recipientGoesDark(true);
        handler.compound(true, true, 1e9);
        handler.recipientGoesDark(false);
        handler.flush(false);
        handler.flush(true);
        handler.withdrawReserves(false, 1e6, true);
        handler.withdrawReserves(true, 1e6, false);
        handler.pauseOrResume(true);
        handler.strangerReturnsReserves();
        handler.pauseOrResume(false);
        require(handler.compounds() == 2 && handler.swappedCompounds() == 1, "compounds never reached the vault");
        require(handler.flushes() >= 1 && handler.withdrawals() >= 1, "flushes or withdrawals never reached the vault");
        invariant_theVaultsBalancesAreItsLedger();
        invariant_noChargeAboveTheTariffAndExactWithdrawals();
        invariant_owedFeesFallOnlyByAFlushAndTheNonceOnlyGrows();
    }

    function invariant_theVaultsBalancesAreItsLedger() public view {
        handler.ledgerBalanced();
    }

    function invariant_noChargeAboveTheTariffAndExactWithdrawals() public view {
        require(handler.tariffBreaches() == 0, "an execution charged more than 2%");
        require(handler.inexactWithdrawals() == 0, "an owner withdrawal was not exact and free");
    }

    function invariant_owedFeesFallOnlyByAFlushAndTheNonceOnlyGrows() public view {
        require(handler.owedLosses() == 0, "owed fees fell without a flush");
        require(handler.nonceDrops() == 0 && handler.stateNonce() == handler.highestNonce(), "the nonce moved backwards");
    }
}

/// forge-config: default.invariant.runs = 32
/// forge-config: default.invariant.depth = 48
contract DominoV2WiredVaultV3InvariantsTest is WiredVaultInvariants {
    function _handler() internal override returns (WiredVaultHandler) {
        return new WiredVaultHandlerV3();
    }
}

/// forge-config: default.invariant.runs = 32
/// forge-config: default.invariant.depth = 48
contract DominoV2WiredVaultV4InvariantsTest is WiredVaultInvariants {
    function _handler() internal override returns (WiredVaultHandler) {
        return new WiredVaultHandlerV4();
    }
}
