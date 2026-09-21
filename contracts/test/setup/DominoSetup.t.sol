// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {DominoSetup} from "../../src/DominoSetup.sol";
import {DominoVaultTypes as T} from "../../src/DominoVaultTypes.sol";
import {PoolManager, PositionManager, IPoolManager, PoolKey} from "../reference/OfficialV4Fixture.sol";
import {StateView} from "../reference/official-v4/v4-periphery/src/lens/StateView.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPositionDescriptor} from "../reference/official-v4/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "../reference/official-v4/v4-periphery/src/interfaces/external/IWETH9.sol";

interface SetupVm { function deal(address, uint256) external; function prank(address) external; function warp(uint256) external;
    function store(address, bytes32, bytes32) external; }
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
    function testPartialRecoveryAfterSwapReturnsBothClaimsWithoutRepeatingFee() public {
        _deploy(true); _seed(); bytes32 id = _open(1e18, 0); _swap(id, 1);
        DominoSetup.Operation memory beforeOp = setup.operation(id);
        uint256 fee = TREASURY.balance;
        uint256 tokenBefore = _balance(key.currency1, address(this));
        setup.recoverCurrency(id, key.currency0, beforeOp.balance0);
        require(setup.recoveryStarted(id) && !setup.operation(id).closed
            && setup.operation(id).balance1 == beforeOp.balance1, "post-swap claim retained");
        setup.recoverCurrency(id, key.currency1, beforeOp.balance1);
        require(setup.operation(id).closed && setup.operation(id).swapped
            && _balance(key.currency1, address(this)) == tokenBefore + beforeOp.balance1
            && TREASURY.balance == fee, "post-swap recovery charged or lost output");
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
    /**
     * The unlock callback, forged, clause by clause.
     *
     * Its guard is four disjuncts and an earlier version of this test reached
     * only the first two, because every case it built left `_entered` false.
     * Each case below makes exactly one clause true, so deleting that clause
     * alone fails this test - except the third, which no case can isolate:
     * when `_callback` is zero, `keccak256(data) != _callback` is true as
     * well, so `_callback == bytes32(0)` can never be the clause that decides.
     * It is redundant, not merely untested, and is recorded as such in
     * reports/CONTRACT_HYGIENE_MINOR_2026-09-19.md.
     *
     * `_entered` is slot 2 and `_callback` slot 3: the two mappings above them
     * take one slot each and the immutables take none.
     */
    function testUnlockCallbackRefusesEachForgedClause() external {
        _deploy(false);
        bytes memory payload = abi.encode(uint8(1), bytes(""));
        bytes32 armed = keccak256(payload);
        bytes32 ENTERED = bytes32(uint256(2));
        bytes32 CALLBACK = bytes32(uint256(3));

        // Clause 1 alone: everything else satisfied, wrong caller.
        vm.store(address(setup), ENTERED, bytes32(uint256(1)));
        vm.store(address(setup), CALLBACK, armed);
        (bool ok, bytes memory out) = address(setup).call(
            abi.encodeCall(DominoSetup.unlockCallback, (payload)));
        require(!ok && bytes4(out) == DominoSetup.InvalidSetup.selector, "only the pool manager");

        // Clause 2 alone: the pool manager, with the payload it armed, but no
        // operation in flight.
        vm.store(address(setup), ENTERED, bytes32(0));
        vm.prank(address(manager));
        (ok, out) = address(setup).call(abi.encodeCall(DominoSetup.unlockCallback, (payload)));
        require(!ok && bytes4(out) == DominoSetup.InvalidSetup.selector, "no operation is in flight");

        // Clause 4 alone: the pool manager, inside an operation, handing back
        // a payload other than the one the operation committed to. This is the
        // clause that stops a different swap or mint plan executing inside a
        // legitimate unlock, and nothing reached it before.
        vm.store(address(setup), ENTERED, bytes32(uint256(1)));
        vm.store(address(setup), CALLBACK, armed);
        vm.prank(address(manager));
        (ok, out) = address(setup).call(abi.encodeCall(
            DominoSetup.unlockCallback, (abi.encode(uint8(2), bytes("")))));
        require(!ok && bytes4(out) == DominoSetup.InvalidSetup.selector, "the payload must be the armed one");

        vm.store(address(setup), ENTERED, bytes32(0));
        vm.store(address(setup), CALLBACK, bytes32(0));
    }

    function testOwnerBoundOperationIdsPreventFrontRunningAndReplay() public {
        _deploy(false); bytes32 id = setup.nextOperationId(address(this));
        vm.prank(address(0xBAD)); (bool ok,) = address(setup).call(abi.encodeCall(setup.open, (id, key, uint128(1), uint128(1))));
        require(!ok, "front-run operation id");
        _open(1, 1); setup.cancel(id);
        (ok,) = address(setup).call(abi.encodeCall(setup.open, (id, key, uint128(1), uint128(1)))); require(!ok, "reopen consumed operation");
    }
}
