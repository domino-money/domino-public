// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OfficialFixtureToken, OfficialV4Controller, OfficialV4SwapDriver, PoolManager,
    PositionManager, IPoolManager, PoolKey, Currency} from "./OfficialV4Fixture.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPositionDescriptor} from "./official-v4/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "./official-v4/v4-periphery/src/interfaces/external/IWETH9.sol";
import {StateView} from "./official-v4/v4-periphery/src/lens/StateView.sol";
import {DominoVault} from "../../src/DominoVault.sol";
import {DominoVaultFactory} from "../../src/DominoVaultFactory.sol";
import {DominoVaultTypes as T} from "../../src/DominoVaultTypes.sol";
import {IDominoVaultDraft} from "../../src/IDominoVaultDraft.sol";

interface VmDominoOfficial {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function deal(address account, uint256 balance) external;
    function chainId(uint256 chain) external;
    function roll(uint256 number) external;
    function warp(uint256 timestamp) external;
    function setBlockhash(uint256 number, bytes32 blockHash) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// @dev Synthetic converted-credit sink only. The core and PositionManager remain
/// real; this explicitly does not qualify a swap or converted-origin producer.
contract OfficialChargedVaultHarness is DominoVault {
    constructor(address factory_, address manager_, address positions_, address state_, address recipient_)
        DominoVault(factory_, manager_, positions_, state_, recipient_) {}

    function seedCharged(bytes32 sourceId, address currency, uint128 amount) external onlyOwner {
        _creditConvertedFees(sourceId, currency, amount);
    }
}

contract OfficialDominoCompoundTest {
    using TransientStateLibrary for IPoolManager;
    VmDominoOfficial private constant vm = VmDominoOfficial(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant RECIPIENT = address(0xFEE);
    uint128 private constant OPENING = 1e18;
    bytes32 private constant APPLIED = keccak256("SourceFeesApplied(address,bytes32,bytes32,address,(uint128,uint128,uint128,uint128,uint128,uint128,uint128,uint128,uint128))");
    bytes32 private constant REALIZED = keccak256("FeesRealized(address,bytes32,uint256,bytes32,bytes32,uint128,uint128)");
    bytes32 private constant COMPLETED = keccak256("CompoundSelfCompleted(bytes32,uint256,bytes32,uint128,uint128,uint64,uint64,uint64)");
    IPoolManager private manager;
    PositionManager private positions;
    StateView private state;
    OfficialV4SwapDriver private trader;
    DominoVault private vault;
    PoolKey private key;
    uint256 private tokenId;
    uint256 private planCounter;

    receive() external payable {}

    function _setup(bool nativePair, bool chargedHarness, uint24 poolFee) private {
        vm.chainId(4663);
        vm.roll(1000);
        vm.warp(1_700_000_000);
        manager = IPoolManager(address(new PoolManager(address(this))));
        positions = new PositionManager(manager, IAllowanceTransfer(address(0x1111)), 100_000,
            IPositionDescriptor(address(0x2222)), IWETH9(address(0x3333)));
        state = new StateView(manager);
        OfficialV4Controller seed = new OfficialV4Controller(manager, positions);
        trader = new OfficialV4SwapDriver(manager);
        OfficialFixtureToken a = new OfficialFixtureToken();
        OfficialFixtureToken b = new OfficialFixtureToken();
        address c0 = nativePair ? address(0) : (address(a) < address(b) ? address(a) : address(b));
        address c1 = nativePair ? address(a) : (address(a) < address(b) ? address(b) : address(a));
        key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), poolFee, 60, IHooks(address(0)));
        _fund(c0, address(seed), 1e20);
        _fund(c1, address(seed), 1e20);
        _fund(c0, address(trader), 1e20);
        _fund(c1, address(trader), 1e20);
        manager.initialize(key, uint160(1 << 96));
        seed.seed(key, OPENING);
        seed.refundSetup();
        tokenId = seed.tokenId();
        if (chargedHarness) {
            OfficialChargedVaultHarness implementation = new OfficialChargedVaultHarness(
                address(this), address(manager), address(positions), address(state), RECIPIENT);
            bytes memory code = abi.encodePacked(hex"3d602d80600a3d3981f3", hex"363d3d373d3d3d363d73",
                address(implementation), hex"5af43d82803e903d91602b57fd5bf3");
            address clone;
            assembly ("memory-safe") { clone := create(0, add(code, 32), mload(code)) }
            require(clone != address(0), "harness clone");
            positions.approve(clone, tokenId);
            vault = DominoVault(payable(clone));
            vault.initialize(address(this), keccak256("official charged fixture"), _params());
        } else {
            DominoVaultFactory factory = new DominoVaultFactory(address(manager), address(positions), address(state), RECIPIENT);
            address predicted = factory.predictVault(address(this), 0);
            positions.approve(predicted, tokenId);
            vault = DominoVault(payable(factory.createVault(_params(), 0)));
            require(address(vault) == predicted && factory.isVault(predicted), "actual factory clone");
        }
        require(vault.rootPermissionValid(), "official manager authority");
    }

    function _params() private view returns (T.InitParams memory p) {
        p.rootTokenId = tokenId;
        p.expectedPoolId = keccak256(abi.encode(key));
        p.baseCurrency = Currency.unwrap(key.currency0);
        p.quoteCurrency = Currency.unwrap(key.currency1);
        p.consentToUncollectedFees = true;
        p.policy = IDominoVaultDraft.Policy(200, 500, 1000, 1, 4, 1, false);
        p.limits = T.ExecutionLimits(1, 5000, 100, 100, 1_000_000_000_000, 120, 3600);
    }

    function _swaps(uint256 rounds, uint256 amount) private {
        for (uint256 i; i < rounds; ++i) {
            trader.swap(key, true, amount);
            trader.swap(key, false, amount);
        }
    }

    function _plan(uint128 increase) private returns (T.CompoundPlan memory p) {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 2);
        bytes32 observedHash = keccak256(abi.encode(block.number - 1));
        vm.setBlockhash(block.number - 1, observedHash);
        p.intentId = keccak256(abi.encode("official compound", ++planCounter));
        p.tokenId = tokenId;
        p.positionIdentity = vault.position(tokenId).identity;
        p.checkpointId = vault.checkpoint(tokenId).commitment;
        p.policyVersion = vault.policy().version;
        p.limitsVersion = vault.executionLimits().version;
        p.stateNonce = vault.stateNonce();
        p.authorityGeneration = vault.authorityGeneration();
        p.observedAtBlock = uint64(block.number - 1);
        p.observedBlockHash = observedHash;
        p.observedAtTimestamp = uint64(block.timestamp - 1);
        p.deadline = uint64(block.timestamp + 60);
        p.liquidityIncrease = increase;
        p.maxOriginal0 = type(uint128).max;
        p.maxOriginal1 = type(uint128).max;
        p.maxCharged0 = type(uint128).max;
        p.maxCharged1 = type(uint128).max;
        p.minAdded0 = 1;
        p.minAdded1 = 1;
        p.minSqrtPriceX96 = uint160(1 << 95);
        p.maxSqrtPriceX96 = uint160(1 << 97);
    }

    function _execute(T.CompoundPlan memory p) private returns (T.CompoundAmounts[2] memory amounts) {
        uint256 owner0 = _balance(key.currency0, address(this));
        uint256 owner1 = _balance(key.currency1, address(this));
        uint256 recipient0 = _balance(key.currency0, RECIPIENT);
        uint256 recipient1 = _balance(key.currency1, RECIPIENT);
        uint128 beforeLiquidity = positions.getPositionLiquidity(tokenId);
        bytes32 baseline = vault.registrationCheckpoint(tokenId).commitment;
        uint64 generation = vault.authorityGeneration();
        vm.recordLogs();
        vault.compoundSelf(p);
        VmDominoOfficial.Log[] memory logs = vm.getRecordedLogs();
        uint256 sourceEvents;
        uint256 realizedEvents;
        uint256 completedEvents;
        uint256 sourceMask;
        uint128[2] memory realizedAmounts;
        for (uint256 i; i < logs.length; ++i) {
            VmDominoOfficial.Log memory entry = logs[i];
            if (entry.topics.length == 0) continue;
            if (entry.topics[0] == APPLIED) {
                require(entry.emitter == address(vault.compoundEngine()) && entry.topics.length == 4 &&
                    address(uint160(uint256(entry.topics[1]))) == address(vault) && entry.topics[2] == p.intentId,
                    "source engine vault and intent");
                T.Position memory member = vault.position(tokenId);
                uint256 which = entry.topics[3] == member.source0 ? 0 : 1;
                require(entry.topics[3] == (which == 0 ? member.source0 : member.source1) &&
                    sourceMask & (1 << which) == 0, "unique source identity");
                sourceMask |= 1 << which;
                address currency;
                (currency, amounts[which]) = abi.decode(entry.data, (address, T.CompoundAmounts));
                require(currency == Currency.unwrap(which == 0 ? key.currency0 : key.currency1), "source currency");
                sourceEvents++;
            } else if (entry.topics[0] == REALIZED) {
                require(entry.emitter == address(vault.compoundEngine()) && entry.topics.length == 4 &&
                    address(uint160(uint256(entry.topics[1]))) == address(vault) && entry.topics[2] == p.intentId &&
                    uint256(entry.topics[3]) == tokenId, "realization engine vault and intent");
                bytes32 beforeId;
                bytes32 collectedId;
                (beforeId, collectedId, realizedAmounts[0], realizedAmounts[1]) =
                    abi.decode(entry.data, (bytes32, bytes32, uint128, uint128));
                require(beforeId != bytes32(0) && collectedId != bytes32(0), "realization checkpoints");
                realizedEvents++;
            } else if (entry.topics[0] == COMPLETED) {
                require(entry.emitter == address(vault) && entry.topics.length == 3 && entry.topics[1] == p.intentId &&
                    uint256(entry.topics[2]) == tokenId && sourceMask == 3 && realizedEvents == 1,
                    "vault completion follows engine effects");
                (bytes32 planHash, uint128 prior, uint128 after_, uint64 policyVersion,
                    uint64 authorityGeneration, uint64 nonce) = abi.decode(entry.data, (bytes32,uint128,uint128,uint64,uint64,uint64));
                require(planHash == keccak256(abi.encode(keccak256("DominoCompoundSelfV1"), block.chainid,
                    address(vault), vault.sequenceIdentityHash(), p)), "plan commitment");
                require(prior == beforeLiquidity && after_ == prior + p.liquidityIncrease &&
                    policyVersion == p.policyVersion && authorityGeneration == generation && nonce == p.stateNonce + 1,
                    "completion effects");
                completedEvents++;
            }
        }
        require(sourceEvents == 2 && sourceMask == 3 && realizedEvents == 1 && completedEvents == 1,
            "complete financial events");
        require(realizedAmounts[0] == amounts[0].realized && realizedAmounts[1] == amounts[1].realized,
            "realization and source receipts agree");
        for (uint256 i; i < 2; ++i) {
            T.CompoundAmounts memory a = amounts[i];
            T.Position memory member = vault.position(tokenId);
            Currency currency = i == 0 ? key.currency0 : key.currency1;
            bytes32 sourceId = i == 0 ? member.source0 : member.source1;
            T.FeeBalance memory stored = vault.feeBalance(sourceId, Currency.unwrap(currency));
            require(uint256(a.originalBefore) + a.realized == uint256(a.grossOriginalConsumed) + a.originalAfter &&
                a.chargedBefore == a.chargedConsumed + a.chargedAfter &&
                uint256(a.grossOriginalConsumed) + a.chargedConsumed == uint256(a.liquidityAdded) + a.serviceFee,
                "per-source conservation");
            require(a.serviceFee == uint256(a.grossOriginalConsumed) * vault.policy().serviceFeeBps / 10000,
                "single aggregate service floor");
            require(stored.original == a.originalAfter && stored.charged == a.chargedAfter &&
                vault.accountedCurrency(Currency.unwrap(currency)) == uint256(stored.original) + stored.charged,
                "actual source ledger");
        }
        require(_balance(key.currency0, RECIPIENT) - recipient0 == amounts[0].serviceFee &&
            _balance(key.currency1, RECIPIENT) - recipient1 == amounts[1].serviceFee, "actual fixed recipient fees");
        require(_balance(key.currency0, address(this)) == owner0 && _balance(key.currency1, address(this)) == owner1,
            "no owner wallet debits");
        require(positions.ownerOf(tokenId) == address(this) && positions.getApproved(tokenId) == address(vault) &&
            address(positions.subscriber(tokenId)) == address(vault) && vault.rootPermissionValid(), "root authority preserved");
        require(vault.stateNonce() == p.stateNonce + 1 && vault.consumedIntent(p.intentId) &&
            vault.authorityGeneration() == generation && vault.registrationCheckpoint(tokenId).commitment == baseline,
            "nonce intent and immutable opening");
        require(positions.getPositionLiquidity(tokenId) == beforeLiquidity + p.liquidityIncrease &&
            !manager.isUnlocked() && manager.getNonzeroDeltaCount() == 0, "exact liquidity and settled core");
    }

    function testDominoOfficialErc20RepeatedWaitingAndNewFeesChargeOnce() public {
        _setup(false, false, 3000);
        _swaps(1, 1e15);
        T.CompoundAmounts[2] memory first = _execute(_plan(5e13));
        _swaps(1, 1e15);
        // This exact increase crosses a base-unit rounding boundary: flooring
        // waiting and newly collected consumption separately would undercharge.
        T.CompoundAmounts[2] memory second = _execute(_plan(1e14 + 40));
        bool catchesSplitFloor;
        for (uint256 i; i < 2; ++i) {
            require(second[i].originalBefore == first[i].originalAfter && second[i].realized > 0 &&
                second[i].grossOriginalConsumed > second[i].originalBefore, "waiting and new fees both consumed");
            uint256 splitFee = uint256(second[i].originalBefore) * 200 / 10000 +
                uint256(second[i].grossOriginalConsumed - second[i].originalBefore) * 200 / 10000;
            if (second[i].serviceFee > splitFee) catchesSplitFloor = true;
        }
        require(catchesSplitFloor, "fixture must distinguish aggregate from split fee floors");
        // No new swap is needed to consume the remaining uncharged earned fees.
        T.CompoundAmounts[2] memory third = _execute(_plan(1e12));
        require(third[0].realized == 0 && third[1].realized == 0 && third[0].serviceFee > 0,
            "waiting original reserve charges only when consumed");
    }

    function testDominoOfficialNativeFeesAndDonationsStaySeparate() public {
        _setup(true, false, 3000);
        _swaps(1, 1e15);
        uint256 donation = 1e18;
        (bool sent,) = address(vault).call{value: donation}("");
        require(sent, "native donation");
        OfficialFixtureToken(Currency.unwrap(key.currency1)).transfer(address(vault), donation);
        T.CompoundAmounts[2] memory applied = _execute(_plan(1e12));
        require(_balance(key.currency0, address(vault)) == donation + applied[0].originalAfter &&
            _balance(key.currency1, address(vault)) == donation + applied[1].originalAfter, "donation excluded from fee ledger");
    }

    function testDominoOfficialInsufficientBudgetRollsBackAndSameIntentRetries() public {
        _setup(false, false, 3000);
        _swaps(1, 1e15);
        T.CompoundPlan memory valid = _plan(1e12);
        T.CompoundPlan memory tooSmall = valid;
        tooSmall.maxOriginal0 = 0;
        bytes32 checkpoint = vault.checkpoint(tokenId).commitment;
        (bool ok,) = address(vault).call(abi.encodeCall(vault.compoundSelf, (tooSmall)));
        require(!ok && !vault.consumedIntent(valid.intentId) && vault.stateNonce() == valid.stateNonce &&
            vault.lastExecutionAt() == 0 && vault.checkpoint(tokenId).commitment == checkpoint &&
            positions.getPositionLiquidity(tokenId) == OPENING, "failed budget changed execution state");
        require(_balance(key.currency0, address(vault)) == 0 && _balance(key.currency1, address(vault)) == 0 &&
            _balance(key.currency0, RECIPIENT) == 0 && _balance(key.currency1, RECIPIENT) == 0,
            "reverted collection or charge escaped");
        valid.maxOriginal0 = type(uint128).max;
        _execute(valid);
        (ok,) = address(vault).call(abi.encodeCall(vault.compoundSelf, (valid)));
        require(!ok, "successful intent replayed");
    }

    function testDominoOfficialNoInheritedFifteenPercentLiquidityCap() public {
        _setup(false, false, 100000);
        _swaps(8, 1e16);
        uint128 increase = OPENING / 5;
        T.CompoundAmounts[2] memory applied = _execute(_plan(increase));
        require(positions.getPositionLiquidity(tokenId) == OPENING * 120 / 100 &&
            applied[0].grossOriginalConsumed <= applied[0].realized &&
            applied[1].grossOriginalConsumed <= applied[1].realized, "twenty percent fee-funded growth");
    }

    function testDominoOfficialAlreadyChargedResidualPaysNoSecondServiceCut() public {
        _setup(false, true, 3000);
        T.Position memory member = vault.position(tokenId);
        OfficialChargedVaultHarness chargedVault = OfficialChargedVaultHarness(payable(address(vault)));
        for (uint256 i; i < 2; ++i) {
            address currency = Currency.unwrap(i == 0 ? key.currency0 : key.currency1);
            _fund(currency, address(vault), 1e12);
            chargedVault.seedCharged(i == 0 ? member.source0 : member.source1, currency, 1e12);
        }
        T.CompoundPlan memory p = _plan(1e12);
        p.maxOriginal0 = 0;
        p.maxOriginal1 = 0;
        T.CompoundAmounts[2] memory applied = _execute(p);
        require(applied[0].serviceFee == 0 && applied[1].serviceFee == 0 && applied[0].realized == 0 &&
            applied[1].realized == 0 && applied[0].chargedConsumed > 0 && applied[1].chargedAfter > 0,
            "already charged residual charged twice");
        p = _plan(1e12);
        p.maxOriginal0 = 0;
        p.maxOriginal1 = 0;
        applied = _execute(p);
        require(applied[0].serviceFee == 0 && applied[1].serviceFee == 0, "repeat charged residual toll");
    }

    function _fund(address currency, address who, uint256 amount) private {
        if (currency == address(0)) vm.deal(who, who.balance + amount);
        else OfficialFixtureToken(currency).mint(who, amount);
    }

    function _balance(Currency currency, address who) private view returns (uint256) {
        return Currency.unwrap(currency) == address(0) ? who.balance :
            OfficialFixtureToken(Currency.unwrap(currency)).balanceOf(who);
    }
}
