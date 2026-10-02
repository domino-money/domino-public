// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoRegistry} from "../../../src/v2/registry/DominoRegistry.sol";

/// @notice The Forge cheatcodes the V2 registry and anchor suites use (the
/// repository has no forge-std).
interface V2Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 chain) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
    function expectRevert() external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
    function etch(address target, bytes calldata code) external;
    function store(address target, bytes32 slot, bytes32 value) external;
    function load(address target, bytes32 slot) external view returns (bytes32);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// @notice Any contract: a router or a token only needs code to be admitted.
contract CodeStub {
    function ping() external pure returns (bool) {
        return true;
    }
}

/// @notice A registry configured as a chain deployment would be, with
/// synthetic addresses.
abstract contract RegistryFixtures {
    V2Vm internal constant vm = V2Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant GOVERNANCE = address(0x6070);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant RECIPIENT = address(0xFEE0);
    address internal constant OPERATOR = address(0x0BE7);
    address internal constant PUBLISHER = address(0xB0B0);
    address internal constant STRANGER = address(0xBAD0);
    address internal constant NEWCOMER = address(0x2E70);
    uint32 internal constant TIMELOCK = 2 days;
    uint256 internal constant START = 1_790_870_000;

    /// The test's own clock. A local holding block.timestamp is not safe
    /// across vm.warp under via-IR: the optimizer may re-read TIMESTAMP at the
    /// local's use, after the warp. Storage keeps the value the test meant.
    uint256 internal clock;

    error Mismatch(string what, uint256 actual, uint256 expected);
    error Expected(string what);

    function _warpTo(uint256 timestamp) internal {
        clock = timestamp;
        vm.warp(timestamp);
    }

    function _advance(uint256 seconds_) internal {
        _warpTo(clock + seconds_);
    }

    function _eq(uint256 actual, uint256 expected, string memory what) internal pure {
        if (actual != expected) revert Mismatch(what, actual, expected);
    }

    function _check(bool value, string memory what) internal pure {
        if (!value) revert Expected(what);
    }

    function _config(address router, address stable, address wrapped)
        internal
        pure
        returns (DominoRegistry.Config memory config)
    {
        config.governance = GOVERNANCE;
        config.guardian = GUARDIAN;
        config.timelockSeconds = TIMELOCK;
        config.feeRecipient = RECIPIENT;
        config.operators = new address[](1);
        config.operators[0] = OPERATOR;
        config.publishers = new address[](1);
        config.publishers[0] = PUBLISHER;
        config.routers = new address[](1);
        config.routers[0] = router;
        config.chargeCurrencies = new DominoRegistry.ChargeCurrency[](3);
        config.chargeCurrencies[0] = DominoRegistry.ChargeCurrency({token: stable, rank: 1});
        config.chargeCurrencies[1] = DominoRegistry.ChargeCurrency({token: address(0), rank: 2});
        config.chargeCurrencies[2] = DominoRegistry.ChargeCurrency({token: wrapped, rank: 2});
    }
}
