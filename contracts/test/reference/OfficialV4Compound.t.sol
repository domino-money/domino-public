// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OfficialFixtureToken, OfficialV4Controller, OfficialV4SwapDriver, PoolManager,
    PositionManager, IPoolManager, PoolKey, Currency} from "./OfficialV4Fixture.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPositionDescriptor} from "./official-v4/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "./official-v4/v4-periphery/src/interfaces/external/IWETH9.sol";

interface VmOfficialFixture {
    function deal(address account, uint256 balance) external;
    function expectRevert(bytes4 selector) external;
}

contract OfficialV4CompoundTest {
    using TransientStateLibrary for IPoolManager;
    VmOfficialFixture private constant vm = VmOfficialFixture(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint128 private constant OPENING_LIQUIDITY = 1e18;
    uint128 private constant COMPOUND_LIQUIDITY = 1e12;
    IPoolManager private manager;
    PositionManager private positions;
    OfficialV4Controller private controller;
    OfficialV4SwapDriver private trader;
    PoolKey private key;

    receive() external payable {}

    function _setup(bool nativePair) private {
        manager = IPoolManager(address(new PoolManager(address(this))));
        // These unused addresses deliberately contain no callable token/Permit2
        // implementation: the demonstrated path never calls them or pulls a wallet.
        positions = new PositionManager(manager, IAllowanceTransfer(address(0x1111)), 100_000,
            IPositionDescriptor(address(0x2222)), IWETH9(address(0x3333)));
        controller = new OfficialV4Controller(manager, positions);
        trader = new OfficialV4SwapDriver(manager);
        OfficialFixtureToken a = new OfficialFixtureToken();
        OfficialFixtureToken b = new OfficialFixtureToken();
        address currency0 = nativePair ? address(0) : (address(a) < address(b) ? address(a) : address(b));
        address currency1 = nativePair ? address(a) : (address(a) < address(b) ? address(b) : address(a));
        key = PoolKey(Currency.wrap(currency0), Currency.wrap(currency1), 3000, 60, IHooks(address(0)));
        if (nativePair) {
            vm.deal(address(controller), 1e20);
            vm.deal(address(trader), 1e20);
        } else {
            OfficialFixtureToken(currency0).mint(address(controller), 1e20);
            OfficialFixtureToken(currency0).mint(address(trader), 1e20);
        }
        OfficialFixtureToken(currency1).mint(address(controller), 1e20);
        OfficialFixtureToken(currency1).mint(address(trader), 1e20);
        manager.initialize(key, uint160(1 << 96));
        controller.seed(key, OPENING_LIQUIDITY);
        controller.refundSetup();
        positions.approve(address(controller), controller.tokenId());
        controller.subscribe();
        // Both currencies accrue trading fees; no PoolManager.donate or synthetic
        // storage mutation supplies the credit later consumed by the controller.
        trader.swap(key, true, 1e15);
        trader.swap(key, false, 1e15);
    }

    function _verifyCompound() private {
        uint256 id = controller.tokenId();
        uint256 owner0 = _balance(key.currency0, address(this));
        uint256 owner1 = _balance(key.currency1, address(this));
        require(_balance(key.currency0, address(controller)) == 0 &&
            _balance(key.currency1, address(controller)) == 0, "opening reserve must be zero");
        require(positions.ownerOf(id) == address(this) && positions.getApproved(id) == address(controller),
            "individual NFT approval");
        controller.compound(COMPOUND_LIQUIDITY);
        require(positions.getPositionLiquidity(id) == OPENING_LIQUIDITY + COMPOUND_LIQUIDITY, "exact liquidity");
        require(controller.collected0() > 0 && controller.collected1() > 0 &&
            controller.paid0() > 0 && controller.paid1() > 0, "real two-currency fees and addition");
        require(controller.paid0() < controller.collected0() && controller.paid1() < controller.collected1(),
            "fee-only spent and residual");
        require(_balance(key.currency0, address(controller)) == controller.collected0() - controller.paid0() &&
            _balance(key.currency1, address(controller)) == controller.collected1() - controller.paid1(), "residual delivery");
        require(_balance(key.currency0, address(this)) == owner0 && _balance(key.currency1, address(this)) == owner1,
            "no owner wallet pull");
        require(positions.ownerOf(id) == address(this) && positions.getApproved(id) == address(controller) &&
            address(positions.subscriber(id)) == address(controller), "authority preserved");
        require(controller.modifyCallbacks() == 2 && controller.nestedManagerCallRejected(), "narrow callbacks");
        require(!manager.isUnlocked() && manager.getNonzeroDeltaCount() == 0, "core relocked and settled");
    }

    function testOfficialErc20PairGeneralCompoundSettlesPositionManagerDebt() public {
        _setup(false);
        _verifyCompound();
    }

    function testOfficialNativePairGeneralCompoundSettlesPositionManagerDebt() public {
        _setup(true);
        _verifyCompound();
    }

    function testOfficialUnsettledCompoundRevertsAllCollectionAndLiquidity() public {
        _setup(false);
        uint256 id = controller.tokenId();
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        controller.compoundWithoutSettlement(COMPOUND_LIQUIDITY);
        require(positions.getPositionLiquidity(id) == OPENING_LIQUIDITY && controller.modifyCallbacks() == 0,
            "failed unlock changed state");
        require(_balance(key.currency0, address(controller)) == 0 &&
            _balance(key.currency1, address(controller)) == 0, "failed collection escaped rollback");
        // A retry still realizes all fees and performs exactly one addition.
        _verifyCompound();
    }

    function testOfficialInsufficientEarnedFeesCannotUseOwnerPrincipal() public {
        _setup(false);
        uint256 owner0 = _balance(key.currency0, address(this));
        uint256 owner1 = _balance(key.currency1, address(this));
        // The wallet retains setup principal; the controller has only the new
        // protocol fees. This increase needs more than the collected fee budgets.
        (bool ok,) = address(controller).call(abi.encodeCall(controller.compound, (uint128(1e16))));
        require(!ok && positions.getPositionLiquidity(controller.tokenId()) == OPENING_LIQUIDITY &&
            controller.modifyCallbacks() == 0, "fee shortfall did not roll back");
        require(_balance(key.currency0, address(this)) == owner0 &&
            _balance(key.currency1, address(this)) == owner1, "owner principal changed");
        _verifyCompound();
    }

    function testOfficialPositionManagerRequiresAnExistingCoreUnlock() public {
        _setup(false);
        bytes[] memory params = new bytes[](1);
        params[0] = abi.encode(controller.tokenId(), uint256(0), uint128(0), uint128(0), bytes(""));
        vm.expectRevert(IPoolManager.ManagerLocked.selector);
        positions.modifyLiquiditiesWithoutUnlock(hex"01", params);
        require(positions.getPositionLiquidity(controller.tokenId()) == OPENING_LIQUIDITY,
            "locked call changed liquidity");
    }

    function _balance(Currency currency, address account) private view returns (uint256) {
        return Currency.unwrap(currency) == address(0) ? account.balance :
            OfficialFixtureToken(Currency.unwrap(currency)).balanceOf(account);
    }
}
