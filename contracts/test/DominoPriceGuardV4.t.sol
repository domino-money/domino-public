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
    address private constant GUARDIAN = address(0x6A2D);
    address private constant SUCCESSOR = address(0x5E11);
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
        guard = new DominoPriceGuardV4(PUBLISHER, address(state), BAND, GUARDIAN);
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
        (bool ok,) = address(this).call(abi.encodeCall(this.deploy, (address(0), address(state), BAND, GUARDIAN)));
        require(!ok, "a publisher is required");
        (ok,) = address(this).call(abi.encodeCall(this.deploy, (PUBLISHER, address(0), BAND, GUARDIAN)));
        require(!ok, "a state view is required");
        (ok,) = address(this).call(abi.encodeCall(this.deploy, (PUBLISHER, address(state), BAND, address(0))));
        require(!ok, "a guardian is required");
        (ok,) = address(this).call(abi.encodeCall(this.deploy, (PUBLISHER, address(state), BAND, PUBLISHER)));
        require(!ok, "the guardian must not be the publisher it can replace");
        (ok,) = address(this).call(abi.encodeCall(this.deploy, (PUBLISHER, address(state), 0, GUARDIAN)));
        require(!ok, "a zero band would admit any price");
        (ok,) = address(this).call(abi.encodeCall(this.deploy, (PUBLISHER, address(state), 10000, GUARDIAN)));
        require(!ok, "a band of 100% would admit any price");
        (ok,) = address(this).call(abi.encodeCall(this.deploy, (PUBLISHER, address(state), 9999, GUARDIAN)));
        require(ok, "one basis point short of everything is still a band");
    }

    /// External so the constructor's reverts are catchable.
    function deploy(address publisher, address stateView, uint256 band, address guardian) external {
        new DominoPriceGuardV4(publisher, stateView, band, guardian);
    }

    function _call(address from, bytes memory data) private returns (bool ok) {
        vm.prank(from);
        (ok,) = address(guard).call(data);
    }

    /// Rotation is a two-key handshake: the guardian names the next publisher,
    /// the named key accepts, and only then does the role move. Nobody else
    /// can start it, and nobody but the named key can finish it.
    function testOnlyTheGuardianProposesAndOnlyTheProposedAccepts() external {
        bytes memory propose = abi.encodeCall(DominoPriceGuardV4.proposePublisher, (SUCCESSOR));
        require(!_call(STRANGER, propose), "a stranger proposed");
        require(!_call(PUBLISHER, propose), "the publisher proposed its own successor");
        require(_call(GUARDIAN, propose) && guard.pendingPublisher() == SUCCESSOR, "the guardian could not propose");
        require(guard.publisher() == PUBLISHER, "a proposal moved the role by itself");

        bytes memory accept = abi.encodeCall(DominoPriceGuardV4.acceptPublisher, ());
        require(!_call(STRANGER, accept), "a stranger accepted");
        require(!_call(GUARDIAN, accept), "the guardian accepted on the successor's behalf");
        require(!_call(PUBLISHER, accept), "the old publisher accepted");
        require(_call(SUCCESSOR, accept), "the successor could not accept");
        require(guard.publisher() == SUCCESSOR && guard.pendingPublisher() == address(0), "the role did not move");
        require(!_call(SUCCESSOR, accept), "a spent proposal was accepted again");

        // The old key is out, the new one is in.
        DominoPriceGuardV4.Observation memory point = _point();
        _armHash(point);
        vm.prank(PUBLISHER);
        (bool ok,) = address(guard).call(abi.encodeCall(DominoPriceGuardV4.publish, (point)));
        require(!ok, "the rotated-out key still publishes");
        vm.prank(SUCCESSOR);
        guard.publish(point);
    }

    function testAProposalRefusesNobodyAndTheCurrentPublisher() external {
        require(!_call(GUARDIAN, abi.encodeCall(DominoPriceGuardV4.proposePublisher, (address(0)))), "proposed nobody");
        require(!_call(GUARDIAN, abi.encodeCall(DominoPriceGuardV4.proposePublisher, (PUBLISHER))), "proposed the incumbent");
        require(guard.pendingPublisher() == address(0), "a refused proposal was recorded");
    }

    /// The guardian's other power: it can retire an observation without the
    /// publisher key, which is the brake against a key that is publishing
    /// inside the band but should not be publishing at all.
    function testTheGuardianCanRevokeWithoutThePublisherKey() external {
        bytes32 id = _publish(_point());
        require(!_call(STRANGER, abi.encodeCall(DominoPriceGuardV4.revoke, (id))), "a stranger revoked");
        require(!guard.revoked(id), "and nothing was revoked");
        require(_call(GUARDIAN, abi.encodeCall(DominoPriceGuardV4.revoke, (id))), "the guardian could not revoke");
        require(guard.revoked(id), "the guardian's revocation did not take");
    }

    /// Rotation does not touch what the old key published: those observations
    /// were bounded by the band when published and by the engine's limits when
    /// read. They die at their own expiry, or by revocation.
    function testRotationKeepsEarlierObservationsReadableUntilTheyExpire() external {
        DominoPriceGuardV4.Observation memory point = _point();
        bytes32 id = _publish(point);
        _call(GUARDIAN, abi.encodeCall(DominoPriceGuardV4.proposePublisher, (SUCCESSOR)));
        _call(SUCCESSOR, abi.encodeCall(DominoPriceGuardV4.acceptPublisher, ()));
        require(guard.referencePrice(id, POOL, point.blockNumber, point.blockHash, 3600) == SPOT,
            "rotation erased a live observation");
        vm.warp(point.expiresAt + 1);
        _rejectRead(id, POOL, point.blockNumber, point.blockHash, 3600, "and it still expires");
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
     * Nine of the guard's clauses cannot be the one that decides, and this
     * records which. Every clause of the constructor, _withinBand, publish,
     * revoke, referencePrice and the publisher rotation was deleted in turn
     * against this suite (the batch is in
     * reports/CONTRACT_HYGIENE_MINOR_2026-09-19.md): 30 of 39 fail a test,
     * these nine leave all of them green, and that is a property of the guard
     * rather than a gap in the suite.
     *
     *   publish
     *     poolId == 0        a pool with no reading is outside any band
     *     sqrtPriceX96 == 0  and so is a zero price
     *       - both became redundant when the deviation band was added with
     *         the D-03/D-04 hardening; before it they were load-bearing.
     *     blockNumber >= block.number
     *       - blockhash answers zero for the current block and later, and a
     *         zero hash is refused just above, so the hash comparison decides.
     *     expiresAt <= timestamp
     *       - could only decide for a stamp in the future, which the clause
     *         before it already refuses.
     *     revoked[id]
     *       - revoke keeps the observation, so a revoked id is also an already
     *         published one and the clause beside it decides.
     *   _withinBand
     *     value == 0, anchor == 0
     *       - nothing positive is at most zero, and zero is at least nothing,
     *         so the band arithmetic refuses both without the early return.
     *   referencePrice
     *     sqrtPriceX96 == 0
     *       - an unknown id has a zero pool, and a caller naming that zero
     *         pool is still refused by the zero expiry it also has.
     *     block.timestamp < timestamp
     *       - publish refuses a stamp in the future and chain time does not
     *         go backwards; it stays as the underflow guard on the age below.
     */
    function testEveryRedundantClauseIsStillRefusedBySomethingElse() external {
        DominoPriceGuardV4.Observation memory point = _point();
        point.poolId = bytes32(0);
        _refused(point, "no pool");
        point = _point(); point.sqrtPriceX96 = 0;
        _refused(point, "no price");
        point = _point(); point.blockNumber = uint64(block.number);
        _refused(point, "the current block has no hash");
        point = _point(); point.expiresAt = point.timestamp;
        _refused(point, "expiring at its own stamp");

        point = _point();
        bytes32 id = _publish(point);
        vm.prank(PUBLISHER);
        guard.revoke(id);
        _refused(point, "a revoked id is an already published one");

        _rejectRead(keccak256("no such id"), bytes32(0), 0, bytes32(0), 3600, "an unknown id claiming a zero pool");
    }

    /// revoke has no once-only guard, but it does refuse an id that was never
    /// published - otherwise the publisher could pre-revoke an observation and
    /// have its later, honest publication refused as already revoked. Found
    /// by mutation: nothing pinned this clause before.
    function testRevokeRefusesAnIdThatWasNeverPublished() external {
        bytes32 id = keccak256("never published");
        vm.prank(PUBLISHER);
        (bool ok, bytes memory out) = address(guard).call(abi.encodeCall(DominoPriceGuardV4.revoke, (id)));
        require(!ok && out.length >= 4 && bytes4(out) == DominoPriceGuardV4.InvalidObservation.selector,
            "an unknown id was revoked");
        require(!guard.revoked(id), "and nothing was marked");
    }

    /// The publisher's hash was checked against the chain at publish time;
    /// referencePrice checks it again, because the chain can have reorganised
    /// since. Only this clause refuses a stored observation whose block hash
    /// the chain no longer agrees with. Found by mutation.
    function testReferencePriceRefusesAnObservationTheChainHasReorganisedAway() external {
        DominoPriceGuardV4.Observation memory point = _point();
        bytes32 id = _publish(point);
        vm.setBlockhash(point.blockNumber, keccak256("a different canonical block"));
        _rejectRead(id, POOL, point.blockNumber, point.blockHash, 3600, "reorganised away");
    }

    /// The window is enforced on the way out as well as on the way in: an
    /// observation admitted at 255 blocks old is refused one block later,
    /// while its hash still resolves and its expiry is minutes away. Found by
    /// mutation.
    function testReferencePriceRefusesTheObservationTheMomentItLeavesTheBlockWindow() external {
        vm.roll(2000);
        DominoPriceGuardV4.Observation memory point = _point();
        point.blockNumber = uint64(block.number - 255);
        point.blockHash = keccak256(abi.encode("hash", point.blockNumber));
        bytes32 id = _publish(point);
        require(guard.referencePrice(id, POOL, point.blockNumber, point.blockHash, 3600) == SPOT, "readable at 255");
        vm.roll(2001);
        _rejectRead(id, POOL, point.blockNumber, point.blockHash, 3600, "256 blocks old on the way out");
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
