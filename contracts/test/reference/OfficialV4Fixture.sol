// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolManager} from "./official-v4/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {PositionManager} from "./official-v4/v4-periphery/src/PositionManager.sol";
import {ISubscriber} from "./official-v4/v4-periphery/src/interfaces/ISubscriber.sol";
import {PositionInfo} from "./official-v4/v4-periphery/src/libraries/PositionInfoLibrary.sol";
import {Actions} from "./official-v4/v4-periphery/src/libraries/Actions.sol";

/// @notice Synthetic exact-transfer currency; no admission claim about real tokens.
contract OfficialFixtureToken {
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 amount);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}

/// @notice TEST ONLY. Demonstrates external core unlock and third-party settlement.
/// No Domino policy, fee ledger, economic gate or deployment eligibility is supplied.
contract OfficialV4Controller is IUnlockCallback, ISubscriber {
    using CurrencyLibrary for Currency;
    using BalanceDeltaLibrary for BalanceDelta;
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable manager;
    PositionManager public immutable positions;
    address public immutable owner;
    PoolKey public key;
    uint256 public tokenId;
    uint128 public collected0;
    uint128 public collected1;
    uint128 public paid0;
    uint128 public paid1;
    uint256 public modifyCallbacks;
    bool public subscribed;
    bool public nestedManagerCallRejected;
    uint8 private phase;
    uint128 private expectedIncrease;
    BalanceDelta private collectionDelta;

    constructor(IPoolManager manager_, PositionManager positions_) {
        manager = manager_;
        positions = positions_;
        owner = msg.sender;
    }

    receive() external payable {}

    modifier onlyOwner() {
        require(msg.sender == owner, "fixture owner");
        _;
    }

    function seed(PoolKey memory key_, uint128 liquidity) external onlyOwner {
        require(tokenId == 0, "already seeded");
        key = key_;
        tokenId = positions.nextTokenId();
        manager.unlock(abi.encode(uint8(0), liquidity));
    }

    /// @dev Remove unused setup principal before the fee-only demonstration.
    function refundSetup() external onlyOwner {
        require(!subscribed, "setup ended");
        key.currency0.transfer(owner, key.currency0.balanceOfSelf());
        key.currency1.transfer(owner, key.currency1.balanceOfSelf());
    }

    function subscribe() external onlyOwner {
        positions.subscribe(tokenId, address(this), abi.encode(tokenId));
    }

    function compound(uint128 liquidity) external onlyOwner {
        manager.unlock(abi.encode(uint8(1), liquidity));
    }

    /// @dev Deliberately omit repayment to prove core atomically rejects open debt.
    function compoundWithoutSettlement(uint128 liquidity) external onlyOwner {
        manager.unlock(abi.encode(uint8(2), liquidity));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager) && manager.isUnlocked(), "fixture unlock caller");
        (uint8 operation, uint128 liquidity) = abi.decode(data, (uint8, uint128));
        if (operation == 0) {
            bytes[] memory mintParams = new bytes[](1);
            mintParams[0] = abi.encode(key, int24(-600), int24(600), uint256(liquidity),
                type(uint128).max, type(uint128).max, owner, bytes(""));
            positions.modifyLiquiditiesWithoutUnlock(abi.encodePacked(uint8(Actions.MINT_POSITION)), mintParams);
            _settle(key.currency0, address(positions));
            _settle(key.currency1, address(positions));
        } else {
            require(subscribed && positions.ownerOf(tokenId) == owner, "fixture custody");
            require(positions.getApproved(tokenId) == address(this), "fixture individual approval");
            uint128 beforeLiquidity = positions.getPositionLiquidity(tokenId);
            uint256 before0 = key.currency0.balanceOfSelf();
            uint256 before1 = key.currency1.balanceOfSelf();
            phase = 1;
            bytes[] memory collectParams = new bytes[](2);
            collectParams[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
            collectParams[1] = abi.encode(key.currency0, key.currency1, address(this));
            positions.modifyLiquiditiesWithoutUnlock(
                abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR)), collectParams);
            require(phase == 0, "missing collection callback");
            require(positions.getPositionLiquidity(tokenId) == beforeLiquidity, "collection changed principal");
            require(manager.currencyDelta(address(positions), key.currency0) == 0 &&
                manager.currencyDelta(address(positions), key.currency1) == 0, "collection debt");
            uint256 realized0 = key.currency0.balanceOfSelf() - before0;
            uint256 realized1 = key.currency1.balanceOfSelf() - before1;
            require(collectionDelta.amount0() >= 0 && collectionDelta.amount1() >= 0, "negative fee delta");
            require(realized0 == uint128(collectionDelta.amount0()) &&
                realized1 == uint128(collectionDelta.amount1()), "callback/settlement mismatch");
            collected0 = uint128(realized0);
            collected1 = uint128(realized1);
            phase = 2;
            expectedIncrease = liquidity;
            bytes[] memory increaseParams = new bytes[](1);
            increaseParams[0] = abi.encode(tokenId, uint256(liquidity), collected0, collected1, bytes(""));
            positions.modifyLiquiditiesWithoutUnlock(abi.encodePacked(uint8(Actions.INCREASE_LIQUIDITY)), increaseParams);
            require(phase == 0, "missing increase callback");
            require(positions.getPositionLiquidity(tokenId) == beforeLiquidity + liquidity, "wrong exact increase");
            int256 debt0 = manager.currencyDelta(address(positions), key.currency0);
            int256 debt1 = manager.currencyDelta(address(positions), key.currency1);
            require(debt0 <= 0 && debt1 <= 0 && uint256(-debt0) <= realized0 &&
                uint256(-debt1) <= realized1, "not fee funded");
            paid0 = uint128(uint256(-debt0));
            paid1 = uint128(uint256(-debt1));
            if (operation == 2) return "";
            _settle(key.currency0, address(positions));
            _settle(key.currency1, address(positions));
            require(key.currency0.balanceOfSelf() == before0 + realized0 - paid0 &&
                key.currency1.balanceOfSelf() == before1 + realized1 - paid1, "wrong residual");
        }
        require(manager.currencyDelta(address(positions), key.currency0) == 0 &&
            manager.currencyDelta(address(positions), key.currency1) == 0 &&
            manager.currencyDelta(address(this), key.currency0) == 0 &&
            manager.currencyDelta(address(this), key.currency1) == 0 &&
            manager.getNonzeroDeltaCount() == 0, "unsettled fixture delta");
        return "";
    }

    function _settle(Currency currency, address recipient) private {
        int256 delta = manager.currencyDelta(recipient, currency);
        require(delta <= 0, "expected debt");
        if (delta == 0) return;
        uint256 amount = uint256(-delta);
        manager.sync(currency);
        uint256 settled;
        if (currency.isAddressZero()) settled = manager.settleFor{value: amount}(recipient);
        else {
            currency.transfer(address(manager), amount);
            settled = manager.settleFor(recipient);
        }
        require(settled == amount, "settlement mismatch");
    }

    function notifySubscribe(uint256 id, bytes memory data) external {
        require(msg.sender == address(positions) && id == tokenId && !subscribed &&
            !manager.isUnlocked() && keccak256(data) == keccak256(abi.encode(tokenId)), "fixture subscription");
        subscribed = true;
    }

    function notifyModifyLiquidity(uint256 id, int256 delta, BalanceDelta fees) external {
        require(msg.sender == address(positions) && id == tokenId && manager.isUnlocked(), "fixture modification");
        if (phase == 1) {
            require(delta == 0, "collection liquidity");
            collectionDelta = fees;
        } else {
            require(phase == 2 && delta == int256(uint256(expectedIncrease)) &&
                BalanceDelta.unwrap(fees) == 0, "unexpected increase");
        }
        phase = 0;
        modifyCallbacks++;
        bytes[] memory empty = new bytes[](0);
        (bool nested,) = address(positions).call(abi.encodeCall(
            positions.modifyLiquiditiesWithoutUnlock, (bytes(""), empty)));
        require(!nested, "PositionManager reentrancy lock missing");
        nestedManagerCallRejected = true;
    }

    function notifyUnsubscribe(uint256 id) external {
        require(msg.sender == address(positions) && id == tokenId, "fixture unsubscribe");
        subscribed = false;
    }

    function notifyBurn(uint256, address, PositionInfo, uint256, BalanceDelta) external pure {
        revert("fixture burn prohibited");
    }
}

/// @notice Only real core swaps generate the fixture's earned protocol fees.
contract OfficialV4SwapDriver is IUnlockCallback {
    using CurrencyLibrary for Currency;
    using TransientStateLibrary for IPoolManager;
    IPoolManager public immutable manager;
    address public immutable owner;

    constructor(IPoolManager manager_) { manager = manager_; owner = msg.sender; }
    receive() external payable {}

    function swap(PoolKey calldata key, bool zeroForOne, uint256 amount) external {
        require(msg.sender == owner, "fixture swap owner");
        manager.unlock(abi.encode(key, zeroForOne, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "fixture swap callback");
        (PoolKey memory key, bool zeroForOne, uint256 amount) = abi.decode(data, (PoolKey, bool, uint256));
        manager.swap(key, SwapParams(zeroForOne, -int256(amount),
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), "");
        _resolve(key.currency0);
        _resolve(key.currency1);
        return "";
    }

    function _resolve(Currency currency) private {
        int256 delta = manager.currencyDelta(address(this), currency);
        if (delta > 0) manager.take(currency, address(this), uint256(delta));
        else if (delta < 0) {
            uint256 amount = uint256(-delta);
            manager.sync(currency);
            if (currency.isAddressZero()) manager.settle{value: amount}();
            else {
                currency.transfer(address(manager), amount);
                manager.settle();
            }
        }
    }
}
