// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoSetup} from "../../src/DominoSetup.sol";
import {DominoVaultTypes as T} from "../../src/DominoVaultTypes.sol";

interface AuditSetupVm {
    function deal(address target, uint256 value) external;
    function etch(address target, bytes calldata code) external;
}

contract AuditSetupManager {}

contract AuditSetupDependency {
    address public immutable poolManager;
    constructor(address manager) { poolManager = manager; }
}

contract AuditPausableSetupToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public paused;
    uint256 public tax;

    function mint(address account, uint256 amount) external { balanceOf[account] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function setPaused(bool value) external { paused = value; }
    function setTax(uint256 value) external { tax = value; }
    function transfer(address recipient, uint256 amount) external returns (bool) {
        require(!paused, "issuer paused transfer");
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount - tax;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(!paused, "issuer paused transfer");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - tax;
        return true;
    }
}

/// @notice Direct regression probes of production DominoSetup. The manager and
/// read dependencies are never invoked by open/cancel; no pool mutation is mocked.
contract AuditSetupRefundIsolationTest {
    AuditSetupVm private constant vm = AuditSetupVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    DominoSetup private setup;
    AuditPausableSetupToken private token;
    bytes32 private operationId;
    uint128 private constant NATIVE_AMOUNT = 1 ether;
    uint128 private constant TOKEN_AMOUNT = 1000;

    receive() external payable {}

    function setUp() public {
        address manager = address(new AuditSetupManager());
        address positions = address(new AuditSetupDependency(manager));
        address viewContract = address(new AuditSetupDependency(manager));
        setup = new DominoSetup(manager, positions, viewContract, address(0xFEE), 65, 1);
        token = new AuditPausableSetupToken();
        token.mint(address(this), TOKEN_AMOUNT);
        token.approve(address(setup), TOKEN_AMOUNT);
        vm.deal(address(this), NATIVE_AMOUNT);
        operationId = setup.nextOperationId(address(this));
        setup.open{value: NATIVE_AMOUNT}(operationId,
            T.PoolKey(address(0), address(token), 3000, 60, address(0)), NATIVE_AMOUNT, TOKEN_AMOUNT);
    }

    function testIssuerPauseAlsoPreventsRefundOfHealthyNativeCounterasset() public {
        token.setPaused(true);
        _assertFailedCancelPreservesBothEscrows();

        // Clearing the issuer restriction alone releases both assets, proving
        // the healthy native refund depended on the other currency's transfer.
        token.setPaused(false);
        setup.cancel(operationId);
        require(address(this).balance == NATIVE_AMOUNT, "native not refunded after unpause");
        require(token.balanceOf(address(this)) == TOKEN_AMOUNT, "token refund");
        require(setup.operation(operationId).closed, "operation did not close");
    }

    function testRecipientTaxAlsoPreventsExactDebitAndNativeRefund() public {
        token.setTax(1);
        _assertFailedCancelPreservesBothEscrows();

        token.setTax(0);
        setup.cancel(operationId);
        require(address(this).balance == NATIVE_AMOUNT, "native not refunded after tax removed");
    }

    function testHealthyCounterassetRemainsLockedWithAllServicesAbsent() public {
        token.setPaused(true);
        vm.etch(address(setup.manager()), "");
        vm.etch(address(setup.positions()), "");
        vm.etch(address(setup.stateView()), "");
        _assertFailedCancelPreservesBothEscrows();
    }

    function _assertFailedCancelPreservesBothEscrows() private {
        (bool ok, bytes memory revertData) = address(setup).call(abi.encodeCall(DominoSetup.cancel, (operationId)));
        require(!ok && bytes4(revertData) == DominoSetup.InvalidSetup.selector, "cancel unexpectedly succeeded");
        require(address(this).balance == 0 && address(setup).balance == NATIVE_AMOUNT, "native refund escaped rollback");
        require(token.balanceOf(address(this)) == 0 && token.balanceOf(address(setup)) == TOKEN_AMOUNT, "token transfer survived rollback");
        DominoSetup.Operation memory op = setup.operation(operationId);
        require(!op.closed && op.balance0 == NATIVE_AMOUNT && op.balance1 == TOKEN_AMOUNT, "escrow state changed");
    }
}
