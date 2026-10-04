// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoPriceAnchor} from "../../../src/v2/interfaces/IDominoPriceAnchor.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {AdvChargeCurrency, AdvRegistryConfig, AdvVm, IAnchorProbe, IRegistryProbe, RegistryWorld} from "./RegistryWorld.sol";

/// Every party of the registry (and of the anchor's revocation, which reads
/// it), driven by the fuzzer:
/// - governance: schedules every kind of change (valid, invalid and
///   non-canonical data), executes and cancels them, hands governance over;
/// - the guardian: removes operators, publishers and routers, raises the
///   observation epoch, halts, cancels, and front-runs governance's
///   executions in the same second;
/// - whoever else: strangers, former guardians and governances, operators
///   and publishers, the pending governance, each trying what it may not;
/// - publishers, the guardian and governance revoking observations;
/// - time, warped around the 24-hour timelock and to the exact second a
///   pending change becomes executable.
///
/// Before each call the handler predicts its outcome from the documented
/// rules (docs/v2/F1_REGISTRY_ANCHOR.md, the model below, written from the
/// docs' tables, not from the code) and counts every call whose outcome
/// differs. It also rebuilds the registry from its events alone, as an
/// indexer would, and counts what can only be seen inside one call: an
/// execution before its timelock or with an effect other than the scheduled
/// one, a re-admission or resume against the "scheduled after" rule, trust
/// widened outside an executed change, the epoch falling, the halt moving
/// outside its two paths.
contract RegistryHandler is RegistryWorld {
    uint8 internal constant LIVE = 1;
    uint8 internal constant EXECUTED = 2;
    uint8 internal constant CANCELLED = 3;

    uint8 internal constant A_SCHEDULE = 1;
    uint8 internal constant A_EXECUTE = 2;
    uint8 internal constant A_CANCEL = 3;
    uint8 internal constant A_TRANSFER = 4;
    uint8 internal constant A_ACCEPT = 5;
    uint8 internal constant A_NARROW = 6;
    uint8 internal constant A_HALT = 7;
    uint8 internal constant A_OTHER = 8;

    address internal constant GOVERNANCE = address(0x6070);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant RECIPIENT = address(0xFEE0);
    address internal constant STATE_VIEW = address(0x57A7E);

    struct Change {
        bytes32 kind;
        bytes data;
        uint64 scheduledAt;
        uint64 executableAt;
        uint8 state;
    }

    /// The registry's state as one party knows it: the model, from the docs,
    /// or the log, rebuilt from events only.
    struct Book {
        address governance;
        address pending;
        address guardian;
        address recipient;
        uint32 timelock;
        uint64 epoch;
        bool halted;
        uint64 haltedAt;
        mapping(address => bool) operator;
        mapping(address => bool) publisher;
        mapping(address => uint16) version;
        mapping(address => uint8) rank;
        mapping(bytes32 => mapping(address => uint64)) removedAt;
        mapping(bytes32 => bool) live;
        mapping(bytes32 => bool) revoked;
    }

    /// Everything that bounds trust, over the role, router and token pools.
    struct Trust {
        uint256 operators;
        uint256 publishers;
        uint16[5] versions;
        uint8[5] ranks;
        address governance;
        address pending;
        address guardian;
        address recipient;
        uint32 timelock;
        uint64 epoch;
        bool halted;
        uint64 haltedAt;
    }

    IRegistryProbe public registry;
    IAnchorProbe public anchor;
    /// The handler's clock. Every action starts by warping to it, and the
    /// model reads it instead of block.timestamp (via-IR may reuse a
    /// TIMESTAMP read across a warp).
    uint256 public clock;

    uint256[5] internal keys;
    /// Operators and publishers; subjects[0] operates and subjects[1] publishes at deployment.
    address[5] internal subjects;
    /// routers[0] is admitted at deployment; routers[4] has no code.
    address[5] internal routers;
    /// tokens[0] is native ETH; tokens[4] has no code.
    address[5] internal tokens;
    address[4] internal strangers;
    address[3] internal guardianPool;
    address[3] internal governancePool;
    address[3] internal recipientPool;
    address[] internal formerRoles;

    Book internal model;
    Book internal log;
    mapping(bytes32 => Change) internal changes;
    bytes32[] internal ids;
    uint64 internal changeCounter;
    mapping(bytes32 => mapping(address => uint64)) internal admittedFrom;
    bytes32[] internal revokedHashes;
    bytes32 internal executedKind;
    uint64 internal executedScheduledAt;

    // Rules broken inside one call; every invariant expects zero.
    uint256 public mismatches;
    uint256 public earlyExecutions;
    uint256 public offScheduleEffects;
    uint256 public readmissionBreaches;
    uint256 public untimedWidenings;
    uint256 public guardianWidenings;
    uint256 public epochDrops;
    uint256 public haltBreaches;
    uint256 public eventBreaches;
    string public lastBreach;

    // Outcomes reached, so a campaign that only ever reverted cannot pass quietly.
    mapping(bytes32 => uint256) public scheduledOf;
    mapping(bytes32 => uint256) public executedOf;
    uint256 public refusedSchedules;
    uint256 public earlyRefusals;
    uint256 public staleReadmissions;
    uint256 public readmissions;
    uint256 public staleResumes;
    uint256 public resumes;
    uint256 public guardianCancels;
    uint256 public governanceCancels;
    uint256 public guardianVetoesOfItsReplacement;
    uint256 public removals;
    uint256 public epochRaises;
    uint256 public halts;
    uint256 public handovers;
    uint256 public revocations;
    uint256 public strangerRefusals;
    uint256 public frontRuns;
    uint256 public warps;

    constructor() {
        clock = START;
        vm.warp(START);
        for (uint256 i; i < 5; ++i) {
            keys[i] = 0xADD0 + i;
            subjects[i] = vm.addr(keys[i]);
            routers[i] = address(uint160(0xA0000 + i));
            tokens[i] = address(uint160(0xC0000 + i));
        }
        tokens[0] = address(0);
        for (uint256 i; i < 4; ++i) {
            _giveCode(routers[i]);
            if (i != 0) _giveCode(tokens[i]);
        }
        _giveCode(STATE_VIEW);
        strangers = [address(0xBAD0), address(0xBAD1), address(0xBAD2), address(0xBAD3)];
        guardianPool = [GUARDIAN, address(0x6A2E), address(0x6A2F)];
        governancePool = [address(0x6071), address(0x6072), GUARDIAN];
        recipientPool = [RECIPIENT, address(0xFEE1), address(0xFEE2)];

        AdvRegistryConfig memory config;
        config.governance = GOVERNANCE;
        config.guardian = GUARDIAN;
        config.timelockSeconds = DEPLOYED_TIMELOCK;
        config.feeRecipient = RECIPIENT;
        config.operators = new address[](1);
        config.operators[0] = subjects[0];
        config.publishers = new address[](1);
        config.publishers[0] = subjects[1];
        config.routers = new address[](1);
        config.routers[0] = routers[0];
        config.chargeCurrencies = new AdvChargeCurrency[](3);
        config.chargeCurrencies[0] = AdvChargeCurrency(tokens[1], 1);
        config.chargeCurrencies[1] = AdvChargeCurrency(tokens[0], 2);
        config.chargeCurrencies[2] = AdvChargeCurrency(tokens[2], 2);
        vm.recordLogs();
        registry = _deployRegistry(config);
        anchor = _deployAnchor(address(registry), STATE_VIEW);

        model.governance = GOVERNANCE;
        model.guardian = GUARDIAN;
        model.recipient = RECIPIENT;
        model.timelock = DEPLOYED_TIMELOCK;
        model.operator[subjects[0]] = true;
        model.publisher[subjects[1]] = true;
        model.version[routers[0]] = 212;
        model.rank[tokens[1]] = 1;
        model.rank[tokens[0]] = 2;
        model.rank[tokens[2]] = 2;
        // No event carries the deployment's timelock: the log learns it from
        // the first ChangeScheduled (executableAt minus the block time).
        _replay();
    }

    modifier action() {
        vm.warp(clock);
        vm.recordLogs();
        _;
        _replay();
    }

    // ============================================================= picking

    function _subject(uint256 seed) internal view returns (address) {
        return subjects[seed % 5];
    }

    /// For an admission: half the time a subject removed before (from this
    /// role, or the router of that kind), so re-admissions are common.
    function _admitted(bytes32 kind, uint256 seed) internal view returns (address) {
        address[5] storage pool = kind == ROUTER_KIND ? routers : subjects;
        if (seed % 2 == 0) {
            for (uint256 i; i < 5; ++i) {
                address candidate = pool[(seed / 2 + i) % 5];
                if (model.removedAt[kind][candidate] != 0) return candidate;
            }
        }
        return pool[(seed / 2) % 5];
    }

    /// The preferred party most of the time, anyone else otherwise: the other
    /// role holder, a stranger, an operator or publisher, a former guardian or
    /// governance, the pending governance.
    function _caller(uint256 seed, address preferred) internal view returns (address) {
        uint256 pick = seed % 16;
        if (pick < 9) return preferred;
        if (pick < 11) return model.governance;
        if (pick < 13) return model.guardian;
        if (pick == 13) return strangers[(seed >> 8) % 4];
        if (pick == 14) return subjects[(seed >> 8) % 5];
        if (formerRoles.length != 0 && (seed >> 16) % 2 == 0) return formerRoles[(seed >> 24) % formerRoles.length];
        return model.pending != address(0) ? model.pending : governancePool[(seed >> 8) % 3];
    }

    function _version(uint256 seed) internal pure returns (uint16) {
        uint16[8] memory versions = [uint16(0), 1, 211, 212, 213, 220, type(uint16).max, uint16(seed >> 8)];
        return versions[seed % 8];
    }

    function _timelockValue(uint256 seed) internal pure returns (uint32) {
        uint32[6] memory values = [uint32(1 hours - 1), 1 hours, 6 hours, 1 days, 30 days, 30 days + 1];
        return values[seed % 6];
    }

    function _liveCount() internal view returns (uint256 count) {
        for (uint256 i; i < ids.length; ++i) {
            if (changes[ids[i]].state == LIVE) ++count;
        }
    }

    /// The (seed mod n)-th pending change, if any.
    function _live(uint256 seed) internal view returns (bool found, bytes32 id) {
        uint256 count = _liveCount();
        if (count == 0) return (false, bytes32(0));
        uint256 wanted = seed % count;
        for (uint256 i; i < ids.length; ++i) {
            if (changes[ids[i]].state != LIVE) continue;
            if (wanted == 0) return (true, ids[i]);
            --wanted;
        }
    }

    /// A pending change three times in four; otherwise any id ever scheduled
    /// (spent or cancelled) or one never scheduled.
    function _target(uint256 seed) internal view returns (bytes32) {
        if (seed % 4 != 3) {
            (bool found, bytes32 id) = _live(seed >> 2);
            if (found) return id;
        }
        if (ids.length == 0 || (seed >> 2) % 5 == 0) return keccak256(abi.encode("never scheduled", seed));
        return ids[(seed >> 2) % ids.length];
    }

    // ================================================================ the model

    /// Refused at scheduling, per kind (F1 doc, "Changes"): canonical words
    /// only, then the value's own rule.
    function _admissible(bytes32 kind, bytes memory data) internal view returns (bool) {
        if (kind == OPERATOR_KIND || kind == PUBLISHER_KIND) {
            if (data.length != 64) return false;
            (uint256 who, uint256 flag) = abi.decode(data, (uint256, uint256));
            return who != 0 && who <= type(uint160).max && flag <= 1;
        }
        if (kind == ROUTER_KIND) {
            if (data.length != 64) return false;
            (uint256 router, uint256 version) = abi.decode(data, (uint256, uint256));
            if (router > type(uint160).max || version > type(uint16).max) return false;
            if (version == 0) return router != 0;
            return version >= 212 && address(uint160(router)).code.length != 0;
        }
        if (kind == CURRENCY_KIND) {
            if (data.length != 64) return false;
            (uint256 token, uint256 rank) = abi.decode(data, (uint256, uint256));
            if (token > type(uint160).max || rank > type(uint8).max) return false;
            return rank == 0 || token == 0 || address(uint160(token)).code.length != 0;
        }
        if (kind == RECIPIENT_KIND || kind == GUARDIAN_KIND) {
            if (data.length != 32) return false;
            uint256 who = abi.decode(data, (uint256));
            return who != 0 && who <= type(uint160).max;
        }
        if (kind == TIMELOCK_KIND) {
            if (data.length != 32) return false;
            uint256 value = abi.decode(data, (uint256));
            return value >= 1 hours && value <= 30 days;
        }
        return kind == RESUME_KIND && data.length == 0;
    }

    function _holds(bytes32 kind, address who) internal view returns (bool) {
        return kind == OPERATOR_KIND ? model.operator[who] : model.publisher[who];
    }

    /// The rules at execution (F1 doc, "The guardian's emergency actions
    /// cannot be undone quietly" and "Other rules"): a re-admission or a
    /// resume only if scheduled after the subject's last removal or the last
    /// halt; never an operator who publishes, nor the reverse.
    function _staleness(Change storage c) internal view returns (bool stale, bool disjointness) {
        bytes memory data = c.data;
        if (c.kind == OPERATOR_KIND || c.kind == PUBLISHER_KIND) {
            (address who, bool allowed) = abi.decode(data, (address, bool));
            if (!allowed) return (false, false);
            stale = c.scheduledAt <= model.removedAt[c.kind][who];
            disjointness = _holds(c.kind == OPERATOR_KIND ? PUBLISHER_KIND : OPERATOR_KIND, who);
        } else if (c.kind == ROUTER_KIND) {
            (address router, uint16 version) = abi.decode(data, (address, uint16));
            stale = version != 0 && c.scheduledAt <= model.removedAt[ROUTER_KIND][router];
        } else if (c.kind == RESUME_KIND) {
            stale = c.scheduledAt <= model.haltedAt;
        }
    }

    function _predictExecution(address caller, bytes32 id) internal view returns (bytes4) {
        if (caller != model.governance) return UNAUTHORIZED;
        Change storage c = changes[id];
        if (c.state != LIVE) return INVALID;
        if (clock < c.executableAt) return NOT_READY;
        (bool stale, bool disjointness) = _staleness(c);
        return stale || disjointness ? INVALID : bytes4(0);
    }

    function _setRole(bytes32 kind, address who, bool allowed) internal {
        if (kind == OPERATOR_KIND) model.operator[who] = allowed;
        else model.publisher[who] = allowed;
        if (!allowed) model.removedAt[kind][who] = uint64(clock);
    }

    function _applyModel(Change storage c) internal {
        bytes memory data = c.data;
        bytes32 kind = c.kind;
        if (kind == OPERATOR_KIND || kind == PUBLISHER_KIND) {
            (address who, bool allowed) = abi.decode(data, (address, bool));
            _setRole(kind, who, allowed);
            if (allowed) admittedFrom[kind][who] = c.scheduledAt;
        } else if (kind == ROUTER_KIND) {
            (address router, uint16 version) = abi.decode(data, (address, uint16));
            model.version[router] = version;
            if (version == 0) model.removedAt[ROUTER_KIND][router] = uint64(clock);
            else admittedFrom[ROUTER_KIND][router] = c.scheduledAt;
        } else if (kind == CURRENCY_KIND) {
            (address token, uint8 rank) = abi.decode(data, (address, uint8));
            model.rank[token] = rank;
        } else if (kind == RECIPIENT_KIND) {
            model.recipient = abi.decode(data, (address));
        } else if (kind == GUARDIAN_KIND) {
            address next = abi.decode(data, (address));
            if (next != model.guardian) formerRoles.push(model.guardian);
            model.guardian = next;
        } else if (kind == TIMELOCK_KIND) {
            model.timelock = abi.decode(data, (uint32));
        } else if (kind == RESUME_KIND) {
            model.halted = false;
            admittedFrom[RESUME_KIND][address(0)] = c.scheduledAt;
        }
    }

    // ============================================================= checking

    function _breach(string memory what) internal {
        lastBreach = what;
    }

    /// The outcome must be the predicted one: success (bytes4(0)) or a revert
    /// with exactly that selector.
    function _outcome(bool ok, bytes memory out, bytes4 expected, string memory what) internal {
        bool predicted = expected == bytes4(0) ? ok : (!ok && out.length >= 4 && bytes4(out) == expected);
        if (!predicted) {
            ++mismatches;
            _breach(what);
        }
    }

    function _as(address caller, address target, bytes memory data) internal returns (bool ok, bytes memory out) {
        vm.prank(caller);
        (ok, out) = target.call(data);
    }

    function _trust() internal view returns (Trust memory t) {
        for (uint256 i; i < 5; ++i) {
            if (registry.isOperator(subjects[i])) t.operators |= 1 << i;
            if (registry.isPublisher(subjects[i])) t.publishers |= 1 << i;
            t.versions[i] = registry.routerVersion(routers[i]);
            t.ranks[i] = registry.chargeCurrencyRank(tokens[i]);
        }
        t.governance = registry.governance();
        t.pending = registry.pendingGovernance();
        t.guardian = registry.guardian();
        t.recipient = registry.feeRecipient();
        t.timelock = registry.timelockSeconds();
        t.epoch = registry.observationEpoch();
        t.halted = registry.automationHalted();
        t.haltedAt = registry.haltedAt();
    }

    function _same(Trust memory a, Trust memory b) internal pure returns (bool) {
        return keccak256(abi.encode(a)) == keccak256(abi.encode(b));
    }

    /// `b` trusts no more than `a`: no role, router or rank added or changed
    /// (a router may only fall to 0), no singleton moved, the epoch not
    /// lowered, the halt not lifted.
    function _onlyNarrowed(Trust memory a, Trust memory b) internal pure returns (bool) {
        if (b.operators & ~a.operators != 0 || b.publishers & ~a.publishers != 0) return false;
        for (uint256 i; i < 5; ++i) {
            if ((b.versions[i] != a.versions[i] && b.versions[i] != 0) || b.ranks[i] != a.ranks[i]) return false;
        }
        return b.governance == a.governance && b.pending == a.pending && b.guardian == a.guardian
            && b.recipient == a.recipient && b.timelock == a.timelock && b.epoch >= a.epoch && (b.halted || !a.halted);
    }

    /// After every action: the halt moved only through its two paths, the
    /// epoch did not fall, and trust widened only through an executed change
    /// (checked in _execute) or a governance hand-over.
    function _post(Trust memory a, uint8 tag, address caller) internal {
        Trust memory b = _trust();
        bool resumed = tag == A_EXECUTE && executedKind == RESUME_KIND && executedScheduledAt > a.haltedAt;
        if (
            (!a.halted && b.halted && tag != A_HALT) || (a.halted && !b.halted && !resumed)
                || (b.haltedAt != a.haltedAt && tag != A_HALT) || b.haltedAt < a.haltedAt
        ) {
            ++haltBreaches;
            _breach("the halt moved outside its paths");
        }
        if (b.epoch < a.epoch) {
            ++epochDrops;
            _breach("the epoch fell");
        }
        executedKind = bytes32(0);
        if (tag == A_EXECUTE) return;
        if (tag == A_TRANSFER) a.pending = b.pending;
        if (tag == A_ACCEPT) (a.governance, a.pending) = (b.governance, b.pending);
        if (tag == A_HALT) a.haltedAt = b.haltedAt;
        if (!(tag == A_NARROW || tag == A_HALT ? _onlyNarrowed(a, b) : _same(a, b))) {
            ++untimedWidenings;
            _breach("trust widened outside an executed change");
            if (caller == model.guardian && caller != model.governance) ++guardianWidenings;
        }
    }

    /// `t` with exactly the scheduled change applied.
    function _expectedAfter(Trust memory t, Change storage c) internal view returns (Trust memory) {
        bytes memory data = c.data;
        bytes32 kind = c.kind;
        if (kind == OPERATOR_KIND || kind == PUBLISHER_KIND) {
            (address who, bool allowed) = abi.decode(data, (address, bool));
            for (uint256 i; i < 5; ++i) {
                if (subjects[i] != who) continue;
                uint256 bit = 1 << i;
                if (kind == OPERATOR_KIND) t.operators = allowed ? t.operators | bit : t.operators & ~bit;
                else t.publishers = allowed ? t.publishers | bit : t.publishers & ~bit;
            }
        } else if (kind == ROUTER_KIND) {
            (address router, uint16 version) = abi.decode(data, (address, uint16));
            for (uint256 i; i < 5; ++i) {
                if (routers[i] == router) t.versions[i] = version;
            }
        } else if (kind == CURRENCY_KIND) {
            (address token, uint8 rank) = abi.decode(data, (address, uint8));
            for (uint256 i; i < 5; ++i) {
                if (tokens[i] == token) t.ranks[i] = rank;
            }
        } else if (kind == RECIPIENT_KIND) {
            t.recipient = abi.decode(data, (address));
        } else if (kind == GUARDIAN_KIND) {
            t.guardian = abi.decode(data, (address));
        } else if (kind == TIMELOCK_KIND) {
            t.timelock = abi.decode(data, (uint32));
        } else if (kind == RESUME_KIND) {
            t.halted = false;
        }
        return t;
    }

    // ============================================================= the calls

    function _schedule(address caller, bytes32 kind, bytes memory data) internal {
        Trust memory before = _trust();
        bytes4 expected = caller != model.governance ? UNAUTHORIZED : !_admissible(kind, data) ? INVALID : bytes4(0);
        (bool ok, bytes memory out) =
            _as(caller, address(registry), abi.encodeCall(IDominoRegistry.scheduleChange, (kind, data)));
        _outcome(ok, out, expected, "scheduleChange");
        if (ok && out.length == 32) {
            bytes32 id = abi.decode(out, (bytes32));
            // "Each change gets a fresh id (keccak256(kind, data, counter))".
            if (id != keccak256(abi.encode(kind, data, ++changeCounter)) || changes[id].state != 0) {
                ++mismatches;
                _breach("a change id is not fresh");
            }
            changes[id] = Change(kind, data, uint64(clock), uint64(clock) + model.timelock, LIVE);
            ids.push(id);
            ++scheduledOf[kind];
        } else if (!ok && expected == INVALID) {
            ++refusedSchedules;
        }
        _post(before, A_SCHEDULE, caller);
    }

    function _execute(address caller, bytes32 id) internal returns (bool ok) {
        Trust memory before = _trust();
        Change storage c = changes[id];
        bytes4 expected = _predictExecution(caller, id);
        bool live = c.state == LIVE;
        bool stale;
        bool admission;
        uint64 removedBefore;
        if (live) {
            (stale,) = _staleness(c);
            (admission, removedBefore) = _lastRemoval(c);
        }
        bytes memory out;
        (ok, out) = _as(caller, address(registry), abi.encodeCall(IDominoRegistry.executeChange, (id)));
        _outcome(ok, out, expected, "executeChange");
        if (ok && !live) {
            ++earlyExecutions;
            _breach("executed a change that is not pending");
        } else if (ok) {
            if (clock < c.executableAt) {
                ++earlyExecutions;
                _breach("executed before its timelock");
            }
            if (admission && c.scheduledAt <= removedBefore) {
                ++readmissionBreaches;
                _breach("re-admitted by a change scheduled before the removal or the halt");
            }
            if (admission && removedBefore != 0) {
                if (c.kind == RESUME_KIND) ++resumes;
                else ++readmissions;
            }
            if (!_same(_expectedAfter(_copy(before), c), _trust())) {
                ++offScheduleEffects;
                _breach("an execution's effect differs from its schedule");
            }
            (executedKind, executedScheduledAt) = (c.kind, c.scheduledAt);
            _applyModel(c);
            c.state = EXECUTED;
            ++executedOf[c.kind];
        } else if (expected == NOT_READY) {
            ++earlyRefusals;
        } else if (expected == INVALID && stale) {
            if (c.kind == RESUME_KIND) ++staleResumes;
            else ++staleReadmissions;
        }
        _post(before, A_EXECUTE, caller);
    }

    function _copy(Trust memory t) internal pure returns (Trust memory) {
        return abi.decode(abi.encode(t), (Trust));
    }

    /// For an admission or a resume: the time of the subject's last removal,
    /// or of the last halt, before this execution (0 if never).
    function _lastRemoval(Change storage c) internal view returns (bool admission, uint64 removed) {
        bytes memory data = c.data;
        if (c.kind == OPERATOR_KIND || c.kind == PUBLISHER_KIND) {
            (address who, bool allowed) = abi.decode(data, (address, bool));
            return (allowed, model.removedAt[c.kind][who]);
        }
        if (c.kind == ROUTER_KIND) {
            (address router, uint16 version) = abi.decode(data, (address, uint16));
            return (version != 0, model.removedAt[ROUTER_KIND][router]);
        }
        if (c.kind == RESUME_KIND) return (true, model.haltedAt);
    }

    function _cancel(address caller, bytes32 id) internal returns (bool ok) {
        Trust memory before = _trust();
        Change storage c = changes[id];
        bytes4 expected;
        if (caller != model.guardian && caller != model.governance) expected = UNAUTHORIZED;
        else if (c.state != LIVE) expected = INVALID;
        else if (caller != model.governance && c.kind == GUARDIAN_KIND) expected = UNAUTHORIZED;
        bytes memory out;
        (ok, out) = _as(caller, address(registry), abi.encodeCall(IDominoRegistry.cancelChange, (id)));
        _outcome(ok, out, expected, "cancelChange");
        if (ok) {
            c.state = CANCELLED;
            if (caller == model.governance) ++governanceCancels;
            else ++guardianCancels;
        } else if (c.state == LIVE && c.kind == GUARDIAN_KIND && caller == model.guardian) {
            ++guardianVetoesOfItsReplacement;
        }
        _post(before, A_CANCEL, caller);
    }

    function _remove(bytes32 kind, address caller, address who) internal returns (bool ok) {
        Trust memory before = _trust();
        bytes4 expected = caller == model.guardian || caller == model.governance ? bytes4(0) : UNAUTHORIZED;
        bytes memory call = kind == OPERATOR_KIND
            ? abi.encodeCall(IDominoRegistry.removeOperator, (who))
            : kind == PUBLISHER_KIND
                ? abi.encodeCall(IDominoRegistry.removePublisher, (who))
                : abi.encodeCall(IDominoRegistry.removeRouter, (who));
        bytes memory out;
        (ok, out) = _as(caller, address(registry), call);
        _outcome(ok, out, expected, "remove");
        if (ok) {
            if (kind == ROUTER_KIND) {
                model.version[who] = 0;
                model.removedAt[ROUTER_KIND][who] = uint64(clock);
            } else {
                _setRole(kind, who, false);
            }
            ++removals;
        }
        _post(before, A_NARROW, caller);
    }

    function _halt(address caller) internal returns (bool ok) {
        Trust memory before = _trust();
        bytes4 expected = caller == model.guardian || caller == model.governance ? bytes4(0) : UNAUTHORIZED;
        bytes memory out;
        (ok, out) = _as(caller, address(registry), abi.encodeCall(IDominoRegistry.haltAutomation, ()));
        _outcome(ok, out, expected, "haltAutomation");
        if (ok) {
            model.halted = true;
            model.haltedAt = uint64(clock);
            ++halts;
        }
        _post(before, A_HALT, caller);
    }

    // ================================================== governance actions

    function scheduleOperator(uint256 subjectSeed, bool allowed, uint256 callerSeed) external action {
        address who = allowed ? _admitted(OPERATOR_KIND, subjectSeed) : _subject(subjectSeed);
        _schedule(_caller(callerSeed, model.governance), OPERATOR_KIND, abi.encode(who, allowed));
    }

    function schedulePublisher(uint256 subjectSeed, bool allowed, uint256 callerSeed) external action {
        address who = allowed ? _admitted(PUBLISHER_KIND, subjectSeed) : _subject(subjectSeed);
        _schedule(_caller(callerSeed, model.governance), PUBLISHER_KIND, abi.encode(who, allowed));
    }

    function scheduleRouter(uint256 routerSeed, uint256 versionSeed, uint256 callerSeed) external action {
        uint16 version = _version(versionSeed);
        address router = routerSeed % 7 == 6
            ? address(0)
            : version == 0 ? routers[routerSeed % 5] : _admitted(ROUTER_KIND, routerSeed);
        _schedule(_caller(callerSeed, model.governance), ROUTER_KIND, abi.encode(router, version));
    }

    function scheduleChargeCurrency(uint256 tokenSeed, uint256 rankSeed, uint256 callerSeed) external action {
        uint8[5] memory ranks = [uint8(0), 1, 2, 3, type(uint8).max];
        _schedule(
            _caller(callerSeed, model.governance), CURRENCY_KIND, abi.encode(tokens[tokenSeed % 5], ranks[rankSeed % 5])
        );
    }

    function scheduleFeeRecipient(uint256 seed, uint256 callerSeed) external action {
        address next = seed % 4 == 3 ? address(0) : recipientPool[seed % 4];
        _schedule(_caller(callerSeed, model.governance), RECIPIENT_KIND, abi.encode(next));
    }

    function scheduleGuardian(uint256 seed, uint256 callerSeed) external action {
        uint256 pick = seed % 5;
        address next = pick < 3 ? guardianPool[pick] : pick == 3 ? address(0) : model.governance;
        _schedule(_caller(callerSeed, model.governance), GUARDIAN_KIND, abi.encode(next));
    }

    function scheduleTimelock(uint256 seed, uint256 callerSeed) external action {
        _schedule(_caller(callerSeed, model.governance), TIMELOCK_KIND, abi.encode(_timelockValue(seed)));
    }

    function scheduleResume(uint256 callerSeed) external action {
        _schedule(_caller(callerSeed, model.governance), RESUME_KIND, "");
    }

    /// Non-canonical data, unknown kinds and words of the wrong type for
    /// their kind: an extra or missing word, an odd length, dirty high bits.
    function scheduleRaw(uint256 kindSeed, uint256 wordSeed, uint8 shape) external action {
        bytes32[10] memory kinds = [
            OPERATOR_KIND,
            PUBLISHER_KIND,
            ROUTER_KIND,
            CURRENCY_KIND,
            RECIPIENT_KIND,
            GUARDIAN_KIND,
            TIMELOCK_KIND,
            RESUME_KIND,
            keccak256("domino.registry.unknown"),
            bytes32(0)
        ];
        uint256 w0 = _rawWord(kindSeed >> 8, wordSeed);
        uint256 w1 = _rawWord(kindSeed >> 16, wordSeed >> 128);
        bytes memory data;
        uint8 s = shape % 6;
        if (s == 1) data = abi.encode(w0);
        else if (s == 2) data = abi.encode(w0, w1);
        else if (s == 3) data = abi.encode(w0, w1, w1);
        else if (s == 4) data = abi.encodePacked(w0, bytes1(0x01));
        else if (s == 5) data = abi.encodePacked(w0, w1, bytes1(0x00));
        _schedule(_caller(kindSeed >> 24, model.governance), kinds[kindSeed % 10], data);
    }

    function _rawWord(uint256 pick, uint256 noise) internal view returns (uint256 w) {
        uint256[12] memory values = [uint256(0), 1, 2, 211, 212, 255, 256, 65_535, 65_536, 1 hours, 30 days, 30 days + 1];
        uint256 p = pick % 6;
        if (p == 0) w = uint160(subjects[noise % 5]);
        else if (p == 1) w = uint160(routers[noise % 5]);
        else if (p == 2) w = uint160(tokens[noise % 5]);
        else if (p == 3) w = noise;
        else w = values[noise % 12];
        // Dirty bits above the type's width, one time in four.
        if ((pick >> 4) % 4 == 0) w |= 1 << (160 + (noise >> 8) % 96);
    }

    function executeChange(uint256 seed, uint256 callerSeed) external action {
        _execute(_caller(callerSeed, model.governance), _target(seed));
    }

    /// Warps to the second before, at or after a pending change's
    /// executableAt (or later), then governance executes it.
    function executeWhenReady(uint256 seed, uint256 offsetSeed) external action {
        (bool found, bytes32 id) = _live(seed);
        if (!found) return;
        uint256 at = changes[id].executableAt;
        uint256 pick = offsetSeed % 4;
        at = pick == 0 ? at - 1 : pick == 1 ? at : pick == 2 ? at + 1 : at + 1 + (offsetSeed >> 8) % model.timelock;
        if (at > clock) {
            clock = at;
            vm.warp(at);
        }
        _execute(model.governance, id);
    }

    function cancelChange(uint256 seed, uint256 callerSeed) external action {
        _cancel(_caller(callerSeed, model.guardian), _target(seed));
    }

    function transferGovernance(uint256 seed, uint256 callerSeed) external action {
        uint256 pick = seed % 5;
        address next = pick < 3 ? governancePool[pick] : pick == 3 ? address(0) : model.guardian;
        address caller = _caller(callerSeed, model.governance);
        Trust memory before = _trust();
        bytes4 expected = caller == model.governance ? bytes4(0) : UNAUTHORIZED;
        (bool ok, bytes memory out) =
            _as(caller, address(registry), abi.encodeCall(IDominoRegistry.transferGovernance, (next)));
        _outcome(ok, out, expected, "transferGovernance");
        if (ok) model.pending = next;
        _post(before, A_TRANSFER, caller);
    }

    function acceptGovernance(uint256 seed) external action {
        address caller =
            model.pending != address(0) && seed % 4 != 3 ? model.pending : _caller(seed >> 2, governancePool[seed % 3]);
        Trust memory before = _trust();
        bytes4 expected = model.pending != address(0) && caller == model.pending ? bytes4(0) : UNAUTHORIZED;
        (bool ok, bytes memory out) = _as(caller, address(registry), abi.encodeCall(IDominoRegistry.acceptGovernance, ()));
        _outcome(ok, out, expected, "acceptGovernance");
        if (ok) {
            if (caller != model.governance) formerRoles.push(model.governance);
            model.governance = caller;
            model.pending = address(0);
            ++handovers;
        }
        _post(before, A_ACCEPT, caller);
    }

    // ==================================================== guardian actions

    function removeOperator(uint256 subjectSeed, uint256 callerSeed) external action {
        address who = subjectSeed % 11 == 10 ? address(0) : _subject(subjectSeed);
        _remove(OPERATOR_KIND, _caller(callerSeed, model.guardian), who);
    }

    function removePublisher(uint256 subjectSeed, uint256 callerSeed) external action {
        address who = subjectSeed % 11 == 10 ? address(0) : _subject(subjectSeed);
        _remove(PUBLISHER_KIND, _caller(callerSeed, model.guardian), who);
    }

    function removeRouter(uint256 routerSeed, uint256 callerSeed) external action {
        address router = routerSeed % 11 == 10 ? address(0) : routers[routerSeed % 5];
        _remove(ROUTER_KIND, _caller(callerSeed, model.guardian), router);
    }

    function raiseEpoch(uint256 seed, uint256 callerSeed) external action {
        uint256 epoch = model.epoch;
        uint256 pick = seed % 6;
        uint256 next = pick == 0
            ? epoch
            : pick == 1
                ? epoch + 1
                : pick == 2 ? clock : pick == 3 ? clock + 1 : pick == 4 ? (epoch == 0 ? 0 : epoch - 1) : epoch + (seed >> 8) % (clock - epoch + 1);
        address caller = _caller(callerSeed, model.guardian);
        Trust memory before = _trust();
        bytes4 expected = caller != model.guardian && caller != model.governance
            ? UNAUTHORIZED
            : next <= epoch || next > clock ? INVALID : bytes4(0);
        (bool ok, bytes memory out) =
            _as(caller, address(registry), abi.encodeCall(IDominoRegistry.raiseObservationEpoch, (uint64(next))));
        _outcome(ok, out, expected, "raiseObservationEpoch");
        if (ok) {
            model.epoch = uint64(next);
            ++epochRaises;
        }
        _post(before, A_NARROW, caller);
    }

    function halt(uint256 callerSeed) external action {
        _halt(_caller(callerSeed, model.guardian));
    }

    /// At the second a pending change becomes executable, the guardian acts
    /// first: it cancels it or, for a re-admission or a resume, removes the
    /// subject or halts again. Governance's execution in the same second must
    /// then fail.
    function guardianFrontRuns(uint256 seed, uint8 how) external action {
        (bool found, bytes32 id) = _live(seed);
        if (!found) return;
        Change storage c = changes[id];
        if (c.executableAt > clock) {
            clock = c.executableAt;
            vm.warp(clock);
        }
        address guardian = model.guardian;
        bool acted;
        bytes memory data = c.data;
        if (how % 2 == 1 && (c.kind == OPERATOR_KIND || c.kind == PUBLISHER_KIND)) {
            (address who, bool allowed) = abi.decode(data, (address, bool));
            if (allowed) acted = _remove(c.kind, guardian, who);
        } else if (how % 2 == 1 && c.kind == ROUTER_KIND) {
            (address router, uint16 version) = abi.decode(data, (address, uint16));
            if (version != 0) acted = _remove(ROUTER_KIND, guardian, router);
        } else if (how % 2 == 1 && c.kind == RESUME_KIND) {
            acted = _halt(guardian);
        }
        if (!acted) acted = _cancel(guardian, id);
        bool executed = _execute(model.governance, id);
        if (acted && !executed) ++frontRuns;
    }

    // ============================================================== anchor

    /// Observation i at `at`: nonce i, valid for the widest window, so its
    /// hash depends on the subject and the date only.
    function _observationOf(uint256 i, uint64 at) internal pure returns (DominoV2Types.PriceObservation memory) {
        return _point(at, at + type(uint32).max, uint64(i));
    }

    function revokeObservation(uint256 subjectSeed, uint256 dateSeed, uint256 callerSeed) external action {
        uint256 epoch = model.epoch;
        uint256[5] memory dates = [epoch == 0 ? 0 : epoch - 1, epoch, clock, clock - 1, epoch + 1];
        bytes32 digest = _digest(anchor, _observationOf(subjectSeed % 5, uint64(dates[dateSeed % 5])));
        uint256 pick = callerSeed % 6;
        address caller = pick < 2
            ? model.guardian
            : pick == 2 ? model.governance : pick < 5 ? subjects[(callerSeed >> 8) % 5] : _caller(callerSeed >> 8, strangers[0]);
        Trust memory before = _trust();
        bytes4 expected = caller != model.guardian && caller != model.governance && !model.publisher[caller]
            ? UNAUTHORIZED
            : model.revoked[digest] ? OBSERVATION_REVOKED : bytes4(0);
        (bool ok, bytes memory out) =
            _as(caller, address(anchor), abi.encodeCall(IDominoPriceAnchor.revokeObservation, (digest)));
        _outcome(ok, out, expected, "revokeObservation");
        if (ok) {
            model.revoked[digest] = true;
            revokedHashes.push(digest);
            ++revocations;
        }
        _post(before, A_OTHER, caller);
    }

    // =========================================================== strangers

    /// A party with no role tries each privileged call: always Unauthorized.
    function strangerTries(uint256 seed, uint8 which) external action {
        address stranger = strangers[seed % 4];
        address target = address(registry);
        bytes memory call;
        uint8 w = which % 11;
        if (w == 0) call = abi.encodeCall(IDominoRegistry.scheduleChange, (RECIPIENT_KIND, abi.encode(stranger)));
        else if (w == 1) call = abi.encodeCall(IDominoRegistry.executeChange, (_target(seed >> 2)));
        else if (w == 2) call = abi.encodeCall(IDominoRegistry.cancelChange, (_target(seed >> 2)));
        else if (w == 3) call = abi.encodeCall(IDominoRegistry.transferGovernance, (stranger));
        else if (w == 4) call = abi.encodeCall(IDominoRegistry.acceptGovernance, ());
        else if (w == 5) call = abi.encodeCall(IDominoRegistry.removeOperator, (_subject(seed >> 2)));
        else if (w == 6) call = abi.encodeCall(IDominoRegistry.removePublisher, (_subject(seed >> 2)));
        else if (w == 7) call = abi.encodeCall(IDominoRegistry.removeRouter, (routers[(seed >> 2) % 5]));
        else if (w == 8) call = abi.encodeCall(IDominoRegistry.raiseObservationEpoch, (uint64(clock)));
        else if (w == 9) call = abi.encodeCall(IDominoRegistry.haltAutomation, ());
        else (target, call) = (address(anchor), abi.encodeCall(IDominoPriceAnchor.revokeObservation, (keccak256(abi.encode(seed)))));
        Trust memory before = _trust();
        (bool ok, bytes memory out) = _as(stranger, target, call);
        _outcome(ok, out, UNAUTHORIZED, "a stranger's call");
        if (!ok) ++strangerRefusals;
        _post(before, A_OTHER, stranger);
    }

    // ================================================================ time

    /// One second, a minute, a second either side of the timelock, the
    /// timelock itself, twice it, or anything up to three times it.
    function warp(uint256 seed) external {
        uint256 timelock = model.timelock;
        uint256 pick = seed % 7;
        uint256 delta = pick == 0
            ? 1
            : pick == 1
                ? 59
                : pick == 2 ? timelock - 1 : pick == 3 ? timelock : pick == 4 ? timelock + 1 : pick == 5 ? 2 * timelock : 1 + (seed >> 8) % (3 * timelock);
        clock += delta;
        vm.warp(clock);
        ++warps;
    }

    // ========================================================= the event log

    /// Rebuilds the registry from the events of the last action, as an
    /// indexer would, and checks each event against what preceded it.
    function _replay() internal {
        AdvVm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(anchor)) {
                if (logs[i].topics[0] == IDominoPriceAnchor.ObservationRevokedBy.selector) {
                    log.revoked[logs[i].topics[1]] = true;
                }
                continue;
            }
            if (logs[i].emitter != address(registry)) continue;
            _replayOne(logs[i]);
        }
    }

    function _topicAddress(AdvVm.Log memory entry, uint256 index) internal pure returns (address) {
        return address(uint160(uint256(entry.topics[index])));
    }

    function _replayOne(AdvVm.Log memory entry) internal {
        bytes32 topic = entry.topics[0];
        if (topic == IDominoRegistry.ChangeScheduled.selector) {
            bytes32 id = entry.topics[1];
            (bytes memory data, uint64 executableAt) = abi.decode(entry.data, (bytes, uint64));
            Change storage c = changes[id];
            if (c.kind != entry.topics[2] || keccak256(c.data) != keccak256(data) || c.executableAt != executableAt) {
                _eventBreach("ChangeScheduled differs from the change");
            }
            log.live[id] = true;
            log.timelock = uint32(executableAt - clock);
        } else if (topic == IDominoRegistry.ChangeExecuted.selector) {
            bytes32 id = entry.topics[1];
            bytes memory data = abi.decode(entry.data, (bytes));
            if (!log.live[id] || changes[id].kind != entry.topics[2] || keccak256(changes[id].data) != keccak256(data)) {
                _eventBreach("ChangeExecuted for no pending change");
            }
            log.live[id] = false;
            if (entry.topics[2] == TIMELOCK_KIND) log.timelock = abi.decode(data, (uint32));
        } else if (topic == IDominoRegistry.ChangeCancelled.selector) {
            if (!log.live[entry.topics[1]]) _eventBreach("ChangeCancelled for no pending change");
            log.live[entry.topics[1]] = false;
        } else if (topic == IDominoRegistry.GovernanceTransferStarted.selector) {
            if (_topicAddress(entry, 1) != log.governance) _eventBreach("a transfer started by another governance");
            log.pending = _topicAddress(entry, 2);
        } else if (topic == IDominoRegistry.GovernanceTransferred.selector) {
            if (_topicAddress(entry, 1) != log.governance) _eventBreach("a transfer from another governance");
            log.governance = _topicAddress(entry, 2);
            log.pending = address(0);
        } else if (topic == IDominoRegistry.GuardianChanged.selector) {
            if (_topicAddress(entry, 1) != log.guardian) _eventBreach("a guardian change from another guardian");
            log.guardian = _topicAddress(entry, 2);
        } else if (topic == IDominoRegistry.OperatorSet.selector || topic == IDominoRegistry.PublisherSet.selector) {
            address who = _topicAddress(entry, 1);
            bool allowed = abi.decode(entry.data, (bool));
            bytes32 kind = topic == IDominoRegistry.OperatorSet.selector ? OPERATOR_KIND : PUBLISHER_KIND;
            if (kind == OPERATOR_KIND) log.operator[who] = allowed;
            else log.publisher[who] = allowed;
            if (!allowed) log.removedAt[kind][who] = uint64(clock);
        } else if (topic == IDominoRegistry.RouterSet.selector) {
            address router = _topicAddress(entry, 1);
            uint16 version = abi.decode(entry.data, (uint16));
            log.version[router] = version;
            if (version == 0) log.removedAt[ROUTER_KIND][router] = uint64(clock);
        } else if (topic == IDominoRegistry.ChargeCurrencySet.selector) {
            log.rank[_topicAddress(entry, 1)] = abi.decode(entry.data, (uint8));
        } else if (topic == IDominoRegistry.FeeRecipientSet.selector) {
            log.recipient = _topicAddress(entry, 1);
        } else if (topic == IDominoRegistry.ObservationEpochRaised.selector) {
            uint64 epoch = abi.decode(entry.data, (uint64));
            if (epoch <= log.epoch) _eventBreach("the epoch event did not rise");
            log.epoch = epoch;
        } else if (topic == IDominoRegistry.AutomationHaltSet.selector) {
            log.halted = abi.decode(entry.data, (bool));
            if (log.halted) log.haltedAt = uint64(clock);
        } else {
            _eventBreach("an undocumented registry event");
        }
    }

    function _eventBreach(string memory what) internal {
        ++eventBreaches;
        _breach(what);
    }

    // ================================================== what invariants read

    /// Every address any action can name.
    function _tracked() internal view returns (address[] memory list) {
        list = new address[](24);
        for (uint256 i; i < 5; ++i) {
            (list[i], list[5 + i], list[10 + i]) = (subjects[i], routers[i], tokens[i]);
        }
        for (uint256 i; i < 3; ++i) {
            (list[15 + i], list[18 + i], list[21 + i]) = (guardianPool[i], governancePool[i], recipientPool[i]);
        }
    }

    function _bookAgrees(Book storage book, bool knowsTimelock) internal view returns (bool, string memory) {
        if (registry.governance() != book.governance || registry.pendingGovernance() != book.pending) {
            return (false, "governance");
        }
        if (registry.guardian() != book.guardian || registry.feeRecipient() != book.recipient) {
            return (false, "guardian or fee recipient");
        }
        if (knowsTimelock && registry.timelockSeconds() != book.timelock) return (false, "timelock");
        if (registry.observationEpoch() != book.epoch) return (false, "epoch");
        if (registry.automationHalted() != book.halted || registry.haltedAt() != book.haltedAt) return (false, "halt");
        address[] memory list = _tracked();
        for (uint256 i; i < list.length; ++i) {
            address a = list[i];
            if (registry.isOperator(a) != book.operator[a] || registry.isPublisher(a) != book.publisher[a]) {
                return (false, "a role");
            }
            if (registry.routerVersion(a) != book.version[a] || registry.chargeCurrencyRank(a) != book.rank[a]) {
                return (false, "a router version or a rank");
            }
            if (
                registry.removedAt(OPERATOR_KIND, a) != book.removedAt[OPERATOR_KIND][a]
                    || registry.removedAt(PUBLISHER_KIND, a) != book.removedAt[PUBLISHER_KIND][a]
                    || registry.removedAt(ROUTER_KIND, a) != book.removedAt[ROUTER_KIND][a]
            ) return (false, "a removal time");
        }
        return (true, "");
    }

    function viewsAgreeWithTheModel() external view returns (bool ok, string memory why) {
        (ok, why) = _bookAgrees(model, true);
        if (!ok) return (ok, why);
        for (uint256 i; i < revokedHashes.length; ++i) {
            if (!anchor.isRevoked(revokedHashes[i])) return (false, "a revocation the anchor forgot");
        }
    }

    function viewsAgreeWithTheLog() external view returns (bool ok, string memory why) {
        (ok, why) = _bookAgrees(log, log.timelock != 0);
        if (!ok) return (ok, why);
        for (uint256 i; i < revokedHashes.length; ++i) {
            if (!log.revoked[revokedHashes[i]]) return (false, "a revocation without its event");
        }
        for (uint256 i; i < ids.length; ++i) {
            if (log.live[ids[i]] != (changes[ids[i]].state == LIVE)) return (false, "a pending change per the log");
        }
    }

    /// pendingChange returns each pending change as scheduled, with
    /// executableAt = scheduledAt + the timelock then in force, and nothing
    /// once it was executed or cancelled.
    function pendingViewsAgree() external view returns (bool, string memory) {
        for (uint256 i; i < ids.length; ++i) {
            Change storage c = changes[ids[i]];
            (bytes32 kind, bytes memory data, uint64 scheduledAt, uint64 executableAt) = registry.pendingChange(ids[i]);
            if (c.state == LIVE) {
                if (
                    kind != c.kind || keccak256(data) != keccak256(c.data) || scheduledAt != c.scheduledAt
                        || executableAt != c.executableAt
                ) return (false, "a pending change is not as scheduled");
            } else if (kind != bytes32(0) || data.length != 0 || scheduledAt != 0 || executableAt != 0) {
                return (false, "a spent change still pending");
            }
        }
        return (true, "");
    }

    /// Every role holder admitted after a removal was admitted by a change
    /// scheduled after it; a lifted halt was lifted by a resume scheduled
    /// after it.
    function readmissionsFollowTheRule() external view returns (bool, string memory) {
        address[] memory list = _tracked();
        for (uint256 i; i < list.length; ++i) {
            address a = list[i];
            if (model.operator[a] && admittedFrom[OPERATOR_KIND][a] != 0 && admittedFrom[OPERATOR_KIND][a] <= registry.removedAt(OPERATOR_KIND, a)) {
                return (false, "an operator re-admitted by a stale change");
            }
            if (model.publisher[a] && admittedFrom[PUBLISHER_KIND][a] != 0 && admittedFrom[PUBLISHER_KIND][a] <= registry.removedAt(PUBLISHER_KIND, a)) {
                return (false, "a publisher re-admitted by a stale change");
            }
            if (model.version[a] != 0 && admittedFrom[ROUTER_KIND][a] != 0 && admittedFrom[ROUTER_KIND][a] <= registry.removedAt(ROUTER_KIND, a)) {
                return (false, "a router re-admitted by a stale change");
            }
        }
        uint64 resumedFrom = admittedFrom[RESUME_KIND][address(0)];
        if (!registry.automationHalted() && registry.haltedAt() != 0 && resumedFrom <= registry.haltedAt()) {
            return (false, "a halt lifted by a stale resume");
        }
        return (true, "");
    }

    function rolesStayDisjoint() external view returns (bool) {
        address[] memory list = _tracked();
        for (uint256 i; i < list.length; ++i) {
            if (registry.isOperator(list[i]) && registry.isPublisher(list[i])) return false;
        }
        return true;
    }

    /// Every router admitted has a version of 212 or more (2.1.2).
    function routersAreRecent() external view returns (bool) {
        address[] memory list = _tracked();
        for (uint256 i; i < list.length; ++i) {
            uint16 version = registry.routerVersion(list[i]);
            if (version != 0 && version < 212) return false;
        }
        return true;
    }

    /// A signed observation per subject, dated just before the epoch, at it
    /// and now, is accepted by the anchor exactly when the model says: an
    /// admitted publisher now, not revoked, observedAt at or after the epoch.
    function anchorAgrees() external view returns (bool, string memory) {
        uint256 now_ = block.timestamp;
        uint256 epoch = model.epoch;
        for (uint256 i; i < 5; ++i) {
            uint256[3] memory dates = [epoch == 0 ? now_ : epoch - 1, epoch, now_];
            for (uint256 j; j < 3; ++j) {
                if (dates[j] > now_) continue;
                DominoV2Types.PriceObservation memory point = _observationOf(i, uint64(dates[j]));
                bytes32 digest = _digest(anchor, point);
                bytes4 expected = !model.publisher[subjects[i]]
                    ? INVALID_OBSERVATION
                    : model.revoked[digest] || dates[j] < epoch ? OBSERVATION_REVOKED : bytes4(0);
                (bool ok, bytes memory out) = address(anchor).staticcall(
                    abi.encodeCall(
                        IDominoPriceAnchor.verifyObservation, (point, _signed(keys[i], digest), type(uint32).max)
                    )
                );
                bool predicted = expected == bytes4(0)
                    ? ok && abi.decode(out, (uint160)) == PRICE
                    : !ok && out.length >= 4 && bytes4(out) == expected;
                if (!predicted) return (false, "the anchor disagrees with the registry");
            }
        }
        return (true, "");
    }

    function epochBounded() external view returns (bool) {
        return registry.observationEpoch() == model.epoch && model.epoch <= clock;
    }

    function liveChanges() external view returns (uint256) {
        return _liveCount();
    }
}

/// I13, the registry and governance, under every sequence the handler can
/// produce:
/// - no change executes before its timelock, nor other than as scheduled;
///   pendingChange shows each pending change as scheduled and nothing once
///   it is spent;
/// - a removed operator, publisher or router comes back, and a halt is
///   lifted, only by a change scheduled after the removal or the halt;
///   charge-currency ranks move only through executed changes;
/// - operators and publishers stay disjoint; every admitted router is 2.1.2
///   (212) or later;
/// - the observation epoch only grows and never passes the clock, and the
///   anchor accepts an observation exactly when the registry (and the
///   revocations) say it should;
/// - every call by every party has the outcome the docs predict: in
///   particular the guardian never widens trust, and nobody but governance
///   (through the timelock, or its documented immediate hand-over) does;
/// - the halt moves only through haltAutomation and an executed resume;
/// - the views agree with the model and with the registry rebuilt from its
///   events alone.
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 96
contract DominoRegistryInvariantsTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    RegistryHandler internal handler;

    function setUp() public {
        handler = new RegistryHandler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](23);
        selectors[0] = RegistryHandler.scheduleOperator.selector;
        selectors[1] = RegistryHandler.schedulePublisher.selector;
        selectors[2] = RegistryHandler.scheduleRouter.selector;
        selectors[3] = RegistryHandler.scheduleChargeCurrency.selector;
        selectors[4] = RegistryHandler.scheduleFeeRecipient.selector;
        selectors[5] = RegistryHandler.scheduleGuardian.selector;
        selectors[6] = RegistryHandler.scheduleTimelock.selector;
        selectors[7] = RegistryHandler.scheduleResume.selector;
        selectors[8] = RegistryHandler.scheduleRaw.selector;
        selectors[9] = RegistryHandler.executeChange.selector;
        selectors[10] = RegistryHandler.executeWhenReady.selector;
        selectors[11] = RegistryHandler.cancelChange.selector;
        selectors[12] = RegistryHandler.transferGovernance.selector;
        selectors[13] = RegistryHandler.acceptGovernance.selector;
        selectors[14] = RegistryHandler.removeOperator.selector;
        selectors[15] = RegistryHandler.removePublisher.selector;
        selectors[16] = RegistryHandler.removeRouter.selector;
        selectors[17] = RegistryHandler.raiseEpoch.selector;
        selectors[18] = RegistryHandler.halt.selector;
        selectors[19] = RegistryHandler.guardianFrontRuns.selector;
        selectors[20] = RegistryHandler.revokeObservation.selector;
        selectors[21] = RegistryHandler.strangerTries.selector;
        selectors[22] = RegistryHandler.warp.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    /// The handler is only evidence if its actions reach the registry: a
    /// scripted pass through every action and outcome, with every invariant
    /// checked after it.
    /// Seeds: caller seed 0 is the preferred party (governance for governance
    /// actions, the guardian for narrowing ones), 9 governance, 11 the
    /// guardian; an admission seed of 2k + 1 names subject (or router) k; a
    /// change seed of 4k picks the k-th pending change.
    function testTheHandlerReachesEveryAction() public {
        // Governance schedules one change of every kind.
        handler.scheduleOperator(7, true, 0); // #0: subject 3 operates
        handler.schedulePublisher(9, true, 0); // #1: subject 4 publishes
        handler.scheduleRouter(3, 5, 0); // #2: router 1 at 2.2.0
        handler.scheduleChargeCurrency(3, 3, 0); // #3: token 3 at rank 3
        handler.scheduleFeeRecipient(1, 0); // #4
        handler.scheduleGuardian(1, 0); // #5: guardian 0x6A2E
        handler.scheduleTimelock(2, 0); // #6: six hours
        handler.scheduleResume(0); // #7: a resume while nothing is halted
        handler.scheduleRouter(1, 1, 0); // refused: version 1
        handler.scheduleRaw(0, 0, 3); // refused: three dirty words for an operator
        // Everyone else is refused everything.
        for (uint8 w; w < 11; ++w) {
            handler.strangerTries(w, w);
        }
        handler.scheduleOperator(0, false, 11); // the guardian may not schedule
        // In the same second, the guardian halts and removes subject 3 and
        // router 1: #0, #2 and #7 are void for good.
        handler.halt(0);
        handler.removeOperator(3, 0);
        handler.removeRouter(1, 0);
        // It may not veto its own replacement (#5).
        handler.cancelChange(5 * 4, 0);
        require(handler.guardianVetoesOfItsReplacement() == 1, "the guardian vetoed its replacement");
        // A second later governance schedules both again, and a resume.
        handler.warp(0);
        handler.scheduleOperator(7, true, 0); // #8
        handler.scheduleRouter(3, 5, 0); // #9
        handler.scheduleResume(0); // #10
        handler.raiseEpoch(2, 0);
        handler.revokeObservation(1, 2, 0);
        handler.revokeObservation(1, 2, 261); // subject 1, a publisher, again: refused
        // A second before the timelock nothing executes.
        handler.executeWhenReady(0, 0);
        require(handler.earlyRefusals() == 1, "an early execution was not refused");
        handler.warp(4); // a day and a second later
        handler.executeChange(0, 0); // #0, stale
        handler.executeChange(4, 0); // #1
        handler.executeChange(4, 0); // #2, stale
        handler.executeChange(8, 0); // #3
        handler.executeChange(8, 0); // #4
        handler.executeChange(8, 0); // #5: the new guardian
        handler.executeChange(8, 0); // #6
        handler.executeChange(8, 0); // #7, stale
        require(handler.staleReadmissions() == 2 && handler.staleResumes() == 1, "a stale change executed");
        handler.executeChange(12, 0); // #8: subject 3 operates again
        handler.executeChange(12, 0); // #9: router 1 again
        handler.executeChange(12, 0); // #10: automation resumes
        require(handler.readmissions() == 2 && handler.resumes() == 1, "a fresh re-admission or resume failed");
        // Governance clears the void changes.
        for (uint256 i; i < 3; ++i) {
            handler.cancelChange(0, 9);
        }
        require(handler.liveChanges() == 0, "a change is still pending");
        // The new guardian vetoes a router admission, then front-runs a
        // resume by halting again and an admission by removing its subject.
        handler.scheduleRouter(5, 3, 0); // #11: router 2 at 2.1.2
        handler.cancelChange(0, 0);
        handler.halt(0);
        handler.warp(1);
        handler.scheduleResume(0); // #12
        handler.guardianFrontRuns(0, 1);
        handler.scheduleOperator(5, true, 0); // #13: subject 2
        handler.guardianFrontRuns(1, 1);
        handler.guardianFrontRuns(0, 0); // and cancels the void resume
        // Governance changes hands.
        handler.transferGovernance(0, 0);
        handler.acceptGovernance(0);
        handler.warp(5);
        handler.warp(6);
        _all();
        require(handler.executedOf(DominoV2Types.REGISTRY_OPERATOR) == 1, "operator change");
        require(handler.executedOf(DominoV2Types.REGISTRY_PUBLISHER) == 1, "publisher change");
        require(handler.executedOf(DominoV2Types.REGISTRY_ROUTER) == 1, "router change");
        require(handler.executedOf(DominoV2Types.REGISTRY_CHARGE_CURRENCY) == 1, "rank change");
        require(handler.executedOf(DominoV2Types.REGISTRY_FEE_RECIPIENT) == 1, "recipient change");
        require(handler.executedOf(DominoV2Types.REGISTRY_GUARDIAN) == 1, "guardian change");
        require(handler.executedOf(DominoV2Types.REGISTRY_TIMELOCK) == 1, "timelock change");
        require(handler.executedOf(DominoV2Types.REGISTRY_RESUME_AUTOMATION) == 1, "resume");
        require(handler.refusedSchedules() == 2 && handler.strangerRefusals() == 11, "refusals");
        require(handler.guardianCancels() >= 2 && handler.governanceCancels() == 3, "cancellations");
        require(handler.frontRuns() == 3, "front-runs");
        require(handler.handovers() == 1 && handler.revocations() == 1, "hand-over or revocation");
        require(handler.removals() == 3 && handler.epochRaises() == 1 && handler.halts() == 3, "narrowing");
        require(handler.warps() == 5 && handler.earlyRefusals() == 1, "time");
    }

    function _all() internal view {
        invariant_changesExecuteOnlyAsScheduledAfterTheirTimelock();
        invariant_readmissionFollowsTheDocumentedRules();
        invariant_operatorsAndPublishersStayDisjointAndRoutersRecent();
        invariant_theEpochOnlyGrowsAndTheAnchorFollowsIt();
        invariant_eachPartyDoesOnlyWhatTheDocsAllow();
        invariant_theHaltMovesOnlyThroughItsPaths();
        invariant_viewsAgreeWithTheModelAndTheEventLog();
    }


    function _require(bool ok, string memory why) internal pure {
        require(ok, why);
    }

    function invariant_changesExecuteOnlyAsScheduledAfterTheirTimelock() public view {
        require(handler.earlyExecutions() == 0, "a change executed before its timelock");
        require(handler.offScheduleEffects() == 0, "a change executed other than as scheduled");
        (bool ok, string memory why) = handler.pendingViewsAgree();
        _require(ok, why);
    }

    function invariant_readmissionFollowsTheDocumentedRules() public view {
        require(handler.readmissionBreaches() == 0, "a re-admission or resume broke the scheduled-after rule");
        (bool ok, string memory why) = handler.readmissionsFollowTheRule();
        _require(ok, why);
    }

    function invariant_operatorsAndPublishersStayDisjointAndRoutersRecent() public view {
        require(handler.rolesStayDisjoint(), "an operator publishes");
        require(handler.routersAreRecent(), "a router below 2.1.2 is admitted");
    }

    function invariant_theEpochOnlyGrowsAndTheAnchorFollowsIt() public view {
        require(handler.epochDrops() == 0 && handler.epochBounded(), "the epoch fell or passed the clock");
        (bool ok, string memory why) = handler.anchorAgrees();
        _require(ok, why);
    }

    function invariant_eachPartyDoesOnlyWhatTheDocsAllow() public view {
        require(handler.mismatches() == 0, "a call's outcome differs from the docs");
        require(handler.guardianWidenings() == 0, "the guardian widened trust");
        require(handler.untimedWidenings() == 0, "trust widened outside an executed change");
    }

    function invariant_theHaltMovesOnlyThroughItsPaths() public view {
        require(handler.haltBreaches() == 0, "the halt moved outside haltAutomation and a resume");
    }

    function invariant_viewsAgreeWithTheModelAndTheEventLog() public view {
        require(handler.eventBreaches() == 0, "an event disagrees with the change it reports");
        (bool ok, string memory why) = handler.viewsAgreeWithTheModel();
        _require(ok, why);
        (ok, why) = handler.viewsAgreeWithTheLog();
        _require(ok, why);
    }
}
