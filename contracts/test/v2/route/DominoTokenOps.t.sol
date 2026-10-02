// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoTokenOps} from "../../../src/v2/route/DominoTokenOps.sol";
import {AcceptingRecipient, GasBurningRecipient, RejectingRecipient, TestToken, V2TestBase} from "./V2RouteTestKit.sol";

/// The library's calls, made from a contract that holds tokens and ETH.
contract TokenOpsProbe {
    receive() external payable {}

    function balanceOf(address token, address account) external view returns (uint256) {
        return DominoTokenOps.balanceOf(token, account);
    }

    function allowance(address token, address owner, address spender) external view returns (uint256) {
        return DominoTokenOps.allowance(token, owner, spender);
    }

    function transfer(address token, address to, uint256 amount) external {
        DominoTokenOps.transfer(token, to, amount);
    }

    function tryTransfer(address token, address to, uint256 amount, uint256 gasLimit) external returns (bool) {
        return DominoTokenOps.tryTransfer(token, to, amount, gasLimit);
    }

    function approve(address token, address spender, uint256 amount) external {
        DominoTokenOps.approve(token, spender, amount);
    }
}

/// A contract that answers every call with success and no data.
contract SilentContract {
    fallback() external payable {}
}

/// Token calls that never trust a silent or failing answer for a read, accept
/// ERC-20s without a return value for a transfer (as SafeERC20 does), and copy
/// at most one word of return data.
contract DominoTokenOpsTest is V2TestBase {
    TokenOpsProbe internal probe;
    TestToken internal token;
    address internal silent;

    function setUp() public {
        probe = new TokenOpsProbe();
        token = new TestToken();
        token.mint(address(probe), 1000);
        vm.deal(address(probe), 1 ether);
        silent = address(new SilentContract());
    }

    function _fails(bytes memory data, address culprit, string memory what) internal {
        _expectRevertData(address(probe), data, abi.encodeWithSelector(DominoTokenOps.TokenCallFailed.selector, culprit), what);
    }

    function testReadsAnswerOrRevert() public {
        _eq(probe.balanceOf(address(token), address(probe)), 1000, "ERC-20 balance");
        _eq(probe.balanceOf(address(0), address(probe)), 1 ether, "native balance");
        _fails(abi.encodeCall(TokenOpsProbe.balanceOf, (address(0x1234), address(probe))), address(0x1234), "no code");
        _fails(abi.encodeCall(TokenOpsProbe.balanceOf, (silent, address(probe))), silent, "no answer");
        token.setBroken(1);
        _fails(abi.encodeCall(TokenOpsProbe.balanceOf, (address(token), address(probe))), address(token), "a revert");
        token.setBroken(0);
        vm.prank(address(probe));
        token.approve(address(this), 77);
        _eq(probe.allowance(address(token), address(probe), address(this)), 77, "ERC-20 allowance");
        _fails(abi.encodeCall(TokenOpsProbe.allowance, (silent, address(probe), address(this))), silent, "no answer");
        token.setBroken(2);
        _fails(abi.encodeCall(TokenOpsProbe.allowance, (address(token), address(probe), address(this))), address(token),
            "a revert");
    }

    function testTransfersAcceptTrueOrNothingAndRefuseTheRest() public {
        probe.transfer(address(token), address(0xA), 10);
        _eq(token.balanceOf(address(0xA)), 10, "a true return");
        token.setMode(2);
        probe.transfer(address(token), address(0xA), 10);
        _eq(token.balanceOf(address(0xA)), 20, "no return value (USDT style)");
        token.setMode(1);
        _fails(abi.encodeCall(TokenOpsProbe.transfer, (address(token), address(0xA), 10)), address(token), "false");
        token.setMode(0);
        token.setBlocked(address(0xA), true);
        _fails(abi.encodeCall(TokenOpsProbe.transfer, (address(token), address(0xA), 10)), address(token), "a revert");
        _fails(abi.encodeCall(TokenOpsProbe.transfer, (address(0x1234), address(0xA), 10)), address(0x1234),
            "an address without code is no token");
        // A contract that returns nothing is indistinguishable from a USDT-style
        // token here; the executor and the fee ledger measure balances instead.
        probe.transfer(silent, address(0xA), 10);
    }

    function testNativeTransfers() public {
        AcceptingRecipient wallet = new AcceptingRecipient();
        probe.transfer(address(0), address(wallet), 0.1 ether);
        _eq(wallet.received(), 0.1 ether, "sent");
        address rejecting = address(new RejectingRecipient());
        _fails(abi.encodeCall(TokenOpsProbe.transfer, (address(0), rejecting, 1)), address(0), "refused");
    }

    function testTryTransferNeverRevertsAndCapsGas() public {
        _check(!probe.tryTransfer(address(0), address(new RejectingRecipient()), 1, 100_000), "refused native");
        token.setMode(1);
        _check(!probe.tryTransfer(address(token), address(0xA), 1, 100_000), "a false return");
        token.setMode(0);
        _check(probe.tryTransfer(address(token), address(0xA), 1, 100_000), "a plain transfer");
        address burner = address(new GasBurningRecipient());
        uint256 start = gasleft();
        _check(!probe.tryTransfer(address(0), burner, 1, 30_000), "out of gas");
        _check(start - gasleft() < 60_000, "the callee had only the cap");
    }

    function testApprovalsMustBeAccepted() public {
        probe.approve(address(token), address(0xB), 5);
        _eq(token.allowance(address(probe), address(0xB)), 5, "approved");
        token.setBroken(4);
        _fails(abi.encodeCall(TokenOpsProbe.approve, (address(token), address(0xB), 6)), address(token), "false");
        _fails(abi.encodeCall(TokenOpsProbe.approve, (address(0x1234), address(0xB), 6)), address(0x1234), "no code");
    }
}
