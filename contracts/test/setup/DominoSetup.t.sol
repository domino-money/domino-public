// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {DominoSetup} from "../../src/DominoSetup.sol";
import {DominoVaultTypes as T} from "../../src/DominoVaultTypes.sol";
import {PoolManager, PositionManager, IPoolManager, PoolKey, Currency} from "../reference/OfficialV4Fixture.sol";
import {StateView} from "../reference/official-v4/v4-periphery/src/lens/StateView.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPositionDescriptor} from "../reference/official-v4/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "../reference/official-v4/v4-periphery/src/interfaces/external/IWETH9.sol";

interface SetupVm { function deal(address, uint256) external; function prank(address) external; function warp(uint256) external; }
contract SetupToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }
}
contract DominoSetupTest {
    SetupVm private constant vm = SetupVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    IPoolManager private manager;
    PositionManager private positions;
    DominoSetup private setup;
    T.PoolKey private key;
    address private constant TREASURY = address(0xFEE);
    receive() external payable {}

    function _deploy(bool nativePair) private {
        manager = IPoolManager(address(new PoolManager(address(this))));
        positions = new PositionManager(manager, IAllowanceTransfer(address(0x1111)), 100_000,
            IPositionDescriptor(address(0x2222)), IWETH9(address(0x3333)));
        setup = new DominoSetup(address(manager), address(positions), address(new StateView(manager)), TREASURY, 65, 1);
        address a = address(new SetupToken()); address b = address(new SetupToken());
        key = T.PoolKey(nativePair ? address(0) : (a < b ? a : b), nativePair ? a : (a < b ? b : a), 3000, 60, address(0));
        vm.deal(address(this), 1e22);
        if (key.currency0 != address(0)) { SetupToken(key.currency0).mint(address(this), 1e22); SetupToken(key.currency0).approve(address(setup), 1e22); }
        SetupToken(key.currency1).mint(address(this), 1e22); SetupToken(key.currency1).approve(address(setup), 1e22);
    }
    function _open(uint128 a, uint128 b) private returns (bytes32 id) {
        id = setup.nextOperationId(address(this));
        setup.open{value: key.currency0 == address(0) ? a : 0}(id, key, a, b);
    }
    function _mint(bytes32 id, bool create) private {
        setup.mint(DominoSetup.MintPlan(id, -600, 600, 1e18, 1e20, 1e20,
            uint160(uint256(1 << 96) * 99 / 100), uint160(uint256(1 << 96) * 101 / 100), create ? uint160(1 << 96) : 0, uint64(block.timestamp + 120)));
    }
    function _seed() private { _mint(_open(1e20, 1e20), true); }
    function _swap(bytes32 id, uint128 minimum) private {
        setup.swap(DominoSetup.SwapPlan(id, true, 1e14, minimum, 4_295_128_740, uint64(block.timestamp + 120)));
    }
    function _balance(address token, address account) private view returns (uint256) { return token == address(0) ? account.balance : SetupToken(token).balanceOf(account); }

    function testAdvancedCreationMintsNftToOwnerAndRefundsBothCurrencies() public {
        _deploy(false); _seed();
        require(positions.ownerOf(1) == address(this) && positions.getPositionLiquidity(1) == 1e18, "mint identity");
        require(_balance(key.currency0, address(setup)) == 0 && _balance(key.currency1, address(setup)) == 0, "refunds");
        require(_balance(key.currency0, TREASURY) == 0 && _balance(key.currency1, TREASURY) == 0, "direct deposit fee");
    }
    function testNativeSetupMintAndRefund() public {
        _deploy(true); _seed(); require(address(setup).balance == 0 && positions.ownerOf(1) == address(this), "native refund");
    }
    function testSuccessfulSwapThenCancelledMintReturnsOutputWithoutRepeatingFee() public {
        _deploy(false); _seed(); bytes32 id = _open(1e14, 0); _swap(id, 1);
        DominoSetup.Operation memory op = setup.operation(id);
        require(op.swapped && op.balance0 == 0 && op.balance1 > 0 && !op.closed, "swap persisted");
        uint256 fee = _balance(key.currency0, TREASURY); require(fee == 65e10, "gross tariff");
        uint256 before = _balance(key.currency1, address(this));
        setup.cancel(id);
        require(_balance(key.currency1, address(this)) == before + op.balance1 && _balance(key.currency0, TREASURY) == fee, "recovery conservation");
        (bool again,) = address(setup).call(abi.encodeCall(setup.cancel, (id))); require(!again, "duplicate refund");
    }
    function testSwapMinimumRevertsFeeAndInputThenRetryIsSingleEffect() public {
        _deploy(false); _seed(); bytes32 id = _open(1e14, 0);
        (bool ok,) = address(setup).call(abi.encodeCall(setup.swap, (DominoSetup.SwapPlan(id, true, 1e14, 1e20, 4_295_128_740, uint64(block.timestamp + 120)))));
        require(!ok && !setup.operation(id).swapped && setup.operation(id).balance0 == 1e14 && _balance(key.currency0, TREASURY) == 0, "atomic failed swap");
        _swap(id, 1);
        (ok,) = address(setup).call(abi.encodeCall(setup.swap, (DominoSetup.SwapPlan(id, true, 1e14, 1, 4_295_128_740, uint64(block.timestamp + 120)))));
        require(!ok && _balance(key.currency0, TREASURY) == 65e10, "duplicate swap fee");
    }
    function testExpiredMintAndForeignRecoveryCannotSpendEscrowOwnerCanExit() public {
        _deploy(false); bytes32 id = _open(1e20, 1e20);
        vm.prank(address(0xBAD)); (bool stolen,) = address(setup).call(abi.encodeCall(setup.cancel, (id))); require(!stolen, "foreign cancellation");
        vm.warp(2000);
        (bool minted,) = address(setup).call(abi.encodeCall(setup.mint, (DominoSetup.MintPlan(id, -600, 600, 1e18, 1e20, 1e20, 1, type(uint160).max, uint160(1 << 96), 1999))));
        require(!minted && !setup.operation(id).closed, "expired mint");
        setup.cancel(id); require(setup.operation(id).closed, "owner exit needs no service");
    }
    function testRejectedMintRetainsPreviouslySwappedBalanceAndDoesNotReinitializeExistingPool() public {
        _deploy(false); _seed(); bytes32 id = _open(1e20, 1e20); _swap(id, 1);
        DominoSetup.Operation memory beforeOp = setup.operation(id);
        (bool ok,) = address(setup).call(abi.encodeCall(setup.mint, (DominoSetup.MintPlan(id, -600, 600, 1e18, 1e20, 1e20,
            uint160(uint256(1 << 96) * 99 / 100), uint160(uint256(1 << 96) * 101 / 100), uint160(1 << 96), uint64(block.timestamp + 120)))));
        require(!ok && setup.operation(id).balance0 == beforeOp.balance0 && setup.operation(id).balance1 == beforeOp.balance1, "swap recovery survives failed mint");
        setup.cancel(id);
    }
    function testOwnerBoundOperationIdsPreventFrontRunningAndReplay() public {
        _deploy(false); bytes32 id = setup.nextOperationId(address(this));
        vm.prank(address(0xBAD)); (bool ok,) = address(setup).call(abi.encodeCall(setup.open, (id, key, uint128(1), uint128(1))));
        require(!ok, "front-run operation id");
        _open(1, 1); setup.cancel(id);
        (ok,) = address(setup).call(abi.encodeCall(setup.open, (id, key, uint128(1), uint128(1)))); require(!ok, "reopen consumed operation");
    }
}
