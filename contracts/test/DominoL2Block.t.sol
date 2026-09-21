// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoL2Block, IArbSysDomino} from "../src/DominoL2Block.sol";
import {DominoPriceGuardV4} from "../src/DominoPriceGuardV4.sol";
import {DominoVaultReadHelper} from "../src/DominoVaultReadHelper.sol";
import {DominoVaultTypes as T} from "../src/DominoVaultTypes.sol";
import {NitroTestSetup} from "./shared/NitroTestSetup.sol";

interface VmL2Block {
    function roll(uint256 blockNumber) external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 chainId) external;
    function etch(address target, bytes calldata code) external;
    function mockCall(address target, bytes calldata data, bytes calldata result) external;
    function mockCallRevert(address target, bytes calldata data, bytes calldata result) external;
    function clearMockedCalls() external;
}

/// @notice TEST ONLY: run creation bytecode with eth_call on a qualified node.
/// @dev Returns the compiled production library's current L2 number and prior
/// L2 hash as raw ABI output. No deployed probe or transaction is needed.
contract NitroBlockProbe {
    constructor() {
        uint256 current = DominoL2Block.number();
        bytes memory result = abi.encode(current, DominoL2Block.hash(current - 1));
        assembly ("memory-safe") { return(add(result, 32), mload(result)) }
    }
}

contract L2BlockState {
    function getSlot0(bytes32) external pure returns (uint160, int24, uint24, uint24) {
        return (uint160(1 << 96), 0, 0, 0);
    }
    function getPositionInfo(bytes32, address, int24, int24, bytes32)
        external pure returns (uint128, uint256, uint256) { return (0, 0, 0); }
    function getPositionLiquidity(uint256) external pure returns (uint128) { return 0; }
    function getFeeGrowthInside(bytes32, int24, int24) external pure returns (uint256, uint256) { return (0, 0); }
}

contract DominoL2BlockTest {
    VmL2Block private constant vm = VmL2Block(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant L2 = 68_886_586;
    uint256 private constant L1 = 26_026_629;
    bytes32 private constant HEADER = keccak256("recent L2 header");
    bytes32 private constant POOL = keccak256("pool");
    DominoPriceGuardV4 private guard;
    DominoVaultReadHelper private reader;

    function setUp() public {
        NitroTestSetup.install();
        vm.roll(L1); vm.warp(1_700_000_000);
        L2BlockState state = new L2BlockState();
        guard = new DominoPriceGuardV4(address(this), address(state), 100, address(0xA11));
        reader = new DominoVaultReadHelper(address(state), address(state));
        _number(L2); _hash(L2 - 1, HEADER);
    }

    function _number(uint256 number) private {
        vm.mockCall(address(0x64), abi.encodeCall(IArbSysDomino.arbBlockNumber, ()), abi.encode(number));
    }
    function _hash(uint256 number, bytes32 value) private {
        vm.mockCall(address(0x64), abi.encodeCall(IArbSysDomino.arbBlockHash, (number)), abi.encode(value));
    }
    function _point(uint64 number) private view returns (DominoPriceGuardV4.Observation memory) {
        return DominoPriceGuardV4.Observation(POOL, number, HEADER, uint64(block.timestamp - 1),
            uint64(block.timestamp + 60), uint160(1 << 96));
    }
    function _plan() private view returns (T.CompoundPlan memory p) {
        p.observedAtBlock = uint64(L2 - 1); p.observedBlockHash = HEADER;
        p.observedAtTimestamp = uint64(block.timestamp - 1); p.deadline = uint64(block.timestamp + 60);
        p.minSqrtPriceX96 = uint160(1 << 95); p.maxSqrtPriceX96 = uint160(1 << 97);
    }
    function _refused(address target, bytes memory data, bytes4 error) private view {
        (bool ok, bytes memory out) = target.staticcall(data);
        require(!ok && out.length >= 4 && bytes4(out) == error, "wrong rejection");
    }
    function _publishRefused(bytes4 error) private {
        (bool ok, bytes memory out) = address(guard).call(abi.encodeCall(guard.publish, (_point(uint64(L2 - 1)))));
        require(!ok && out.length >= 4 && bytes4(out) == error, "wrong publish rejection");
    }
    function _checkpointRefused(bytes4 error) private view {
        _refused(address(reader), abi.encodeCall(reader.readCheckpoint, (POOL, bytes32(0), 1, int24(-60), int24(60))), error);
    }
    function _planRefused(bytes4 error) private view {
        _refused(address(reader), abi.encodeCall(reader.validateCompoundPrice, (POOL, _plan(), uint32(120))), error);
    }

    function testObservationAndCheckpointUseL2WhenL1IsDifferent() external {
        require(block.number == L1 && L1 < L2 - 1, "distinct block domains");
        require(blockhash(L2 - 1) == bytes32(0), "native hash cannot supply this L2 header");
        bytes32 id = guard.publish(_point(uint64(L2 - 1)));
        require(guard.referencePrice(id, POOL, uint64(L2 - 1), HEADER, 120) == 1 << 96, "L2 observation readable");
        reader.validateCompoundPrice(POOL, _plan(), 120);
        T.Checkpoint memory checkpoint = reader.readCheckpoint(POOL, bytes32(0), 1, -60, 60);
        require(checkpoint.observedAtBlock == L2, "checkpoint must commit to L2 height");
    }

    function testThe255BlockWindowAdvancesWithL2WhileL1StaysStill() external {
        uint64 observed = uint64(L2 - 255); _hash(observed, HEADER);
        bytes32 id = guard.publish(_point(observed));
        require(guard.referencePrice(id, POOL, observed, HEADER, 120) == 1 << 96, "255 L2 blocks accepted");
        _number(L2 + 1);
        require(block.number == L1, "L1 did not advance");
        _refused(address(guard), abi.encodeCall(guard.referencePrice, (id, POOL, observed, HEADER, uint32(120))),
            DominoPriceGuardV4.InvalidObservation.selector);
    }

    function testL2ReorganizationRejectsBothConsumers() external {
        bytes32 id = guard.publish(_point(uint64(L2 - 1)));
        _hash(L2 - 1, keccak256("replacement L2 header"));
        _refused(address(guard), abi.encodeCall(guard.referencePrice, (id, POOL, uint64(L2 - 1), HEADER, uint32(120))),
            DominoPriceGuardV4.InvalidObservation.selector);
        _planRefused(DominoVaultReadHelper.InvalidExecution.selector);
    }

    function testAbsentArbSysFailsClosedWithoutNativeFallback() external {
        bytes32 id = guard.publish(_point(uint64(L2 - 1)));
        vm.clearMockedCalls(); vm.etch(address(0x64), bytes(""));
        _publishRefused(DominoL2Block.InvalidL2BlockContext.selector);
        _checkpointRefused(DominoL2Block.InvalidL2BlockContext.selector);
        _planRefused(DominoL2Block.InvalidL2BlockContext.selector);
        _refused(address(guard), abi.encodeCall(guard.referencePrice, (id, POOL, uint64(L2 - 1), HEADER, uint32(120))),
            DominoL2Block.InvalidL2BlockContext.selector);
    }

    function testMalformedOrRevertingArbSysFailsClosed() external {
        for (uint256 i; i < 3; ++i) {
            bytes memory malformed = i == 0 ? bytes("") : i == 1 ? new bytes(1) : abi.encode(L2, L1);
            vm.mockCall(address(0x64), abi.encodeCall(IArbSysDomino.arbBlockNumber, ()), malformed);
            _publishRefused(DominoL2Block.InvalidL2BlockContext.selector);
            _checkpointRefused(DominoL2Block.InvalidL2BlockContext.selector);
            _planRefused(DominoL2Block.InvalidL2BlockContext.selector);
        }
        vm.mockCallRevert(address(0x64), abi.encodeCall(IArbSysDomino.arbBlockNumber, ()), hex"bad0");
        _publishRefused(DominoL2Block.InvalidL2BlockContext.selector);
        vm.clearMockedCalls(); _number(L2);
        vm.mockCall(address(0x64), abi.encodeCall(IArbSysDomino.arbBlockHash, (L2 - 1)), hex"00");
        _publishRefused(DominoL2Block.InvalidL2BlockContext.selector);
        _planRefused(DominoL2Block.InvalidL2BlockContext.selector);
    }

    function testUnqualifiedChainFailsClosedEvenWithArbSysResponses() external {
        vm.chainId(1);
        _publishRefused(DominoL2Block.InvalidL2BlockContext.selector);
        _checkpointRefused(DominoL2Block.InvalidL2BlockContext.selector);
        _planRefused(DominoL2Block.InvalidL2BlockContext.selector);
    }

    function testUint64UpperBoundaryDoesNotOverflowTheAgeCheck() external {
        uint64 current = type(uint64).max; _number(current); _hash(current - 1, HEADER);
        bytes32 id = guard.publish(_point(current - 1));
        require(guard.referencePrice(id, POOL, current - 1, HEADER, 120) == 1 << 96, "last representable L2 block");
        require(reader.readCheckpoint(POOL, bytes32(0), 1, -60, 60).observedAtBlock == current, "exact checkpoint bound");
        _number(uint256(current) + 1);
        _publishRefused(DominoPriceGuardV4.InvalidObservation.selector);
        _checkpointRefused(DominoVaultReadHelper.InvalidIdentity.selector);
        _planRefused(DominoVaultReadHelper.InvalidExecution.selector);
    }
}
