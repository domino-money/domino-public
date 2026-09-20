// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoPriceGuardV4} from "../src/DominoPriceGuardV4.sol";

interface GuardVm {
    function prank(address sender) external;
    function roll(uint256 blockNumber) external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 chain) external;
    function setBlockhash(uint256 blockNumber, bytes32 value) external;
}

/// The pool reading the guard bounds a published price against.
contract MockGuardStateView {
    mapping(bytes32 => uint160) public price;
    function set(bytes32 poolId, uint160 value) external { price[poolId] = value; }
    function getSlot0(bytes32 poolId) external view returns (uint160, int24, uint24, uint24) {
        return (price[poolId], int24(0), uint24(0), uint24(0));
    }
}

/**
 * The price guard's own suite.
 *
 * Every V4 execution anchors to an observation this contract holds
 * (DominoExecutionEngineV4.unlockCallback reads referencePrice before it
 * dispatches any action), and until now the contract had no suite: the only
 * calls anywhere were one publish and one revoke inside the execution test,
 * neither of which distinguishes why the guard refuses. Its expiry branch was
 * reachable by nothing at all.
 */
contract DominoPriceGuardV4Test {
    GuardVm private constant vm = GuardVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant PUBLISHER = address(0xB0B);
    address private constant STRANGER = address(0xBAD);
    bytes32 private constant POOL = keccak256("pool");
    uint160 private constant SPOT = uint160(1 << 96);
    uint256 private constant BAND = 100;

    MockGuardStateView private state;
    DominoPriceGuardV4 private guard;

    function setUp() public {
        vm.chainId(4663);
        vm.roll(1000);
        vm.warp(1_700_000_000);
        state = new MockGuardStateView();
        state.set(POOL, SPOT);
        guard = new DominoPriceGuardV4(PUBLISHER, address(state), BAND);
    }

    function _point() private view returns (DominoPriceGuardV4.Observation memory point) {
        point.poolId = POOL;
        point.blockNumber = uint64(block.number - 1);
        point.blockHash = keccak256(abi.encode("hash", block.number - 1));
        point.timestamp = uint64(block.timestamp - 1);
        point.expiresAt = uint64(block.timestamp + 600);
        point.sqrtPriceX96 = SPOT;
    }

    function _armHash(DominoPriceGuardV4.Observation memory point) private {
        vm.setBlockhash(point.blockNumber, point.blockHash);
    }

    function _publish(DominoPriceGuardV4.Observation memory point) private returns (bytes32) {
        _armHash(point);
        vm.prank(PUBLISHER);
        return guard.publish(point);
    }

    function _refused(DominoPriceGuardV4.Observation memory point, string memory what) private {
        _armHash(point);
        vm.prank(PUBLISHER);
        (bool ok, bytes memory out) = address(guard).call(
            abi.encodeCall(DominoPriceGuardV4.publish, (point)));
        require(!ok && out.length >= 4 && bytes4(out) == DominoPriceGuardV4.InvalidObservation.selector, what);
    }

    function testConstructorRefusesAnUnusableTrustConfiguration() external {
        (bool ok,) = address(this).call(abi.encodeCall(this.deploy, (address(0), address(state), BAND)));
        require(!ok, "a publisher is required");
        (ok,) = address(this).call(abi.encodeCall(this.deploy, (PUBLISHER, address(0), BAND)));
        require(!ok, "a state view is required");
        (ok,) = address(this).call(abi.encodeCall(this.deploy, (PUBLISHER, address(state), 0)));
        require(!ok, "a zero band would admit any price");
        (ok,) = address(this).call(abi.encodeCall(this.deploy, (PUBLISHER, address(state), 10000)));
        require(!ok, "a band of 100% would admit any price");
        (ok,) = address(this).call(abi.encodeCall(this.deploy, (PUBLISHER, address(state), 9999)));
        require(ok, "one basis point short of everything is still a band");
    }

    /// External so the constructor's reverts are catchable.
    function deploy(address publisher, address stateView, uint256 band) external {
        new DominoPriceGuardV4(publisher, stateView, band);
    }

    function testOnlyThePublisherPublishesOrRevokes() external {
        DominoPriceGuardV4.Observation memory point = _point();
        _armHash(point);
        vm.prank(STRANGER);
        (bool ok,) = address(guard).call(abi.encodeCall(DominoPriceGuardV4.publish, (point)));
        require(!ok, "a stranger cannot publish");

        bytes32 id = _publish(point);
        vm.prank(STRANGER);
        (ok,) = address(guard).call(abi.encodeCall(DominoPriceGuardV4.revoke, (id)));
        require(!ok, "a stranger cannot revoke");
        require(!guard.revoked(id), "and nothing was revoked");
    }

    /// The band is what stops a stolen key attesting a price unrelated to the
    /// pool. It is on the square root, so a 100 bps band is about 200 bps of
    /// price - the comment on maxDeviationBps says so and this pins it.
    function testAPublishedPriceMustSitInsideTheBandOfTheLiveReading() external {
        DominoPriceGuardV4.Observation memory point = _point();
        point.sqrtPriceX96 = uint160(uint256(SPOT) * (10000 + BAND) / 10000);
        _publish(point);

        point = _point();
        point.sqrtPriceX96 = uint160(uint256(SPOT) * (10000 + BAND) / 10000) + 1;
        _refused(point, "one wei above the band");

        point = _point();
        point.sqrtPriceX96 = uint160(uint256(SPOT) * (10000 - BAND) / 10000) - 1;
        _refused(point, "one wei below the band");

        // A pool the guard has never seen reads zero, and no price is inside a
        // band around zero - including zero itself.
        point = _point();
        point.poolId = keccak256("another pool");
        _refused(point, "a pool with no reading admits nothing");
    }

    /// Each case starts from a fresh observation. An earlier version of this
    /// test reused one `memory` struct, which in Solidity is a reference: the
    /// first case's zeroed poolId leaked into every case after it, so each
    /// was refused by the first clause rather than the one it names. Mutation
    /// is what exposed that - seven of these clauses could be deleted with
    /// the test still green.
    function testPublishRefusesEveryMalformedObservation() external {
        DominoPriceGuardV4.Observation memory point;

        point = _point(); point.blockHash = bytes32(0);
        _refused(point, "no block hash");
        point = _point(); point.timestamp = uint64(block.timestamp + 1);
        _refused(point, "a stamp in the future");
        point = _point(); point.expiresAt = uint64(block.timestamp);
        _refused(point, "expiring now is expired");

        // The hash must be the chain's, not the publisher's word. Arm the
        // real one, then claim a different one.
        point = _point();
        _armHash(point);
        point.blockHash = keccak256("not the chain's hash");
        vm.prank(PUBLISHER);
        (bool ok,) = address(guard).call(abi.encodeCall(DominoPriceGuardV4.publish, (point)));
        require(!ok, "a fabricated block hash");
    }

    /**
     * Four of publish's clauses cannot be the one that decides, and this
     * records which - deleting any of them leaves all nine tests green, and
     * that is a property of the guard rather than a gap in the suite. The
     * other fifteen clauses across publish, revoke and referencePrice each
     * fail a test when deleted.
     *
     *   poolId == 0        a pool with no reading is outside any band
     *   sqrtPriceX96 == 0  and so is a zero price
     *     - both became redundant when the deviation band was added with the
     *       D-03/D-04 hardening; before it they were load-bearing.
     *   blockNumber >= block.number
     *     - blockhash answers zero for the current block and later, and a zero
     *       hash is refused just above, so the hash comparison decides first.
     *   expiresAt <= timestamp
     *     - it could only decide for a stamp in the future, which the clause
     *       before it already refuses.
     */
    function testTheFourRedundantClausesAreStillRefusedBySomethingElse() external {
        DominoPriceGuardV4.Observation memory point = _point();
        point.poolId = bytes32(0);
        _refused(point, "no pool");
        point = _point(); point.sqrtPriceX96 = 0;
        _refused(point, "no price");
        point = _point(); point.blockNumber = uint64(block.number);
        _refused(point, "the current block has no hash");
        point = _point(); point.expiresAt = point.timestamp;
        _refused(point, "expiring at its own stamp");
    }

    /// MAX_OBSERVATION_BLOCKS says 256 and the comparison admits 255. The
    /// constant overstates the lifetime by one block (M-10); this pins what
    /// the code actually does so a later correction is a deliberate change.
    function testTheBlockWindowAdmits255BlocksNotThe256IsNames() external {
        vm.roll(2000);
        DominoPriceGuardV4.Observation memory point = _point();
        point.blockNumber = uint64(block.number - 255);
        point.blockHash = keccak256(abi.encode("hash", point.blockNumber));
        _publish(point);

        point.blockNumber = uint64(block.number - 256);
        point.blockHash = keccak256(abi.encode("hash", point.blockNumber));
        _refused(point, "256 blocks old is one too many");
    }

    function testAnIdCannotBeRepublishedOrOutliveItsRevocation() external {
        DominoPriceGuardV4.Observation memory point = _point();
        bytes32 id = _publish(point);
        _refused(point, "the same observation twice");

        vm.prank(PUBLISHER);
        guard.revoke(id);
        require(guard.revoked(id), "revoked");
        // revoke has no once-only guard of its own; revoking twice is a no-op
        // rather than a refusal, which is worth pinning either way.
        vm.prank(PUBLISHER);
        guard.revoke(id);
        require(guard.revoked(id), "still revoked");
        _refused(point, "and a revoked id cannot come back");
    }

    function testReferencePriceBindsEveryFieldTheCallerClaims() external {
        DominoPriceGuardV4.Observation memory point = _point();
        bytes32 id = _publish(point);
        require(guard.referencePrice(id, POOL, point.blockNumber, point.blockHash, 3600) == SPOT,
            "the honest read returns the attested price");

        _rejectRead(id, keccak256("another pool"), point.blockNumber, point.blockHash, 3600, "wrong pool");
        _rejectRead(id, POOL, point.blockNumber + 1, point.blockHash, 3600, "wrong block");
        _rejectRead(id, POOL, point.blockNumber, keccak256("wrong"), 3600, "wrong hash");
        _rejectRead(keccak256("no such id"), POOL, point.blockNumber, point.blockHash, 3600, "unknown id");
        _rejectRead(id, POOL, point.blockNumber, point.blockHash, 0, "older than the caller's age bound");

        vm.prank(PUBLISHER);
        guard.revoke(id);
        _rejectRead(id, POOL, point.blockNumber, point.blockHash, 3600, "revoked");
    }

    /// The expiry branch, which nothing in the repository reached before: an
    /// observation inside its block window but past its own expiry is refused.
    function testAnExpiredObservationIsRefusedEvenInsideItsBlockWindow() external {
        DominoPriceGuardV4.Observation memory point = _point();
        point.expiresAt = uint64(block.timestamp + 10);
        bytes32 id = _publish(point);
        require(guard.referencePrice(id, POOL, point.blockNumber, point.blockHash, 3600) == SPOT, "live");

        vm.warp(block.timestamp + 11);
        require(block.number < point.blockNumber + guard.MAX_OBSERVATION_BLOCKS(), "still inside the block window");
        _rejectRead(id, POOL, point.blockNumber, point.blockHash, 3600, "expired");
    }

    function _rejectRead(bytes32 id, bytes32 poolId, uint64 blockNumber, bytes32 blockHash,
        uint32 maxAge, string memory what) private view {
        (bool ok, bytes memory out) = address(guard).staticcall(abi.encodeCall(
            DominoPriceGuardV4.referencePrice, (id, poolId, blockNumber, blockHash, maxAge)));
        require(!ok && out.length >= 4 && bytes4(out) == DominoPriceGuardV4.InvalidObservation.selector, what);
    }
}
