// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoSetup} from "../../src/DominoSetup.sol";
import {DominoVaultTypes as T} from "../../src/DominoVaultTypes.sol";

interface RecoveryVm {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function deal(address account, uint256 amount) external;
    function prank(address account) external;
    function etch(address target, bytes calldata code) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract RecoveryManager {}
contract RecoveryDependency {
    address public immutable poolManager;
    constructor(address manager) { poolManager = manager; }
}

contract RecoveryToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public paused;
    uint256 public tax;
    uint256 public extraDebit;
    address private _callbackTarget;
    bytes private _callbackData;
    bool public callbackAttempted;
    bool public callbackSucceeded;
    function mint(address owner, uint256 amount) external { balanceOf[owner] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function configure(bool paused_, uint256 tax_, uint256 extraDebit_) external {
        paused = paused_; tax = tax_; extraDebit = extraDebit_;
    }
    function callback(address target, bytes calldata data) external {
        _callbackTarget = target; _callbackData = data;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        if (_callbackTarget != address(0)) {
            callbackAttempted = true;
            (callbackSucceeded,) = _callbackTarget.call(_callbackData);
        }
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount; _transfer(from, to, amount); return true;
    }
    function _transfer(address from, address to, uint256 amount) private {
        require(!paused, "issuer paused transfer");
        balanceOf[from] -= amount + extraDebit;
        balanceOf[to] += amount - tax;
    }
}

contract RecoveryOwner {
    address private _target;
    bytes private _data;
    bool public attempted;
    bool public succeeded;
    bytes4 public errorSelector;
    function configure(address target, bytes calldata data) external { _target = target; _data = data; }
    function invoke(address target, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory result) = target.call{value: msg.value}(data);
        require(ok, "owner invocation failed"); return result;
    }
    receive() external payable {
        if (_target != address(0)) {
            attempted = true;
            bytes memory returned;
            (succeeded, returned) = _target.call(_data);
            errorSelector = bytes4(returned);
        }
    }
}

contract SetupRecoveryTest {
    RecoveryVm private constant vm = RecoveryVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OTHER = address(0xBEEF);
    address private constant TREASURY = address(0xFEE);
    DominoSetup private setup;
    RecoveryToken private token;
    T.PoolKey private key;
    bytes32 private id;
    receive() external payable {}

    function setUp() public {
        address manager = address(new RecoveryManager());
        setup = new DominoSetup(manager, address(new RecoveryDependency(manager)),
            address(new RecoveryDependency(manager)), TREASURY, 65, 1);
        token = new RecoveryToken();
        key = T.PoolKey(address(0), address(token), 3000, 60, address(0));
        token.mint(address(this), 1000);
        token.approve(address(setup), 1000);
        vm.deal(address(this), 1 ether);
        id = setup.nextOperationId(address(this));
        setup.open{value: 1 ether}(id, key, 1 ether, 1000);
    }

    function testRestrictedCurrencyDoesNotBlockHealthyRecoveryAndClaimSurvives() public {
        token.configure(true, 0, 0);
        _fails(abi.encodeCall(setup.cancel, (id)));
        setup.recoverCurrency(id, address(0), 1 ether);
        DominoSetup.Operation memory op = setup.operation(id);
        require(address(this).balance == 1 ether && address(setup).balance == 0, "healthy native refund");
        require(setup.recoveryStarted(id) && !op.closed && op.balance0 == 0 && op.balance1 == 1000,
            "restricted claim lost");
        _fails(abi.encodeCall(setup.recoverCurrency, (id, address(token), uint128(1000))));
        require(setup.operation(id).balance1 == 1000, "failed recovery debited claim");
        token.configure(false, 0, 0);
        setup.recoverCurrency(id, address(token), 1000);
        require(setup.operation(id).closed && token.balanceOf(address(this)) == 1000, "later token recovery");
        require(token.balanceOf(TREASURY) == 0 && TREASURY.balance == 0, "recovery toll");
    }

    function testPartialRecoveryPermanentlyDisablesMintAndSwap() public {
        setup.recoverCurrency(id, address(0), 1);
        _fails(abi.encodeCall(setup.swap, (DominoSetup.SwapPlan(id, true, 1, 1, 1, uint64(block.timestamp + 60)))));
        _fails(abi.encodeCall(setup.mint, (DominoSetup.MintPlan(id, -60, 60, 1, 1, 1, 1,
            type(uint160).max, 0, uint64(block.timestamp + 60)))));
        require(setup.operation(id).balance0 == 1 ether - 1 && setup.operation(id).balance1 == 1000,
            "blocked action consumed funds");
        setup.cancel(id);
        require(setup.operation(id).closed && address(this).balance == 1 ether, "cancel remaining claim");
    }

    function testPartialRecoveryNeedsNoPoolPositionOrReadDependency() public {
        token.configure(true, 0, 0);
        vm.etch(address(setup.manager()), "");
        vm.etch(address(setup.positions()), "");
        vm.etch(address(setup.stateView()), "");
        setup.recoverCurrency(id, address(0), 1 ether);
        token.configure(false, 0, 0);
        setup.recoverCurrency(id, address(token), 1000);
        require(setup.operation(id).closed, "dependency blocked recovery");
    }

    function testForeignOwnerCannotRecoverOrStartCancellation() public {
        vm.prank(OTHER);
        _fails(abi.encodeCall(setup.recoverCurrency, (id, address(0), uint128(1 ether))));
        require(!setup.recoveryStarted(id) && setup.operation(id).balance0 == 1 ether, "foreign mutation");
        token.mint(OTHER, 700);
        vm.prank(OTHER); token.approve(address(setup), 700);
        bytes32 otherId = setup.nextOperationId(OTHER);
        vm.prank(OTHER); setup.open(otherId, key, 0, 700);
        setup.recoverCurrency(id, address(token), 1000);
        require(token.balanceOf(address(setup)) == 700 && setup.operation(otherId).balance1 == 700,
            "other owner collateral consumed");
        vm.prank(OTHER); setup.recoverCurrency(otherId, address(token), 700);
        require(token.balanceOf(OTHER) == 700 && setup.operation(otherId).closed, "other owner claim");
    }

    function testZeroUnknownCurrencyUnknownOperationAndExcessAmountsReject() public {
        _fails(abi.encodeCall(setup.recoverCurrency, (id, address(0), uint128(0))));
        _fails(abi.encodeCall(setup.recoverCurrency, (id, OTHER, uint128(1))));
        _fails(abi.encodeCall(setup.recoverCurrency, (bytes32(uint256(42)), address(0), uint128(1))));
        _fails(abi.encodeCall(setup.recoverCurrency, (id, address(0), uint128(1 ether + 1))));
        _fails(abi.encodeCall(setup.recoverCurrency, (id, address(token), uint128(1001))));
        require(!setup.recoveryStarted(id) && setup.operation(id).balance1 == 1000, "invalid recovery changed state");
    }

    function testTaxedReceiptReportsEscrowDebitAndActualOwnerBalances() public {
        token.configure(false, 7, 0);
        _fails(abi.encodeCall(setup.cancel, (id)));
        vm.recordLogs();
        setup.recoverCurrency(id, address(token), 1000);
        RecoveryVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(setup)
            && logs[0].topics[0] == keccak256("SetupCurrencyRecovered(bytes32,address,address,uint128,uint256,uint256)"),
            "recovery receipt event");
        (uint128 debited, uint256 beforeOwner, uint256 afterOwner) = abi.decode(logs[0].data, (uint128, uint256, uint256));
        require(debited == 1000 && beforeOwner == 0 && afterOwner == 993, "receipt mislabeled taxed payment");
        require(token.balanceOf(address(setup)) == 0 && setup.operation(id).balance1 == 0, "taxed escrow debit");
        setup.cancel(id);
        require(setup.operation(id).closed && address(this).balance == 1 ether, "remaining native refund");
    }

    function testRecoveryRejectsExtraEscrowDebitsWithoutTouchingOtherClaims() public {
        token.mint(address(setup), 100);
        token.configure(false, 0, 1);
        _fails(abi.encodeCall(setup.recoverCurrency, (id, address(token), uint128(1000))));
        require(token.balanceOf(address(setup)) == 1100 && token.balanceOf(address(this)) == 0
            && setup.operation(id).balance1 == 1000 && !setup.recoveryStarted(id), "inexact debit survived");
    }

    function testTokenCallbackCannotRecoverAnotherCurrency() public {
        token.callback(address(setup), abi.encodeCall(setup.recoverCurrency, (id, address(0), uint128(1 ether))));
        setup.recoverCurrency(id, address(token), 1000);
        require(token.callbackAttempted() && !token.callbackSucceeded(), "token callback reentered");
        require(setup.operation(id).balance0 == 1 ether && address(setup).balance == 1 ether, "native claim spent");
    }

    function testOwnerCallbackCannotReenterRecoveryOrCancel() public {
        RecoveryOwner owner = new RecoveryOwner();
        bytes32 ownerId = setup.nextOperationId(address(owner));
        vm.deal(address(this), 1 ether);
        owner.invoke{value: 1 ether}(address(setup), abi.encodeCall(setup.open, (ownerId, key, uint128(1 ether), uint128(0))));
        owner.configure(address(setup), abi.encodeCall(setup.cancel, (ownerId)));
        owner.invoke(address(setup), abi.encodeCall(setup.recoverCurrency, (ownerId, address(0), uint128(0.5 ether))));
        require(owner.attempted() && !owner.succeeded() && owner.errorSelector() == DominoSetup.InvalidSetup.selector,
            "owner callback reentered cancellation");
        require(setup.operation(ownerId).balance0 == 0.5 ether && address(owner).balance == 0.5 ether, "owner double payout");
        owner.configure(address(setup), abi.encodeCall(setup.recoverCurrency, (ownerId, address(0), uint128(0.5 ether))));
        owner.invoke(address(setup), abi.encodeCall(setup.recoverCurrency, (ownerId, address(0), uint128(0.5 ether))));
        require(!owner.succeeded() && setup.operation(ownerId).closed && address(owner).balance == 1 ether, "final reentry");
    }

    function testOrdinaryCancelPreservesSingleClosedEventAndOperationTuple() public {
        vm.recordLogs();
        setup.cancel(id);
        RecoveryVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].topics[0] == keccak256("SetupClosed(bytes32,address,uint128,uint128)"),
            "ordinary cancellation events changed");
        (uint128 amount0, uint128 amount1) = abi.decode(logs[0].data, (uint128, uint128));
        require(amount0 == 1 ether && amount1 == 1000 && setup.operation(id).closed, "ordinary close amounts");
        (bool ok, bytes memory result) = address(setup).staticcall(abi.encodeCall(setup.operation, (id)));
        require(ok && result.length == 11 * 32, "operation ABI changed");
        _fails(abi.encodeCall(setup.recoverCurrency, (id, address(0), uint128(1))));
    }

    function testFinalRecoveryClosesOnceAndReportsOnlyFinalTransfer() public {
        setup.recoverCurrency(id, address(0), 1 ether);
        vm.recordLogs();
        setup.recoverCurrency(id, address(token), 1000);
        RecoveryVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2 && logs[1].topics[0] == keccak256("SetupClosed(bytes32,address,uint128,uint128)"),
            "final closure absent");
        (uint128 amount0, uint128 amount1) = abi.decode(logs[1].data, (uint128, uint128));
        require(amount0 == 0 && amount1 == 1000, "closing receipt counted earlier transfer");
        _fails(abi.encodeCall(setup.cancel, (id)));
        _fails(abi.encodeCall(setup.recoverCurrency, (id, address(token), uint128(1000))));
    }

    function _fails(bytes memory data) private {
        (bool ok, bytes memory result) = address(setup).call(data);
        require(!ok && bytes4(result) == DominoSetup.InvalidSetup.selector, "expected InvalidSetup");
    }
}
