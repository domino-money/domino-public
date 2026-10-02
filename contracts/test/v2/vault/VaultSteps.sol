// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoVaultSwapSteps} from "../../../src/v2/vault/IDominoVaultSteps.sol";
import {MockAnchor, MockToken} from "./VaultMocks.sol";

/// @dev A test double of the swap port, for the exact-number ledger suites on
/// the v3 unit model and for misbehaving modules: it swaps at a fixed rate
/// with a venue. It runs by DELEGATECALL in a vault, so it keeps no state; a
/// suite steers it through StepConfig, which it reads with ordinary calls.
/// The production module is DominoV2VaultSwapModule (F1b's executor), which
/// DominoV2VaultSwapModule.t.sol runs on the deployed v4 PoolManager.
contract StepConfig {
    uint8 internal constant NORMAL = 0;
    /// swap also sends `extra` of its input token to a sink.
    uint8 internal constant OVERSPEND = 1;
    /// swap delivers less than its minimum.
    uint8 internal constant SHORT_OUTPUT = 3;
    /// swap takes less than amountIn.
    uint8 internal constant PARTIAL_INPUT = 4;
    /// swap trips the price anchor (the pool moved out of the band).
    uint8 internal constant MOVE_PRICE = 5;
    /// swap hands the vault's unlock callback to a pool-manager double.
    uint8 internal constant CALLBACK = 6;
    /// swap also calls `hook` with `hookData` (a pool accruing fees to a position).
    uint8 internal constant SWAP_HOOK = 8;

    uint8 public mode;
    uint256 public extra;
    address public hook;
    bytes public hookData;
    address public constant SINK = address(0x5111C);

    function set(uint8 mode_, uint256 extra_) external {
        (mode, extra) = (mode_, extra_);
    }

    function setHook(address hook_, bytes calldata hookData_) external {
        (hook, hookData) = (hook_, hookData_);
    }
}

/// Calls back the unlockCallback of its caller with the data, like the v4
/// pool manager, and returns what the callback returned.
contract CallbackProbe {
    bytes public returned;

    function unlock(bytes calldata data) external returns (bytes memory result) {
        result = IUnlockCallbackProbe(msg.sender).unlockCallback(data);
        returned = result;
    }
}

interface IUnlockCallbackProbe {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// Pays out at a fixed rate from its own balance.
contract MockSwapVenue {
    uint256 public rateNumerator = 1;
    uint256 public rateDenominator = 1;

    receive() external payable {}

    function setRate(uint256 numerator, uint256 denominator) external {
        (rateNumerator, rateDenominator) = (numerator, denominator);
    }

    function pay(address tokenOut, uint256 amountIn, address to) external returns (uint256 out) {
        out = amountIn * rateNumerator / rateDenominator;
        if (tokenOut == address(0)) {
            (bool ok,) = to.call{value: out}("");
            require(ok, "venue native");
        } else {
            MockToken(tokenOut).transfer(to, out);
        }
    }
}

contract MockSwapSteps is IDominoVaultSwapSteps {
    StepConfig public immutable config;
    MockSwapVenue public immutable venue;
    MockAnchor public immutable anchor;
    CallbackProbe public immutable probe;

    constructor(StepConfig config_, MockSwapVenue venue_, MockAnchor anchor_, CallbackProbe probe_) {
        config = config_;
        venue = venue_;
        anchor = anchor_;
        probe = probe_;
    }

    /// The pool manager's callback, reached through the vault while this step runs.
    function unlockCallback(bytes calldata data) external pure returns (bytes memory) {
        return abi.encode(keccak256(data));
    }

    /// Takes legs[0].amountIn of tokenIn and pays at the venue's rate; the
    /// modes misbehave against legs[0].minAmountOut / amountIn.
    function swap(DominoV2Types.SwapLeg[] calldata legs, address tokenIn, address tokenOut) external {
        uint8 mode = config.mode();
        uint256 amountIn = legs[0].amountIn;
        uint256 spent = mode == 4 ? amountIn - 1 : amountIn;
        if (tokenIn == address(0)) {
            (bool ok,) = address(venue).call{value: spent}("");
            require(ok, "swap native");
        } else {
            MockToken(tokenIn).transfer(address(venue), spent);
        }
        uint256 amountOut = venue.pay(tokenOut, spent, address(this));
        if (mode == 3) MockToken(tokenOut).transfer(config.SINK(), amountOut - (legs[0].minAmountOut - 1));
        if (mode == 5) anchor.setOutside(true);
        if (mode == 6) probe.unlock(abi.encode(amountIn));
        if (mode == 8) {
            (bool ok,) = config.hook().call(config.hookData());
            require(ok, "swap hook");
        }
        if (mode == 1) MockToken(tokenIn).transfer(config.SINK(), config.extra());
    }
}
