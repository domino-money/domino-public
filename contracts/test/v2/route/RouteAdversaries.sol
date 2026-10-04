// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestToken} from "./V2RouteTestKit.sol";

/// Permit2's AllowanceTransfer pull, as the Universal Router calls it.
interface IPermit2Pull {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/// A router the registry admits, scripted per call. The honest script is
/// what the Universal Router does for an exact-input swap paid through
/// Permit2: pull exactly the input from the caller, pay the output to the
/// caller. Every other field is one way to misbehave.
/// A scripted leg's calldata in the Universal Router's execute shape: one
/// swap command (0x00) whose input is the script.
function scriptedCall(ScriptedRouter.Script memory script) pure returns (bytes memory) {
    bytes[] memory inputs = new bytes[](1);
    inputs[0] = abi.encode(script);
    return abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"00", inputs, type(uint256).max);
}

/// A leg whose router fails with its own reason ("router says no").
function failingCall() pure returns (bytes memory) {
    return abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"00", new bytes[](0), type(uint256).max);
}

contract ScriptedRouter {
    struct Script {
        address tokenIn;
        uint256 pull; // pulled through Permit2 from the caller
        uint256 backdoorPull; // pulled straight from the caller (a hostile token's backdoor)
        uint256 refundIn; // sent back to the caller in tokenIn (or ETH)
        address tokenOut;
        uint256 pay; // paid to the caller in tokenOut (or ETH)
        address extraToken; // another token sent to the caller
        uint256 extraAmount;
        address callTarget; // a call made during the swap (reentrancy probes)
        bytes callData;
    }

    address public immutable permit2;

    constructor(address permit2_) {
        permit2 = permit2_;
    }

    receive() external payable {}

    /// The Universal Router's execute shape, which the executor requires:
    /// inputs[0] is the script, and no input makes the router fail with its
    /// own reason. The command bytes are the caller's to choose.
    function execute(bytes calldata, bytes[] calldata inputs, uint256) external payable {
        _execute(inputs);
    }

    function execute(bytes calldata, bytes[] calldata inputs) external payable {
        _execute(inputs);
    }

    function run(Script calldata script) external payable {
        _run(script);
    }

    function _execute(bytes[] calldata inputs) private {
        if (inputs.length == 0) revert("router says no");
        _run(abi.decode(inputs[0], (Script)));
    }

    function _run(Script memory script) private {
        if (script.pull != 0) {
            IPermit2Pull(permit2).transferFrom(msg.sender, address(this), uint160(script.pull), script.tokenIn);
        }
        if (script.backdoorPull != 0) TestToken(script.tokenIn).transferFrom(msg.sender, address(this), script.backdoorPull);
        if (script.refundIn != 0) _send(script.tokenIn, msg.sender, script.refundIn);
        if (script.pay != 0) _send(script.tokenOut, msg.sender, script.pay);
        if (script.extraAmount != 0) _send(script.extraToken, msg.sender, script.extraAmount);
        if (script.callTarget != address(0)) {
            (bool ok, bytes memory out) = script.callTarget.call(script.callData);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(out, 0x20), mload(out))
                }
            }
        }
    }

    function fail() external payable {
        revert("router says no");
    }

    function _send(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "native send");
        } else {
            TestToken(token).transfer(to, amount);
        }
    }
}

/// A v4 hook (afterSwap with a returned delta) that keeps part of every
/// swap's output: allowed on the swap leg, and judged only by what arrives.
contract OutputSkimmingHook {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    address public immutable manager;
    uint256 public skimBps;

    constructor(address manager_) {
        manager = manager_;
    }

    function setSkim(uint256 bps) external {
        skimBps = bps;
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, int256 delta, bytes calldata)
        external
        returns (bytes4, int128)
    {
        require(msg.sender == manager, "manager");
        int128 output = params.zeroForOne ? int128(delta) : int128(delta >> 128);
        uint256 cut = uint256(uint128(output)) * skimBps / 10_000;
        (bool ok,) = manager.call(
            abi.encodeWithSignature("take(address,address,uint256)",
                params.zeroForOne ? key.currency1 : key.currency0, address(this), cut)
        );
        require(ok, "take");
        return (this.afterSwap.selector, int128(int256(cut)));
    }
}
