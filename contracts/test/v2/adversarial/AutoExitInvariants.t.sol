// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoAutoExit} from "../../../src/v2/interfaces/IDominoAutoExit.sol";
import {IDominoAutoExitExtension} from "../../../src/v2/interfaces/IDominoAutoExitExtension.sol";
import {IDominoFeeSettlement} from "../../../src/v2/interfaces/IDominoFees.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {DominoSwapFloor} from "../../../src/v2/route/DominoSwapFloor.sol";
import {GasBurner, MockToken, MockVault, NativeBouncer, NativeRefuser} from "../autoexit/AutoExitMocks.sol";
import {ScriptedRouter} from "../route/RouteAdversaries.sol";
import {AdvVm, AutoExitAdversarialWorld} from "./AutoExitAdversarialWorld.sol";

/// What one successful execution must satisfy, from what the handler saw
/// before and after it. Amounts are in the pool's currency order; `kept` and
/// `gifts` in the handler's token order (token0, token1, token2, native).
struct ExitRecord {
    uint8 mode;
    bool toToken1;
    bool listedTarget;
    uint8 rank0;
    uint8 rank1;
    uint16 slippage;
    uint160 below;
    uint160 above;
    uint160 anchorPrice;
    uint160 expectedPrice;
    uint160 spot;
    bool evidenceValid;
    bool authorized;
    bool recipientIsOwner;
    uint24 poolFee;
    uint256[2] withdrawn;
    uint256[2] minimum;
    uint256[2] fee;
    uint256[2] got;
    uint256[2] reported;
    int256[4] kept;
    uint256[4] gifts;
}

/// The rules of docs/v2/F4_AUTO_EXIT.md for one execution, as a pure judge;
/// a set bit names each rule broken. Kept apart from the handler for size.
contract ExitAuditor {
    uint256 public constant AUTH = 1; // not an operator, halted, not active, expired, disabled, owner changed, bad pool
    uint256 public constant TRIGGER = 2; // the anchor did not cross a trigger
    uint256 public constant EVIDENCE = 4; // the evidence was stale, unadmitted, too short, or not the anchor used
    uint256 public constant BAND = 8; // the spot stood outside the mandate's slippage of the anchor
    uint256 public constant CONSERVATION = 16; // withdrawn != delivered + fee (+ converted)
    uint256 public constant TARIFF = 32; // the fee broke F4's rule (20 bps, and where)
    uint256 public constant FLOOR = 64; // the conversion delivered under quote x (1 - fee) x (1 - slippage)
    uint256 public constant EVENT = 128; // MandateExecuted's amounts or recipient differ from the delivery
    uint256 public constant KEPT = 256; // the module kept something beyond debt, credits and gifts
    uint256 public constant MINIMUM = 512; // less arrived than the operator's removal minimums

    function audit(ExitRecord calldata r) external pure returns (uint256 broken) {
        if (!r.authorized) broken |= AUTH;
        if (!(r.anchorPrice <= r.below || (r.above != 0 && r.anchorPrice >= r.above))) broken |= TRIGGER;
        if (!r.evidenceValid || r.anchorPrice != r.expectedPrice) broken |= EVIDENCE;
        if (!_withinBand(r.anchorPrice, r.spot, r.slippage)) broken |= BAND;
        if (!r.recipientIsOwner || r.got[0] != r.reported[0] || r.got[1] != r.reported[1]) broken |= EVENT;
        for (uint256 i; i < 4; ++i) {
            if (r.kept[i] != int256(r.gifts[i])) broken |= KEPT;
        }
        if (r.withdrawn[0] < r.minimum[0] || r.withdrawn[1] < r.minimum[1]) broken |= MINIMUM;
        broken |= r.mode == DominoV2Types.RECEIVE_BOTH ? _both(r) : _converted(r);
    }

    /// Both tokens: everything withdrawn is delivered or charged, token by
    /// token; with no charge currency received, 20 bps of each; otherwise at
    /// most 20 bps of both valued at the anchor in the leading currency.
    function _both(ExitRecord calldata r) private pure returns (uint256) {
        if (r.got[0] + r.fee[0] != r.withdrawn[0] || r.got[1] + r.fee[1] != r.withdrawn[1]) return CONSERVATION;
        uint8 rank0 = r.withdrawn[0] == 0 ? 0 : r.rank0;
        uint8 rank1 = r.withdrawn[1] == 0 ? 0 : r.rank1;
        if (rank0 == 0 && rank1 == 0) {
            return r.fee[0] == r.withdrawn[0] * 20 / 10_000 && r.fee[1] == r.withdrawn[1] * 20 / 10_000 ? 0 : TARIFF;
        }
        bool leadIs0 = rank0 != 0 && (rank1 == 0 || rank0 <= rank1);
        (uint256 lead, uint256 other, uint256 leadFee, uint256 otherFee) =
            leadIs0 ? (r.withdrawn[0], r.withdrawn[1], r.fee[0], r.fee[1]) : (r.withdrawn[1], r.withdrawn[0], r.fee[1], r.fee[0]);
        // The other token into the lead's units: token0 -> token1 is zeroForOne.
        bool otherIsToken0 = !leadIs0;
        uint256 due = (lead + DominoSwapFloor.quote(other, r.anchorPrice, otherIsToken0)) * 20 / 10_000;
        return leadFee + DominoSwapFloor.quote(otherFee, r.anchorPrice, otherIsToken0) <= due ? 0 : TARIFF;
    }

    /// One token: the source is all converted; the fee is 20 bps of the output
    /// in a charge currency, or of each token withdrawn before the conversion
    /// otherwise; the conversion meets the floor at the anchor.
    function _converted(ExitRecord calldata r) private pure returns (uint256) {
        (uint256 ws, uint256 wt, uint256 fs, uint256 ft, uint256 gs, uint256 gt) = r.toToken1
            ? (r.withdrawn[0], r.withdrawn[1], r.fee[0], r.fee[1], r.got[0], r.got[1])
            : (r.withdrawn[1], r.withdrawn[0], r.fee[1], r.fee[0], r.got[1], r.got[0]);
        if (gs != 0) return CONSERVATION;
        uint256 sold;
        uint256 converted;
        if (r.listedTarget) {
            if (fs != 0 || ft != (gt + ft) * 20 / 10_000) return TARIFF;
            if (gt + ft < wt) return CONSERVATION;
            sold = ws;
            converted = gt + ft - wt;
        } else {
            if (fs != ws * 20 / 10_000 || ft != wt * 20 / 10_000) return TARIFF;
            if (gt + ft < wt) return CONSERVATION;
            sold = ws - fs;
            converted = gt + ft - wt;
        }
        if (sold != 0 && converted < DominoSwapFloor.minimumOutput(sold, r.anchorPrice, r.toToken1, r.poolFee, r.slippage)) {
            return FLOOR;
        }
        return 0;
    }

    function _withinBand(uint160 a, uint160 b, uint16 bps) private pure returns (bool) {
        if (a == 0 || b == 0) return false;
        (uint256 high, uint256 low) = a > b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        (uint256 highHi, uint256 highLo) = _mul512(high, high * 10_000);
        (uint256 lowHi, uint256 lowLo) = _mul512(low, low * (10_000 + uint256(bps)));
        return highHi < lowHi || (highHi == lowHi && highLo <= lowLo);
    }

    function _mul512(uint256 x, uint256 y) private pure returns (uint256 hi, uint256 lo) {
        assembly ("memory-safe") {
            let mm := mulmod(x, y, not(0))
            lo := mul(x, y)
            hi := sub(sub(mm, lo), lt(mm, lo))
        }
    }
}

/// Everyone who can touch the auto-exit module, driven by the fuzzer, on
/// AutoExitAdversarialWorld (Base's Uniswap; the real registry, anchor and
/// module; F4's vault double; a vault no factory made):
/// - owners (three EOAs, an EIP-1271 wallet, an attacker with its own vault)
///   registering mandates through EIP-712 signatures, valid or not, revoking
///   them and cancelling nonces;
/// - the operator executing any mandate, active or not, with its own choice
///   of evidence (fresh, noisy, stale, future-dated, unadmitted, another
///   pool's, replayed, garbage, a TWAP of any window) and conversion legs
///   (honest or at the floor through the scripted router, v3 and v4 pool
///   legs, a hostile script, misshapen legs, split routes) and removal
///   minimums; mostly at its moment (trigger crossed, position held), and
///   with probes that put one adverse condition in place each (a spent or
///   expired mandate, the vault's owner changed, the module off); strangers
///   trying the same;
/// - traders moving the three pools; time warps past expiries;
/// - owners going dark per token (frozen, false-returning, lying,
///   over-debiting; native refusers, gas burners, bouncers) and claiming
///   deferred deliveries to recipients that may refuse them;
/// - the fee recipient going dark per token, governance moving it, flushes;
/// - the guardian halting, removing the operator or a publisher, raising the
///   observation epoch, revoking observations; governance resuming,
///   re-admitting and rotating publishers through the timelock;
/// - vaults misbehaving (withholding, calling back, changing owner or pool),
///   the hostile vault paying, gifting, pulling and calling back at will;
/// - donations.
/// What can only be seen inside one call (a successful execution that broke
/// a rule, a refusal that should not have been, a claim or flush that moved
/// other than exactly) is counted as a breach; the invariants require none.
contract AutoExitHandler is AutoExitAdversarialWorld {
    uint256 internal constant MAX_TRACKED = 128;
    uint256 internal constant NONCES = 64;
    address internal constant FEE_RECIPIENT_2 = address(0xFEE2);
    uint8 internal constant ACTIVE = 1;
    uint8 internal constant REVOKED = 2;
    uint8 internal constant EXECUTED = 3;

    struct Tracked {
        bytes32 id;
        uint8 vault;
        uint8 status;
        uint8 mode;
        uint16 slippage;
        uint64 validUntil;
        uint256 nonce;
        address owner;
        address convertTo;
        uint160 below;
        uint160 above;
    }

    struct Attempt {
        bytes32 id;
        uint256 index;
        address caller;
        address vault;
        DominoV2Types.PoolRef pool;
        bool poolOk;
        uint160 spot;
        bool authorized;
        bytes evidence;
        bool evidenceValid;
        uint160 expectedPrice;
        uint8 evidenceKind;
        uint256[2] withdrawn;
        uint256[2] reported;
        uint256[4] gifts;
        DominoV2Types.SwapLeg[] legs;
        uint8 legKind;
        uint128 min0;
        uint128 min1;
    }

    struct Snapshot {
        uint256[4] module;
        uint256[4] owed;
        uint256[4] credits;
        uint256[4] ownerCredit;
        uint256[4] ownerBalance;
        uint256[4] recipients;
    }

    event Breach(string what);

    ExitAuditor public auditor;
    NativeRefuser internal refuser;
    Tracked[] internal tracked;
    DominoV2Types.PriceObservation[] internal signedPoints;
    uint256[] internal signedKeys;
    mapping(bytes32 => bool) internal known;
    mapping(address => mapping(uint256 => bool)) public nonceModel;
    mapping(address => uint256) internal keyOf;
    mapping(uint256 => address) internal addressOfKey;
    uint256[] internal publisherKeys;
    uint256[4] public gifts;
    /// Every (owner, nonce) a registration or a cancellation touched.
    address[] internal touchedOwners;
    uint256[] internal touchedNonces;
    mapping(bytes32 => uint256) public breaches;
    mapping(bytes32 => uint256) public successes;
    /// Refused executions by their revert selector, for the walk's report.
    mapping(bytes4 => uint256) public refusals;
    bytes4[] internal refusalKinds;
    uint256 public totalBreaches;

    constructor() {
        _buildWorld();
        auditor = new ExitAuditor();
        refuser = new NativeRefuser();
        address[5] memory owners = [ownerA, ownerB, ownerC, address(wallet), attacker];
        uint256[5] memory keys = [OWNER_A_KEY, OWNER_B_KEY, OWNER_C_KEY, WALLET_SIGNER_KEY, ATTACKER_KEY];
        for (uint256 i; i < 5; ++i) {
            keyOf[owners[i]] = keys[i];
            addressOfKey[keys[i]] = vm.addr(keys[i]);
        }
        publisherKeys.push(PUBLISHER_KEY);
        addressOfKey[PUBLISHER_KEY] = vm.addr(PUBLISHER_KEY);
        addressOfKey[OUTSIDER_KEY] = vm.addr(OUTSIDER_KEY);
        // The hostile vault starts by paying like an honest one.
        hostile.setPayments(HELD0, HELD1, HELD0, HELD1);
        token0.mint(address(hostile), HELD0);
        token1.mint(address(hostile), HELD1);
    }

    receive() external payable {}

    // ============================================================== ghosts

    /// Owed fees fall only by a flush; a credit only by its owner's claim.
    modifier observed(bool flushing, bool claiming) {
        uint256[24] memory before;
        for (uint256 i; i < 4; ++i) {
            before[i] = autoExit.owedFees(_tokenAt(i));
            for (uint256 o; o < 5; ++o) {
                before[4 + o * 4 + i] = autoExit.unclaimed(_ownerAt(o), _tokenAt(i));
            }
        }
        _;
        for (uint256 i; i < 4; ++i) {
            if (!flushing && autoExit.owedFees(_tokenAt(i)) < before[i]) _breach("owed fees fell without a flush");
            for (uint256 o; o < 5; ++o) {
                if (!claiming && autoExit.unclaimed(_ownerAt(o), _tokenAt(i)) < before[4 + o * 4 + i]) {
                    _breach("a credit fell without a claim");
                }
            }
        }
    }

    function _breach(string memory what) internal {
        breaches[keccak256(bytes(what))] += 1;
        ++totalBreaches;
        emit Breach(what);
    }

    function _bump(string memory what) internal {
        successes[keccak256(bytes(what))] += 1;
    }

    /// `bits` bits of `seed` from `shift`: each choice reads its own field, so a
    /// scripted call sets one without disturbing the others.
    function _field(uint256 seed, uint256 shift, uint256 bits) internal pure returns (uint256) {
        return (seed >> shift) & ((1 << bits) - 1);
    }

    function success(string calldata what) external view returns (uint256) {
        return successes[keccak256(bytes(what))];
    }

    function breach(string calldata what) external view returns (uint256) {
        return breaches[keccak256(bytes(what))];
    }

    function _tokenAt(uint256 i) internal view returns (address) {
        return i == 0 ? address(token0) : i == 1 ? address(token1) : i == 2 ? address(token2) : address(0);
    }

    function _index(address token) internal view returns (uint256) {
        return token == address(token0) ? 0 : token == address(token1) ? 1 : token == address(token2) ? 2 : 3;
    }

    function _ownerAt(uint256 i) internal view returns (address) {
        return i == 0 ? ownerA : i == 1 ? ownerB : i == 2 ? ownerC : i == 3 ? address(wallet) : attacker;
    }

    /// The vault table: index, the vault, the owner it was made for and that owner's key.
    function _vaultAt(uint256 i) internal view returns (address vault, address owner, uint256 key) {
        i %= 5;
        if (i == 0) return (address(vaultA), ownerA, OWNER_A_KEY);
        if (i == 1) return (address(vaultB), ownerB, OWNER_B_KEY);
        if (i == 2) return (address(vaultC), ownerC, OWNER_C_KEY);
        if (i == 3) return (address(vaultW), address(wallet), WALLET_SIGNER_KEY);
        return (address(hostile), attacker, ATTACKER_KEY);
    }

    /// A call made as `account`: through its own run() for the EIP-1271 wallet.
    function _callAs(address account, bytes memory data, uint256 gasLimit) internal returns (bool ok, bytes memory out) {
        if (account == address(wallet)) {
            try wallet.run{gas: gasLimit}(address(autoExit), data) returns (bytes memory result) {
                return (true, result);
            } catch (bytes memory reason) {
                return (false, reason);
            }
        }
        vm.prank(account);
        (ok, out) = address(autoExit).call{gas: gasLimit}(data);
    }

    function _currentPublisher() internal view returns (uint256) {
        return publisherKeys[publisherKeys.length - 1];
    }

    // ========================================================== mandates

    /// A mandate on any vault, for its owner or not, signed by the right key or
    /// not, with any shape of terms; the expected refusal follows the
    /// module's order (registered, terms, nonce, signature, vault owner).
    function register(uint256 vaultSeed, uint256 shapeSeed, uint256 modeSeed, uint256 termsSeed)
        external
        observed(false, false)
    {
        if (tracked.length >= MAX_TRACKED) return;
        (address vault, address owner, uint256 key) = _vaultAt(vaultSeed);
        (DominoV2Types.PoolRef memory ref, bool poolOk) = _poolOf(vault);
        uint160 spot = poolOk ? _spotOr(ref) : PRICE_ONE;
        DominoV2Types.ExitMandate memory m;
        (m.owner, m.vault, m.tokenId) = (owner, vault, TOKEN_ID);
        _shape(m, spot, shapeSeed);
        _modeOf(m, ref, modeSeed);
        uint256 slip = _field(termsSeed, 0, 8) % 20;
        m.maxSlippageBps = slip == 0 ? 0 : slip == 1 ? 1001 : uint16(1 + _field(termsSeed, 8, 16) % 1000);
        // A validity already past, one of at most an hour, or up to 30 days.
        uint256 validity = _field(termsSeed, 24, 8) % 10;
        m.validUntil = validity == 0
            ? uint64(clock - 1)
            : validity < 3
                ? uint64(clock + 1 + _field(termsSeed, 32, 32) % 1 hours)
                : uint64(clock + _field(termsSeed, 32, 32) % 30 days);
        m.nonce = _field(termsSeed, 64, 8) % NONCES;
        uint256 who = _field(termsSeed, 72, 8) % 10;
        uint256 signer = key;
        if (who == 0) {
            // Another owner signs for itself a mandate on a vault it does not own.
            (,, uint256 otherKey) = _vaultAt(vaultSeed % 5 + 1 + _field(termsSeed, 80, 8) % 4);
            m.owner = otherKey == WALLET_SIGNER_KEY ? address(wallet) : addressOfKey[otherKey];
            signer = otherKey;
        } else if (who == 1) {
            signer = OUTSIDER_KEY;
        }
        bytes4 expected = _expectedRegistration(m, signer);
        bytes memory signature = _sign(m, signer);
        _touch(m.owner, m.nonce);
        vm.prank(_field(termsSeed, 88, 8) % 2 == 0 ? STRANGER : m.owner);
        try autoExit.registerMandate(m, signature) returns (bytes32 id) {
            if (expected != bytes4(0) || id != DominoV2Types.hashExitMandate(m)) _breach("a registration the rules refuse");
            _track(id, vaultSeed % 5, m);
            nonceModel[m.owner][m.nonce] = true;
            _bump("registrations");
        } catch (bytes memory reason) {
            if (expected == bytes4(0) || reason.length < 4 || bytes4(reason) != expected) {
                _breach("a registration refused other than the rules say");
            }
        }
    }

    function _shape(DominoV2Types.ExitMandate memory m, uint160 spot, uint256 seed) internal pure {
        uint160 below = _scaled(spot, 10_000 - _field(seed, 8, 16) % 1300);
        uint160 above = _scaled(spot, 10_000 + _field(seed, 24, 16) % 1300);
        uint256 shape = _field(seed, 0, 8) % 8;
        if (shape < 3) {
            m.triggerBelowSqrtPriceX96 = below;
        } else if (shape < 5) {
            m.triggerAboveSqrtPriceX96 = above;
        } else if (shape < 7) {
            (m.triggerBelowSqrtPriceX96, m.triggerAboveSqrtPriceX96) = (below, above);
        } else if (_field(seed, 40, 8) % 2 == 1) {
            (m.triggerBelowSqrtPriceX96, m.triggerAboveSqrtPriceX96) = (above, below);
        }
    }

    function _modeOf(DominoV2Types.ExitMandate memory m, DominoV2Types.PoolRef memory ref, uint256 seed)
        internal
        view
    {
        uint256 mode = _field(seed, 0, 8) % 6;
        uint256 choice = _field(seed, 8, 8);
        if (mode < 3) return;
        m.receiveMode = DominoV2Types.RECEIVE_CONVERTED;
        if (mode < 5) {
            m.convertTo = choice % 2 == 0 ? ref.currency0 : ref.currency1;
        } else if (choice % 3 == 0) {
            m.convertTo = address(token2);
        } else if (choice % 3 == 1) {
            (m.receiveMode, m.convertTo) = (DominoV2Types.RECEIVE_BOTH, ref.currency1);
        } else {
            m.receiveMode = 2;
        }
    }

    function _expectedRegistration(DominoV2Types.ExitMandate memory m, uint256 signer) internal view returns (bytes4) {
        if (known[DominoV2Types.hashExitMandate(m)]) return IDominoAutoExitExtension.MandateAlreadyRegistered.selector;
        if (!_termsValid(m)) return IDominoAutoExit.InvalidMandate.selector;
        if (nonceModel[m.owner][m.nonce]) return IDominoAutoExitExtension.NonceAlreadyUsed.selector;
        if (keyOf[m.owner] != signer) return IDominoAutoExitExtension.InvalidSignature.selector;
        if (IDominoVault(m.vault).owner() != m.owner) return IDominoAutoExit.Unauthorized.selector;
        return bytes4(0);
    }

    function _termsValid(DominoV2Types.ExitMandate memory m) internal view returns (bool) {
        uint160 below = m.triggerBelowSqrtPriceX96;
        uint160 above = m.triggerAboveSqrtPriceX96;
        if (m.validUntil < clock || (above == 0 ? below == 0 : below >= above)) return false;
        if (m.maxSlippageBps == 0 || m.maxSlippageBps > 1000) return false;
        if (m.receiveMode == DominoV2Types.RECEIVE_BOTH) return m.convertTo == address(0);
        if (m.receiveMode != DominoV2Types.RECEIVE_CONVERTED) return false;
        (DominoV2Types.PoolRef memory ref,) = _poolOf(m.vault);
        return m.convertTo == ref.currency0 || m.convertTo == ref.currency1;
    }

    function _touch(address owner, uint256 nonce) internal {
        if (touchedOwners.length < 256) {
            touchedOwners.push(owner);
            touchedNonces.push(nonce);
        }
    }

    function _track(bytes32 id, uint256 vault, DominoV2Types.ExitMandate memory m) internal {
        known[id] = true;
        tracked.push(
            Tracked({
                id: id,
                vault: uint8(vault),
                status: ACTIVE,
                mode: m.receiveMode,
                slippage: m.maxSlippageBps,
                validUntil: m.validUntil,
                nonce: m.nonce,
                owner: m.owner,
                convertTo: m.convertTo,
                below: m.triggerBelowSqrtPriceX96,
                above: m.triggerAboveSqrtPriceX96
            })
        );
    }

    /// The owner, or a stranger, revokes a tracked mandate.
    function revoke(uint256 pick, uint256 callerSeed) external observed(false, false) {
        if (tracked.length == 0) return;
        Tracked storage t = tracked[pick % tracked.length];
        address caller = callerSeed % 2 == 0 ? STRANGER : t.owner;
        bool expected = caller == t.owner && t.status == ACTIVE;
        (bool ok,) = _callAs(caller, abi.encodeCall(IDominoAutoExit.revokeMandate, (t.id)), 1_000_000);
        if (ok != expected) _breach("a revocation the rules do not allow, or one refused");
        if (ok) {
            t.status = REVOKED;
            _bump("revocations");
        }
    }

    function cancelNonce(uint256 ownerSeed, uint256 nonceSeed) external observed(false, false) {
        address owner = _ownerAt(ownerSeed % 5);
        uint256 nonce = nonceSeed % NONCES;
        bool expected = !nonceModel[owner][nonce];
        _touch(owner, nonce);
        (bool ok,) = _callAs(owner, abi.encodeCall(IDominoAutoExitExtension.cancelNonce, (nonce)), 1_000_000);
        if (ok != expected) _breach("a nonce used twice, or a fresh one refused");
        if (ok) {
            nonceModel[owner][nonce] = true;
            _bump("cancellations");
        }
    }

    // ========================================================= execution

    /// The operator (or a stranger) executes a tracked mandate with evidence,
    /// legs and minimums of its choosing. Mostly the operator is patient: it
    /// takes an active mandate and waits for its moment (the vault holds a
    /// position, the market stands just past the trigger, a TWAP has had its
    /// window). Some attempts probe one guard each, with everything else in
    /// place: a mandate that is revoked, spent or expired; the moment, then a
    /// warp past the mandate's validUntil; the vault's owner changed for the
    /// attempt; the module switched off for it. Others try any mandate as
    /// things stand. A success must keep every rule (ExitAuditor); a refusal
    /// changes nothing by construction.
    function execute(uint256 pick, uint256 evidenceSeed, uint256 legSeed, uint256 callerSeed)
        external
        observed(false, false)
    {
        if (tracked.length == 0) return;
        Attempt memory a;
        a.index = pick % tracked.length;
        // 0 as things stand; 1 a mandate that cannot execute; 2 expired by a
        // warp; 3 the vault's owner changed; 4 the module off; else patient.
        uint256 probe = _field(callerSeed, 24, 8) % 16;
        if (probe == 1) a.index = _nextSpent(a.index);
        else if (probe != 0) a.index = _nextActive(a.index);
        Tracked memory t = tracked[a.index];
        a.id = t.id;
        a.caller = _field(callerSeed, 0, 8) % 12 == 0
            ? (_field(callerSeed, 16, 8) % 2 == 0 ? t.owner : STRANGER)
            : OPERATOR;
        (a.vault,,) = _vaultAt(t.vault);
        if (probe != 0) _prepare(t, a.vault, evidenceSeed);
        address restore = _probe(probe, t, a.vault);
        _attempt(a, t, evidenceSeed, legSeed, callerSeed);
        _unprobe(probe, a.vault, restore);
    }

    function _attempt(Attempt memory a, Tracked memory t, uint256 evidenceSeed, uint256 legSeed, uint256 callerSeed)
        internal
    {
        _readVault(a, t);
        _evidence(a, evidenceSeed);
        _payout(a);
        _legsFor(a, t, legSeed);
        // Removal minimums on what the vault reports: a vault withholding part
        // of it must meet the module's own measurement (BelowMinimum).
        uint256 minimums = _field(callerSeed, 8, 8) % 10;
        if (minimums == 8) (a.min0, a.min1) = (uint128(a.reported[0]), uint128(a.reported[1]));
        if (minimums == 9) a.min0 = uint128(a.reported[0] + 1);
        Snapshot memory before = _snapshot(t.owner);
        IDominoAutoExit.Execution memory execution;
        (execution.anchorEvidence, execution.legs, execution.amount0MinRemoved, execution.amount1MinRemoved) =
            (a.evidence, a.legs, a.min0, a.min1);
        vm.recordLogs();
        vm.prank(a.caller);
        try autoExit.execute{gas: 20_000_000}(a.id, execution) returns (uint256, uint256) {
            _afterSuccess(a, t, before);
        } catch (bytes memory reason) {
            vm.getRecordedLogs();
            bytes4 kind = reason.length >= 4 ? bytes4(reason) : bytes4(0);
            if (refusals[kind] == 0) refusalKinds.push(kind);
            refusals[kind] += 1;
            _bump("refused executions");
        }
    }

    /// Puts one adverse condition in place for the attempt; returns what to restore.
    function _probe(uint256 probe, Tracked memory t, address vault) internal returns (address restore) {
        if (probe == 2) {
            if (t.validUntil >= clock && t.validUntil - clock <= 3 days) _advance(t.validUntil - clock + 1);
        } else if (probe == 3) {
            restore = IDominoVault(vault).owner();
            if (vault == address(hostile)) hostile.setOwner(restore == attacker ? ownerB : attacker);
            else MockVault(payable(vault)).setOwner(STRANGER);
        } else if (probe == 4) {
            restore = IDominoVault(vault).exitModule();
            _switchModule(vault, address(0));
        }
    }

    function _unprobe(uint256 probe, address vault, address restore) internal {
        if (probe == 3) {
            if (vault == address(hostile)) hostile.setOwner(restore);
            else MockVault(payable(vault)).setOwner(restore);
        } else if (probe == 4) {
            _switchModule(vault, restore);
        }
    }

    /// The vault's current owner switches its module (the wallet through run()).
    function _switchModule(address vault, address module) internal {
        address current = IDominoVault(vault).owner();
        if (current == address(wallet)) {
            wallet.run(vault, abi.encodeCall(MockVault.setExitModule, (module)));
        } else if (vault == address(hostile)) {
            vm.prank(current);
            hostile.setExitModule(module);
        } else {
            vm.prank(current);
            MockVault(payable(vault)).setExitModule(module);
        }
    }

    /// A mandate that cannot execute: revoked, spent or expired; else `from`.
    function _nextSpent(uint256 from) internal view returns (uint256) {
        for (uint256 k; k < tracked.length; ++k) {
            uint256 i = (from + k) % tracked.length;
            if (tracked[i].status != ACTIVE || clock > tracked[i].validUntil) return i;
        }
        return from;
    }

    function _nextActive(uint256 from) internal view returns (uint256) {
        for (uint256 k; k < tracked.length; ++k) {
            uint256 i = (from + k) % tracked.length;
            if (tracked[i].status == ACTIVE && clock <= tracked[i].validUntil) return i;
        }
        return from;
    }

    /// The moment a patient operator waits for: the vault holds what it will
    /// pay, the market stands just past a trigger (a real swap on the vault's
    /// pool), and a TWAP's window has elapsed since.
    function _prepare(Tracked memory t, address vault, uint256 evidenceSeed) internal {
        (DominoV2Types.PoolRef memory ref, bool ok) = _poolOf(vault);
        if (!ok || !(_samePool(ref, p3) || _samePool(ref, p4) || _samePool(ref, pn))) return;
        if (vault == address(hostile)) {
            _fund(ref.currency0, vault, hostile.pay0());
            _fund(ref.currency1, vault, hostile.pay1());
            _fund(address(0), vault, hostile.giftNative());
            token2.mint(vault, hostile.giftAmount());
        } else {
            MockVault mock = MockVault(payable(vault));
            (, uint256 held0, uint256 held1) = mock.held(TOKEN_ID);
            if (held0 + held1 == 0) {
                mock.setWithhold(0, 0);
                _refill(mock, TOKEN_ID, 1e15 + evidenceSeed % 1e21, 1e15 + (evidenceSeed >> 128) % 1e21);
            }
        }
        uint160 spot = _spot(ref);
        uint256 nudge = _field(evidenceSeed, 48, 8) % 50;
        if (t.below != 0 && spot > t.below) _moveTo(ref, _scaled(t.below, 10_000 - nudge));
        else if (t.below == 0 && t.above != 0 && spot < t.above) _moveTo(ref, _scaled(t.above, 10_000 + nudge));
        if (_isTwap(evidenceSeed, ref)) _advance(_window(evidenceSeed >> 8));
    }

    /// An id never registered never executes.
    function executeUnknown(uint256 seed) external observed(false, false) {
        bytes32 id = keccak256(abi.encode("unknown", seed));
        if (known[id]) return;
        IDominoAutoExit.Execution memory execution;
        execution.anchorEvidence = _fresh(p4, _spot(p4));
        vm.prank(OPERATOR);
        try autoExit.execute{gas: 5_000_000}(id, execution) {
            _breach("an unknown mandate executed");
        } catch {}
    }

    function _poolOf(address vault) internal view returns (DominoV2Types.PoolRef memory ref, bool ok) {
        try IDominoVault(vault).pool() returns (DominoV2Types.PoolRef memory read) {
            (ref, ok) = (read, true);
        } catch {}
    }

    function _spotOr(DominoV2Types.PoolRef memory ref) internal view returns (uint160 spot) {
        try anchor.spotSqrtPrice(ref) returns (uint160 read) {
            spot = read;
        } catch {
            spot = PRICE_ONE;
        }
    }

    /// The pool, the spot and whether everything _authorize checks holds.
    function _readVault(Attempt memory a, Tracked memory t) internal view {
        (a.pool, a.poolOk) = _poolOf(a.vault);
        if (a.poolOk) {
            try anchor.spotSqrtPrice(a.pool) returns (uint160 read) {
                a.spot = read;
            } catch {}
        }
        bool poolFits = a.poolOk && a.pool.currency0 < a.pool.currency1
            && (t.mode == DominoV2Types.RECEIVE_BOTH || t.convertTo == a.pool.currency0 || t.convertTo == a.pool.currency1);
        a.authorized = registry.isOperator(a.caller) && !registry.automationHalted() && t.status == ACTIVE
            && clock <= t.validUntil && IDominoVault(a.vault).exitModule() == address(autoExit)
            && IDominoVault(a.vault).owner() == t.owner && poolFits;
    }

    /// Whether the operator's evidence is a TWAP: five draws in sixteen on a
    /// v3 pool, two on a v4 pool (where the anchor refuses it).
    function _isTwap(uint256 seed, DominoV2Types.PoolRef memory ref) internal pure returns (bool) {
        return _field(seed, 0, 8) % 16 < (ref.dex == DominoV2Types.DEX_V3 ? 5 : 2);
    }

    /// The operator's evidence: a TWAP of any window (see _isTwap), or by the
    /// draw: 5 garbage, 6 stale (expired, over-long or future), 7 an unadmitted
    /// key, 8 another pool's, 9 a replay, any other fresh by the newest
    /// publisher, with noise on the price.
    function _evidence(Attempt memory a, uint256 seed) internal {
        uint256 kind = _field(seed, 0, 8) % 16;
        if (!a.poolOk || kind == 5) {
            (a.evidence, a.evidenceKind) = (abi.encode(seed, seed >> 1), 3);
            return;
        }
        if (_isTwap(seed, a.pool)) {
            uint32 window = _window(seed >> 8);
            (a.evidence, a.evidenceKind) = (abi.encode(window), 2);
            if (a.pool.dex == DominoV2Types.DEX_V3 && window >= MIN_TWAP && window <= MAX_TWAP) {
                try anchor.twapSqrtPrice(a.pool, window) returns (uint160 price) {
                    (a.expectedPrice, a.evidenceValid) = (price, true);
                } catch {}
            }
            return;
        }
        DominoV2Types.PriceObservation memory point;
        uint256 key;
        if (kind == 9 && signedKeys.length != 0) {
            uint256 i = _field(seed, 8, 8) % signedKeys.length;
            (point, key) = (signedPoints[i], signedKeys[i]);
        } else {
            uint256 observedAt = clock - _field(seed, 8, 8) % 120;
            point = _point(a.pool, _noisy(a.spot, seed >> 16), observedAt, observedAt + MAX_AGE - _field(seed, 32, 8) % 60);
            key = _currentPublisher();
            if (kind == 6) {
                uint256 how = _field(seed, 40, 8) % 3;
                if (how == 0) (point.observedAt, point.validUntil) = (uint64(clock - 400), uint64(clock - 100));
                else if (how == 1) point.validUntil = point.observedAt + MAX_AGE + 1;
                else (point.observedAt, point.validUntil) = (uint64(clock + 5), uint64(clock + 5 + MAX_AGE));
            } else if (kind == 7) {
                key = _field(seed, 40, 8) % 2 == 0 ? OUTSIDER_KEY : publisherKeys[0];
            } else if (kind == 8) {
                point.pool = _samePool(a.pool, p4) ? pn : p4;
            }
            _remember(point, key);
        }
        (a.evidence, a.evidenceKind, a.expectedPrice) = (_signed(key, point), 1, point.sqrtPriceX96);
        a.evidenceValid = registry.isPublisher(addressOfKey[key]) && point.observedAt >= registry.observationEpoch()
            && point.observedAt <= clock && clock <= point.validUntil && point.validUntil >= point.observedAt
            && point.validUntil - point.observedAt <= MAX_AGE && _samePool(point.pool, a.pool)
            && !anchor.isRevoked(anchor.hashObservation(point));
    }

    /// The operator's window: the module's two bounds and one second past each
    /// (the 600 s floor, the hour's ceiling), three draws in eight of any
    /// window up to the hour, one of any up to two days.
    function _window(uint256 seed) internal pure returns (uint32) {
        uint256 pick = _field(seed, 0, 8) % 8;
        if (pick == 0) return MIN_TWAP - 1;
        if (pick == 1) return MIN_TWAP;
        if (pick == 2) return MAX_TWAP;
        if (pick == 3) return MAX_TWAP + 1;
        if (pick < 7) return uint32(1 + _field(seed, 8, 32) % MAX_TWAP);
        return uint32(1 + _field(seed, 8, 32) % 2 days);
    }

    function _noisy(uint160 spot, uint256 seed) internal pure returns (uint160) {
        uint256 pick = _field(seed, 0, 8) % 8;
        if (pick < 6) return spot;
        uint256 spread = pick == 6 ? 300 : 1500;
        uint256 offset = _field(seed, 8, 16) % spread;
        return _scaled(spot, _field(seed, 24, 8) % 2 == 0 ? 10_000 + offset : 10_000 - offset);
    }

    function _samePool(DominoV2Types.PoolRef memory a, DominoV2Types.PoolRef memory b) internal pure returns (bool) {
        return keccak256(abi.encode(a)) == keccak256(abi.encode(b));
    }

    function _remember(DominoV2Types.PriceObservation memory point, uint256 key) internal {
        if (signedKeys.length < 16) {
            signedPoints.push(point);
            signedKeys.push(key);
        } else {
            uint256 slot = uint256(keccak256(abi.encode(point))) % 16;
            signedPoints[slot] = point;
            signedKeys[slot] = key;
        }
    }

    /// What the vault will hand the module: its position less what it
    /// withholds; for the hostile vault, what it pays, and its gifts.
    function _payout(Attempt memory a) internal view {
        if (!a.poolOk) return;
        if (a.vault == address(hostile)) {
            (a.withdrawn[0], a.withdrawn[1]) = (hostile.pay0(), hostile.pay1());
            a.reported = [a.withdrawn[0], a.withdrawn[1]];
            uint256 native = hostile.giftNative();
            if (a.pool.currency0 == address(0)) a.withdrawn[0] += native;
            else a.gifts[3] += native;
            if (hostile.giftAmount() != 0) a.gifts[_index(hostile.giftToken())] += hostile.giftAmount();
            return;
        }
        MockVault vault = MockVault(payable(a.vault));
        (, uint256 held0, uint256 held1) = vault.held(TOKEN_ID);
        a.reported = [held0, held1];
        (uint256 kept0, uint256 kept1) = (vault.withhold0(), vault.withhold1());
        // More withheld than held makes the double revert: nothing arrives.
        (a.withdrawn[0], a.withdrawn[1]) = (held0 >= kept0 ? held0 - kept0 : 0, held1 >= kept1 ? held1 - kept1 : 0);
    }

    /// Legs for a conversion: 0-1 an honest router price, 2 exactly the floor,
    /// 3 a v4 pool leg on the remainder, 4 a v3 pool leg on the remainder, 5 a
    /// hostile script, 6 misshapen legs (one unit more or less than the
    /// source, the wrong token in or out, a router leg of zero), 7 a split route. A mandate receiving
    /// both tokens sometimes gets a stray leg.
    function _legsFor(Attempt memory a, Tracked memory t, uint256 seed) internal {
        if (!a.poolOk) return;
        if (t.mode != DominoV2Types.RECEIVE_CONVERTED) {
            if (_field(seed, 0, 8) % 10 == 9) a.legs = _legs(_routerLeg(a.pool.currency0, a.pool.currency1, 1, 1));
            return;
        }
        bool toToken1 = t.convertTo == a.pool.currency1;
        (address source, address target) = toToken1 ? (a.pool.currency0, a.pool.currency1) : (a.pool.currency1, a.pool.currency0);
        uint256 withdrawn = toToken1 ? a.withdrawn[0] : a.withdrawn[1];
        uint256 sold = registry.chargeCurrencyRank(target) != 0 ? withdrawn : withdrawn - withdrawn * 20 / 10_000;
        if (sold == 0 || target != t.convertTo) return;
        uint160 price = a.expectedPrice != 0 ? a.expectedPrice : a.spot != 0 ? a.spot : PRICE_ONE;
        uint256 fair = DominoSwapFloor.quote(sold, price, toToken1);
        a.legKind = uint8(_field(seed, 0, 8) % 8);
        if (a.legKind < 2) {
            a.legs = _legs(_routerLeg(source, target, sold, fair * (9000 + _field(seed, 8, 16) % 1600) / 10_000 + 1));
        } else if (a.legKind == 2) {
            uint256 floor = DominoSwapFloor.minimumOutput(sold, price, toToken1, _poolFee(a.pool, toToken1), t.slippage);
            a.legs = _legs(_routerLeg(source, target, sold, floor == 0 ? 1 : floor));
        } else if (a.legKind == 3) {
            a.legs = _legs(_v4Leg(source, target, 0, source == address(0) || target == address(0) ? pn : p4));
        } else if (a.legKind == 4 && source != address(0) && target != address(0)) {
            a.legs = _legs(_v3Leg(source, target, 0, 500));
        } else if (a.legKind == 5) {
            a.legs = _legs(_hostileLeg(a, source, target, sold, fair + 1, seed >> 8));
        } else if (a.legKind == 6) {
            a.legs = _legs(_misshapen(source, target, sold, fair + 1, seed >> 8));
        } else {
            DominoV2Types.SwapLeg[] memory split = new DominoV2Types.SwapLeg[](2);
            split[0] = _routerLeg(source, target, sold / 2, fair / 2 + 1);
            split[1] = _routerLeg(source, target, sold - sold / 2, fair - fair / 2 + 1);
            a.legs = split;
        }
    }

    /// The vault pool's fee for a direction, capped as the module caps it.
    function _poolFee(DominoV2Types.PoolRef memory ref, bool zeroForOne) internal view returns (uint24 fee) {
        if (ref.dex == DominoV2Types.DEX_V4) (, fee) = DominoSwapFloor.v4SpotAndFee(chain.v4PoolManager, ref, zeroForOne);
        else fee = ref.fee;
        if (fee > 100_000) fee = 100_000;
    }

    /// An honest script with one deviation.
    function _hostileLeg(Attempt memory a, address source, address target, uint256 sold, uint256 pay, uint256 seed)
        internal
        returns (DominoV2Types.SwapLeg memory)
    {
        ScriptedRouter.Script memory script;
        (script.tokenIn, script.pull, script.tokenOut, script.pay) = (source, source == address(0) ? 0 : sold, target, pay);
        _fund(target, address(router), pay);
        uint256 deviation = _field(seed, 0, 8) % 8;
        if (deviation == 0 && source != address(0)) script.pull = sold + 1;
        else if (deviation == 1 && source != address(0) && sold > 1) script.pull = sold - 1;
        else if (deviation == 2) script.refundIn = 1;
        else if (deviation == 3) (script.extraToken, script.extraAmount) = (source, 1);
        else if (deviation == 4) (script.extraToken, script.extraAmount) = (address(token2), 1 + _field(seed, 8, 64) % 1e18);
        else if (deviation == 5) (script.callTarget, script.callData) = (address(autoExit), abi.encodeCall(IDominoAutoExitExtension.cancelNonce, (99)));
        else if (deviation == 6) (script.tokenOut, script.pay) = (address(token2), pay);
        else script.pay = 0;
        if (script.extraAmount != 0) _fund(script.extraToken, address(router), script.extraAmount);
        if (script.tokenOut == address(token2)) token2.mint(address(router), pay);
        if (script.extraToken == address(token2)) a.gifts[2] += script.extraAmount;
        return _routerLegWith(source, target, sold, script);
    }

    function _misshapen(address source, address target, uint256 sold, uint256 pay, uint256 seed)
        internal
        returns (DominoV2Types.SwapLeg memory)
    {
        uint256 shape = _field(seed, 0, 8) % 5;
        if (shape == 0) return _routerLeg(source, target, sold + 1, pay);
        if (shape == 1) return _routerLeg(target, source, sold, pay);
        if (shape == 2) return _routerLeg(source, target, 0, pay);
        if (shape == 3 && sold > 1) return _routerLeg(source, target, sold - 1, pay);
        return _routerLeg(source, source == address(0) ? address(token2) : address(0), sold, pay);
    }

    function _snapshot(address owner) internal view returns (Snapshot memory s) {
        for (uint256 i; i < 4; ++i) {
            address token = _tokenAt(i);
            s.module[i] = _balance(token, address(autoExit));
            s.owed[i] = autoExit.owedFees(token);
            s.credits[i] = _backed(token) - s.owed[i];
            s.ownerCredit[i] = autoExit.unclaimed(owner, token);
            s.ownerBalance[i] = _balance(token, owner);
            s.recipients[i] = _balance(token, FEE_RECIPIENT) + _balance(token, FEE_RECIPIENT_2);
        }
    }

    function _afterSuccess(Attempt memory a, Tracked memory t, Snapshot memory before) internal {
        ExitRecord memory r;
        bool found;
        (r.anchorPrice, r.reported, r.recipientIsOwner, found) = _executedLog(a.id, t.owner);
        Snapshot memory after_ = _snapshot(t.owner);
        (r.mode, r.slippage, r.below, r.above) = (t.mode, t.slippage, t.below, t.above);
        (r.expectedPrice, r.spot, r.evidenceValid, r.authorized, r.withdrawn) =
            (a.expectedPrice, a.spot, a.evidenceValid, a.authorized, a.withdrawn);
        r.minimum = [uint256(a.min0), a.min1];
        r.gifts = a.gifts;
        if (a.poolOk) {
            r.toToken1 = t.convertTo == a.pool.currency1;
            r.listedTarget = registry.chargeCurrencyRank(t.convertTo) != 0;
            (r.rank0, r.rank1) = (registry.chargeCurrencyRank(a.pool.currency0), registry.chargeCurrencyRank(a.pool.currency1));
            r.poolFee = _poolFee(a.pool, r.toToken1);
            address[2] memory currencies = [a.pool.currency0, a.pool.currency1];
            for (uint256 k; k < 2; ++k) {
                uint256 i = _index(currencies[k]);
                r.fee[k] = after_.recipients[i] + after_.owed[i] - before.recipients[i] - before.owed[i];
                r.got[k] = after_.ownerBalance[i] + after_.ownerCredit[i] - before.ownerBalance[i] - before.ownerCredit[i];
            }
        }
        for (uint256 i; i < 4; ++i) {
            r.kept[i] = int256(after_.module[i]) - int256(before.module[i]) - (int256(after_.owed[i]) - int256(before.owed[i]))
                - (int256(after_.credits[i]) - int256(before.credits[i]));
        }
        if (!found || !a.poolOk) {
            _breach("an execution without its MandateExecuted");
        } else {
            try auditor.audit(r) returns (uint256 broken) {
                _recordAudit(broken);
            } catch {
                _breach("an execution the auditor could not judge");
            }
        }
        tracked[a.index].status = EXECUTED;
        for (uint256 i; i < 4; ++i) {
            gifts[i] += a.gifts[i];
        }
        _lockHeld(a);
        _bump("executions");
        if (a.evidenceKind == 2) _bump("TWAP executions");
        if (t.mode == DominoV2Types.RECEIVE_CONVERTED && a.legs.length != 0) _bump("conversions");
        if (a.legKind == 3 || a.legKind == 4) _bump("pool-leg conversions");
        if (a.vault == address(hostile)) _bump("hostile vault executions");
        if (after_.credits[0] + after_.credits[1] + after_.credits[3] > before.credits[0] + before.credits[1] + before.credits[3]) {
            _bump("deferred deliveries");
        }
        if (after_.owed[0] + after_.owed[1] + after_.owed[3] > before.owed[0] + before.owed[1] + before.owed[3]) {
            _bump("deferred fees");
        }
    }

    function _recordAudit(uint256 broken) internal {
        string[10] memory names = [
            "an execution not authorized",
            "an execution without a crossed trigger",
            "an execution on stale or unadmitted evidence",
            "an execution with the spot outside the band",
            "an execution that did not conserve",
            "an execution that broke the tariff",
            "an execution under the floor",
            "an execution whose event misreports",
            "an execution that left something in the module",
            "an execution under the removal minimums"
        ];
        for (uint256 b; b < 10; ++b) {
            if (broken & (1 << b) != 0) _breach(names[b]);
        }
    }

    /// Calls back from a vault or a router met the lock; nothing was pulled.
    function _lockHeld(Attempt memory a) internal {
        if (a.vault == address(hostile)) {
            if (hostile.pullSucceeded() || (hostile.callAttempted() && hostile.callOk())) _breach("the hostile vault got through");
        } else if (MockVault(payable(a.vault)).reentryAttempted() && MockVault(payable(a.vault)).reentryOk()) {
            _breach("a vault re-entered the module");
        }
    }

    /// MandateExecuted of `id`: its anchor, its amounts, whether it names the owner.
    function _executedLog(bytes32 id, address owner)
        internal
        returns (uint160 price, uint256[2] memory amounts, bool toOwner, bool found)
    {
        AdvVm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(autoExit) && logs[i].topics.length == 3
                    && logs[i].topics[0] == IDominoAutoExit.MandateExecuted.selector && logs[i].topics[1] == id
            ) {
                (price, amounts[0], amounts[1]) = abi.decode(logs[i].data, (uint160, uint256, uint256));
                toOwner = logs[i].topics[2] == bytes32(uint256(uint160(owner)));
                found = true;
            }
        }
    }

    // ===================================================== market and time

    function movePrice(uint256 poolSeed, uint256 priceSeed) external observed(false, false) {
        uint256 pick = poolSeed % 3;
        DominoV2Types.PoolRef memory ref = pick == 0 ? p3 : pick == 1 ? p4 : pn;
        _moveTo(ref, _scaled(PRICE_ONE, 7500 + priceSeed % 5501));
        _bump("price moves");
    }

    function warp(uint256 seed) external observed(false, false) {
        uint256 scale = _field(seed, 0, 8) % 8;
        uint256 rest = _field(seed, 8, 32);
        _advance(
            scale < 3 ? 1 + rest % 60 : scale < 6 ? 60 + rest % 1 hours : scale == 6 ? 1 hours + rest % 1 days : 1 days + rest % 3 days
        );
    }

    // ============================================== owners and recipients

    /// An owner stops receiving one token: frozen, false-returning, lying,
    /// over-debiting (rarely), or for native currency a refuser, a gas burner,
    /// a bouncer, or an EOA again.
    function ownerGoesDark(uint256 ownerSeed, uint256 tokenSeed, uint256 modeSeed) external observed(false, false) {
        address owner = _ownerAt(ownerSeed % 5);
        uint256 t = tokenSeed % 4;
        if (t == 3) {
            if (owner == address(wallet)) return;
            uint256 code = modeSeed % 4;
            vm.etch(
                owner,
                code == 0
                    ? bytes("")
                    : code == 1
                        ? type(NativeRefuser).runtimeCode
                        : code == 2 ? type(GasBurner).runtimeCode : type(NativeBouncer).runtimeCode
            );
            return;
        }
        uint8 mode = uint8(modeSeed % 5);
        if (mode == 4 && _field(modeSeed, 8, 8) % 4 != 0) mode = 0;
        MockToken(_tokenAt(t)).setTowards(owner, mode);
    }

    /// An owner claims a deferred delivery to itself, another account, a
    /// contract refusing native currency or the fee recipient. A claim moves
    /// exactly the credit or nothing.
    function claim(uint256 ownerSeed, uint256 tokenSeed, uint256 recipientSeed) external observed(false, true) {
        address owner = _ownerAt(ownerSeed % 5);
        address token = _tokenAt(tokenSeed % 4);
        if (_field(tokenSeed, 8, 8) % 4 != 0) (owner, token) = _someCredit(owner, token);
        address[4] memory recipients = [owner, CLAIM_TO, address(refuser), FEE_RECIPIENT];
        address to = recipients[recipientSeed % 4];
        uint256 credit = autoExit.unclaimed(owner, token);
        uint256 held = _balance(token, address(autoExit));
        uint256 received = _balance(token, to);
        uint256[20] memory others;
        for (uint256 o; o < 5; ++o) {
            for (uint256 i; i < 4; ++i) {
                others[o * 4 + i] = autoExit.unclaimed(_ownerAt(o), _tokenAt(i));
            }
        }
        (bool ok,) = _callAs(owner, abi.encodeCall(IDominoAutoExitExtension.claim, (token, to)), 3_000_000);
        if (ok) {
            _bump("claims");
            if (
                credit == 0 || autoExit.unclaimed(owner, token) != 0 || _balance(token, address(autoExit)) != held - credit
                    || _balance(token, to) != received + credit
            ) _breach("a claim that did not move exactly the credit");
        } else if (autoExit.unclaimed(owner, token) != credit) {
            _breach("a failed claim lost the credit");
        }
        for (uint256 o; o < 5; ++o) {
            for (uint256 i; i < 4; ++i) {
                address other = _ownerAt(o);
                if ((other != owner || _tokenAt(i) != token) && autoExit.unclaimed(other, _tokenAt(i)) != others[o * 4 + i]) {
                    _breach("a claim moved another credit");
                }
            }
        }
    }

    /// A credit to claim, when any owner has one; else the pair given.
    function _someCredit(address owner, address token) internal view returns (address, address) {
        for (uint256 o; o < 5; ++o) {
            for (uint256 i; i < 4; ++i) {
                if (autoExit.unclaimed(_ownerAt(o), _tokenAt(i)) != 0) return (_ownerAt(o), _tokenAt(i));
            }
        }
        return (owner, token);
    }

    /// The fee recipient stops receiving one token, or comes back.
    function recipientGoesDark(uint256 tokenSeed, uint256 modeSeed) external observed(false, false) {
        uint256 t = tokenSeed % 4;
        if (t == 3) {
            uint256 code = modeSeed % 3;
            bytes memory runtime =
                code == 0 ? bytes("") : code == 1 ? type(NativeRefuser).runtimeCode : type(GasBurner).runtimeCode;
            vm.etch(FEE_RECIPIENT, runtime);
            vm.etch(FEE_RECIPIENT_2, runtime);
            return;
        }
        uint8 mode = uint8(modeSeed % 4); // NORMAL, REVERTS, RETURNS_FALSE, LIES
        MockToken(_tokenAt(t)).setTowards(FEE_RECIPIENT, mode);
        MockToken(_tokenAt(t)).setTowards(FEE_RECIPIENT_2, mode);
    }

    /// Anyone flushes owed fees to the recipient then in force: exactly them, or nothing.
    function flush(uint256 tokenSeed) external observed(true, false) {
        address token = _tokenAt(tokenSeed % 4);
        for (uint256 i; i < 4 && autoExit.owedFees(token) == 0 && _field(tokenSeed, 8, 8) % 4 != 0; ++i) {
            token = _tokenAt((tokenSeed % 4 + i + 1) % 4);
        }
        uint256 owed = autoExit.owedFees(token);
        address recipient = registry.feeRecipient();
        uint256 received = _balance(token, recipient);
        uint256 held = _balance(token, address(autoExit));
        vm.prank(STRANGER);
        try autoExit.flushOwedFees{gas: 3_000_000}(token) returns (uint256 amount) {
            if (amount != 0) _bump("flushes");
            if (
                amount != owed || autoExit.owedFees(token) != 0 || _balance(token, address(autoExit)) != held - owed
                    || _balance(token, recipient) != received + owed
            ) _breach("a flush that did not pay exactly what was owed");
        } catch {
            if (autoExit.owedFees(token) != owed) _breach("a failed flush lost the debt");
        }
    }

    function donate(uint256 tokenSeed, uint256 amount) external observed(false, false) {
        uint256 t = tokenSeed % 4;
        amount = 1 + amount % 1e20;
        if (t == 3) {
            // Native currency is accepted only inside an execution (F4 line 203).
            (bool ok,) = address(autoExit).call{value: amount}("");
            if (ok) {
                gifts[3] += amount;
                _breach("native currency accepted outside an execution");
            }
            return;
        }
        MockToken(_tokenAt(t)).mint(address(autoExit), amount);
        gifts[t] += amount;
        _bump("donations");
    }

    // ===================================================== vaults

    /// An owner switches the module off (one time in eight) or on.
    function toggleModule(uint256 vaultSeed, uint256 seed) external observed(false, false) {
        (address vault,,) = _vaultAt(vaultSeed);
        _switchModule(vault, seed % 8 == 0 ? address(0) : address(autoExit));
    }

    /// A vault misbehaves. F4's double: withholds part of what it reports,
    /// calls back into the module, changes owner, or lies about its pool. The
    /// hostile vault: pays and gifts anything, pulls, calls back, changes pool
    /// or owner.
    function vaultMisbehaves(uint256 vaultSeed, uint256 knobSeed, uint256 amountSeed) external observed(false, false) {
        (address vault, address owner,) = _vaultAt(vaultSeed);
        uint256 knob = _field(knobSeed, 0, 8) % 10;
        if (vault == address(hostile)) {
            _hostileKnob(knob, knobSeed >> 8, amountSeed);
            return;
        }
        MockVault mock = MockVault(payable(vault));
        if (knob == 0) {
            (, uint256 held0, uint256 held1) = mock.held(TOKEN_ID);
            mock.setWithhold(held0 == 0 ? 0 : amountSeed % (held0 + 1), held1 == 0 ? 0 : (amountSeed >> 128) % (held1 + 1));
        } else if (knob == 1) {
            mock.setReentry(address(autoExit), _reentry(amountSeed));
        } else if (knob == 2) {
            mock.setOwner(STRANGER);
        } else if (knob == 3) {
            DominoV2Types.PoolRef memory ref = mock.pool();
            mock.setPool(
                DominoV2Types.PoolRef(ref.dex, ref.currency1, (amountSeed % 2 == 0) ? ref.currency0 : ref.currency1, ref.fee, ref.tickSpacing, ref.hooks)
            );
        } else {
            // The misbehaviour ends: everything as it was made.
            mock.setReentry(address(0), "");
            mock.setWithhold(0, 0);
            mock.setOwner(owner);
            mock.setPool(vault == address(vaultA) ? p3 : vault == address(vaultC) ? pn : p4);
        }
    }

    function _reentry(uint256 seed) internal view returns (bytes memory) {
        uint256 pick = seed % 5;
        bytes32 id = tracked.length == 0 ? bytes32(0) : tracked[seed % tracked.length].id;
        if (pick == 0) return abi.encodeCall(IDominoAutoExitExtension.claim, (address(token1), address(this)));
        if (pick == 1) return abi.encodeCall(IDominoFeeSettlement.flushOwedFees, (address(token1)));
        if (pick == 2) return abi.encodeCall(IDominoAutoExit.revokeMandate, (id));
        if (pick == 3) return abi.encodeCall(IDominoAutoExitExtension.cancelNonce, (seed));
        IDominoAutoExit.Execution memory nested;
        return abi.encodeCall(IDominoAutoExit.execute, (id, nested));
    }

    function _hostileKnob(uint256 knob, uint256 seed, uint256 amountSeed) internal {
        DominoV2Types.PoolRef memory ref = hostile.pool();
        if (knob > 5) {
            hostile.setOwner(attacker);
            hostile.setPool(p4);
            hostile.setCall(address(0), "");
            hostile.setPull(address(0), 0);
        } else if (knob == 0) {
            uint256 pay0 = amountSeed % 1e21;
            uint256 pay1 = (amountSeed >> 128) % 1e21;
            hostile.setPayments(pay0, pay1, seed, seed >> 64);
            _fund(ref.currency0, address(hostile), pay0);
            _fund(ref.currency1, address(hostile), pay1);
        } else if (knob == 1) {
            uint256 native = amountSeed % 1e18;
            uint256 extra = (amountSeed >> 128) % 1e18;
            hostile.setGifts(native, address(token2), extra);
            _fund(address(0), address(hostile), native);
            token2.mint(address(hostile), extra);
        } else if (knob == 2) {
            hostile.setPull(_tokenAt(_field(seed, 0, 8) % 3), 1 + amountSeed % 1e21);
        } else if (knob == 3) {
            hostile.setCall(address(autoExit), _reentry(amountSeed));
        } else if (knob == 4) {
            uint256 pick = _field(seed, 0, 8) % 4;
            hostile.setPool(
                pick == 0
                    ? p3
                    : pick == 1
                        ? p4
                        : pick == 2 ? pn : DominoV2Types.PoolRef(DominoV2Types.DEX_V4, address(token1), address(token0), 3000, 60, address(0))
            );
        } else {
            hostile.setOwner(hostile.owner() == attacker ? ownerB : attacker);
        }
    }

    /// A position refilled with new amounts (zero included); nothing withheld.
    function refill(uint256 vaultSeed, uint256 amount0, uint256 amount1) external observed(false, false) {
        (address vault,,) = _vaultAt(vaultSeed % 4);
        MockVault mock = MockVault(payable(vault));
        mock.setWithhold(0, 0);
        _refill(mock, TOKEN_ID, amount0 % 3 == 0 ? 0 : amount0 % 1e22, amount1 % 3 == 0 ? 0 : amount1 % 1e22);
        _bump("refills");
    }

    // ========================================== guardian and governance

    /// The guardian narrows trust at once: halts, removes the operator,
    /// rotates the publisher out (removal and epoch), raises the epoch, or
    /// (most of the time) revokes one observation.
    function guardianActs(uint256 seed) external observed(false, false) {
        uint256 action = _field(seed, 0, 8) % 16;
        vm.startPrank(GUARDIAN);
        if (action == 0) {
            registry.haltAutomation();
            _bump("halts");
        } else if (action == 1) {
            registry.removeOperator(OPERATOR);
        } else if (action == 2) {
            registry.removePublisher(addressOfKey[_currentPublisher()]);
            if (clock > registry.observationEpoch()) registry.raiseObservationEpoch(uint64(clock));
        } else if (action == 3) {
            if (clock > registry.observationEpoch()) registry.raiseObservationEpoch(uint64(clock));
        } else if (signedKeys.length != 0) {
            bytes32 hash = anchor.hashObservation(signedPoints[_field(seed, 8, 8) % signedKeys.length]);
            if (!anchor.isRevoked(hash)) anchor.revokeObservation(hash);
        }
        vm.stopPrank();
    }

    /// Governance, through the timelock, undoes what the guardian narrowed
    /// first (resume, re-admit the operator, admit a successor publisher),
    /// then rotates the publisher or moves the fee recipient.
    function governanceActs(uint256 seed) external observed(false, false) {
        uint256 action = _field(seed, 0, 8) % 2 == 0 ? 2 : 3;
        _advance(1);
        if (registry.automationHalted()) {
            _governed(DominoV2Types.REGISTRY_RESUME_AUTOMATION, "");
            _bump("resumes");
        } else if (!registry.isOperator(OPERATOR)) {
            _governed(DominoV2Types.REGISTRY_OPERATOR, abi.encode(OPERATOR, true));
        } else if (action == 2 || !registry.isPublisher(addressOfKey[_currentPublisher()])) {
            uint256 key = uint256(keccak256(abi.encode("domino.v2.adversarial.publisher", publisherKeys.length + 1)));
            addressOfKey[key] = vm.addr(key);
            _governed(DominoV2Types.REGISTRY_PUBLISHER, abi.encode(addressOfKey[key], true));
            publisherKeys.push(key);
            _bump("publisher rotations");
        } else {
            address next = registry.feeRecipient() == FEE_RECIPIENT ? FEE_RECIPIENT_2 : FEE_RECIPIENT;
            _governed(DominoV2Types.REGISTRY_FEE_RECIPIENT, abi.encode(next));
            _bump("recipient changes");
        }
    }

    // ============================================================= reads

    function trackedCount() external view returns (uint256) {
        return tracked.length;
    }

    function trackedAt(uint256 i) external view returns (bytes32 id, uint8 status, address owner, uint256 nonce) {
        Tracked storage t = tracked[i];
        return (t.id, t.status, t.owner, t.nonce);
    }

    function refusalKindCount() external view returns (uint256) {
        return refusalKinds.length;
    }

    function refusalKindAt(uint256 i) external view returns (bytes4) {
        return refusalKinds[i];
    }

    function touchedCount() external view returns (uint256) {
        return touchedOwners.length;
    }

    function touchedAt(uint256 i) external view returns (address, uint256) {
        return (touchedOwners[i], touchedNonces[i]);
    }

    function moduleAddress() external view returns (address) {
        return address(autoExit);
    }

    function tokenAt(uint256 i) external view returns (address) {
        return _tokenAt(i);
    }

    function ownerAt(uint256 i) external view returns (address) {
        return _ownerAt(i);
    }

    function now_() external view returns (uint256) {
        return clock;
    }
}

/// The auto-exit module under every sequence the handler can produce:
/// - I16: in every token, the module holds at least its owed fees plus every
///   owner's deferred delivery;
/// - nothing else stays in the module: beyond debt and credits it holds only
///   what was donated or gifted (a router's or a hostile vault's currency
///   outside the action);
/// - a mandate executes at most once, only while active and unexpired, only
///   on an admitted operator's call without a halt, on the vault that still
///   enables the module for the same owner;
/// - only when the anchor crossed a trigger, on evidence the anchor accepts
///   (an admitted publisher's unexpired observation within 300 s and after
///   the epoch, or a TWAP of at least 600 s), with the spot within the
///   mandate's slippage of it;
/// - the tariff is F4's 20 bps (at most 20 bps of the position at the anchor
///   when receiving both; of the output, or of each token withdrawn, when
///   converting), deliveries conserve every unit, conversions meet the floor
///   and MandateExecuted reports what the owner got;
/// - nonces are single use; registration refuses exactly what the rules
///   refuse, in the module's order; statuses match the model;
/// - claims and flushes move exactly the credit or the debt, and those fall
///   only through them.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
contract DominoAutoExitInvariantsTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    AutoExitHandler internal handler;
    IModuleView internal module;

    function setUp() public {
        handler = new AutoExitHandler();
        module = IModuleView(handler.moduleAddress());
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    /// The actions only: the handler also inherits the world's helpers.
    function targetSelectors() public view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](20);
        selectors[0] = AutoExitHandler.register.selector;
        selectors[1] = AutoExitHandler.register.selector;
        selectors[2] = AutoExitHandler.revoke.selector;
        selectors[3] = AutoExitHandler.cancelNonce.selector;
        selectors[4] = AutoExitHandler.execute.selector;
        selectors[5] = AutoExitHandler.execute.selector;
        selectors[6] = AutoExitHandler.execute.selector;
        selectors[7] = AutoExitHandler.executeUnknown.selector;
        selectors[8] = AutoExitHandler.movePrice.selector;
        selectors[9] = AutoExitHandler.warp.selector;
        selectors[10] = AutoExitHandler.ownerGoesDark.selector;
        selectors[11] = AutoExitHandler.claim.selector;
        selectors[12] = AutoExitHandler.recipientGoesDark.selector;
        selectors[13] = AutoExitHandler.flush.selector;
        selectors[14] = AutoExitHandler.donate.selector;
        selectors[15] = AutoExitHandler.toggleModule.selector;
        selectors[16] = AutoExitHandler.vaultMisbehaves.selector;
        selectors[17] = AutoExitHandler.guardianActs.selector;
        selectors[18] = AutoExitHandler.governanceActs.selector;
        selectors[19] = AutoExitHandler.refill.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    /// The handler is evidence only if its actions reach the module: a
    /// scripted pass in which each kind of action succeeds at least once,
    /// every invariant checked after it.
    function testTheHandlerReachesEveryAction() public {
        // B (vault 1, p4) registers a stop at the spot, receiving both; C (vault 2,
        // native pool) a stop converting into token1; A (vault 0, v3) a stop at
        // the spot; the wallet (vault 3) a stop converting into token0.
        handler.register(1, 0, 0, _terms(100, 2 days, 0, 5));
        handler.register(2, 0, 4 | (1 << 8), _terms(500, 2 days, 0, 5));
        handler.register(0, 0, 0, _terms(1000, 2 days, 0, 5));
        handler.register(3, 0, 3, _terms(300, 2 days, 1, 5));
        // Refused registrations, each for its own reason.
        handler.register(1, 7, 0, _terms(100, 2 days, 0, 5)); // no trigger
        handler.register(1, 0, 0, _terms(100, 2 days, 6, 1)); // a key that is not the owner's signs
        require(handler.success("registrations") == 4, "registrations never reached the module");

        // Fresh observations (evidence draw 10): B's stop fires receiving both;
        // C's converts at an honest router price.
        handler.execute(0, 10, 0, 1);
        handler.execute(1, 10, 1500 << 8, 1);
        // A's stop on the v3 pool through a TWAP of the module's floor window, after some history.
        handler.warp(3 | (700 << 8));
        handler.execute(2, 0 | (1 << 8), 0, 1);
        // The wallet's conversion into token0 (not a charge currency) through a v4 pool leg.
        handler.execute(3, 10, 3, 1);
        require(handler.success("executions") >= 4, "executions never reached the module");
        require(handler.success("TWAP executions") == 1, "the TWAP path never fired");
        require(handler.success("pool-leg conversions") == 1, "the pool-leg path never fired");

        // B goes dark in token1 and refills; a new stop fires; the delivery waits; B claims it.
        handler.ownerGoesDark(1, 1, 1);
        handler.refill(1, 1e21, 1e21);
        handler.register(1, 0, 0, _terms(100, 2 days, 2, 5));
        handler.recipientGoesDark(1, 1);
        handler.execute(4, 10, 0, 1);
        require(handler.success("deferred deliveries") >= 1, "no delivery was ever deferred");
        require(handler.success("deferred fees") >= 1, "no fee was ever deferred");
        handler.ownerGoesDark(1, 1, 0);
        handler.claim(1, 1, 1);
        handler.recipientGoesDark(1, 0);
        handler.flush(1);
        require(handler.success("claims") == 1 && handler.success("flushes") == 1, "claim or flush never ran");

        // Revocation, nonce cancellation, re-execution refused, halt and resume, rotation, donations.
        handler.refill(0, 1e21, 1e21);
        handler.register(0, 0, 0, _terms(100, 2 days, 3, 5));
        handler.revoke(5, 1);
        handler.cancelNonce(0, 5);
        handler.execute(0, 10, 0, 1);
        handler.guardianActs(0);
        handler.governanceActs(0);
        handler.guardianActs(2);
        handler.governanceActs(2);
        handler.donate(2, 777);
        handler.donate(3, 1);
        handler.executeUnknown(1);
        handler.movePrice(1, 1000);
        handler.vaultMisbehaves(4, 3, 1);
        handler.toggleModule(1, 0);
        require(
            handler.success("revocations") == 1 && handler.success("cancellations") == 1 && handler.success("halts") == 1
                && handler.success("resumes") == 1 && handler.success("publisher rotations") == 1
                && handler.success("donations") == 1 && handler.success("price moves") == 1,
            "an owner, guardian or governance action never ran"
        );
        _all();
    }

    /// The judge is not vacuous: a record that keeps every rule passes, and
    /// breaking any single rule sets that rule's bit alone.
    function testTheAuditorCatchesEachRuleOnItsOwn() public view {
        ExitAuditor judge = handler.auditor();
        require(judge.audit(_both()) == 0, "receiving both, led by token1");
        ExitRecord memory r = _both();
        r.authorized = false;
        _only(judge, r, judge.AUTH());
        r = _both();
        (r.anchorPrice, r.expectedPrice, r.spot) = (PRICE + 1, PRICE + 1, PRICE + 1);
        _only(judge, r, judge.TRIGGER());
        r = _both();
        r.evidenceValid = false;
        _only(judge, r, judge.EVIDENCE());
        r = _both();
        r.expectedPrice = PRICE - 1;
        _only(judge, r, judge.EVIDENCE());
        r = _both();
        r.spot = PRICE * 101 / 100;
        _only(judge, r, judge.BAND());
        r = _both();
        r.reported[1] -= 1;
        _only(judge, r, judge.EVENT());
        r = _both();
        r.recipientIsOwner = false;
        _only(judge, r, judge.EVENT());
        r = _both();
        r.kept[1] = 1;
        _only(judge, r, judge.KEPT());
        r = _both();
        r.gifts[2] = 7;
        _only(judge, r, judge.KEPT());
        r = _both();
        r.minimum[0] = 1e21 + 1;
        _only(judge, r, judge.MINIMUM());
        r = _both();
        (r.got[0], r.reported[0]) = (r.got[0] - 1, r.reported[0] - 1);
        _only(judge, r, judge.CONSERVATION());
        r = _both();
        (r.fee[1], r.got[1], r.reported[1]) = (r.fee[1] + 1, r.got[1] - 1, r.reported[1] - 1);
        _only(judge, r, judge.TARIFF());
        // Neither token a charge currency: 20 bps of each, exactly.
        r = _both();
        r.rank1 = 0;
        (r.fee[0], r.fee[1]) = (2e18, 2e18);
        (r.got[0], r.got[1]) = (1e21 - 2e18, 1e21 - 2e18);
        r.reported = [r.got[0], r.got[1]]; // a copy, not an alias
        require(judge.audit(r) == 0, "receiving both, no charge currency");
        (r.fee[0], r.got[0], r.reported[0]) = (2e18 - 1, 1e21 - 2e18 + 1, 1e21 - 2e18 + 1);
        _only(judge, r, judge.TARIFF());
        // Converted into a charge currency, exactly at the floor.
        r = _converted(true, 0);
        require(judge.audit(r) == 0, "converted at the floor");
        _only(judge, _converted(true, 1), judge.FLOOR());
        r = _converted(true, 0);
        (r.got[0], r.reported[0]) = (1, 1);
        _only(judge, r, judge.CONSERVATION());
        r = _converted(true, 0);
        r.fee[0] = 1;
        _only(judge, r, judge.TARIFF());
        // Converted into a token that is no charge currency: each token before.
        r = _converted(false, 0);
        require(judge.audit(r) == 0, "converted, unlisted, at the floor");
        _only(judge, _converted(false, 1), judge.FLOOR());
        r = _converted(false, 0);
        (r.fee[1], r.got[1], r.reported[1]) = (r.fee[1] + 1, r.got[1] - 1, r.reported[1] - 1);
        _only(judge, r, judge.TARIFF());
    }

    uint160 internal constant PRICE = uint160(1 << 96);

    /// An exit at price one receiving both: 1e21 of each withdrawn, token1 the
    /// first charge currency, 20 bps of 2e21 taken in token1.
    function _both() internal pure returns (ExitRecord memory r) {
        (r.mode, r.rank0, r.rank1, r.slippage, r.below) = (DominoV2Types.RECEIVE_BOTH, 0, 1, 100, PRICE);
        (r.anchorPrice, r.expectedPrice, r.spot, r.evidenceValid, r.authorized, r.recipientIsOwner, r.poolFee) =
            (PRICE, PRICE, PRICE, true, true, true, 3000);
        r.withdrawn = [uint256(1e21), 1e21];
        r.fee = [uint256(0), 4e18];
        r.got = [uint256(1e21), 1e21 - 4e18];
        r.reported = [r.got[0], r.got[1]]; // a copy, not an alias
    }

    /// A conversion of 1e21 token0 into token1 at the floor, less `short`.
    function _converted(bool listed, uint256 short) internal pure returns (ExitRecord memory r) {
        r = _both();
        (r.mode, r.toToken1, r.listedTarget) = (DominoV2Types.RECEIVE_CONVERTED, true, listed);
        uint256 sourceFee = listed ? 0 : 1e21 * 20 / 10_000;
        uint256 targetFee = listed ? 0 : 1e21 * 20 / 10_000;
        uint256 out = DominoSwapFloor.minimumOutput(1e21 - sourceFee, PRICE, true, 3000, 100) - short;
        uint256 gross = 1e21 - targetFee + out;
        uint256 outputFee = listed ? (1e21 + out) * 20 / 10_000 : 0;
        r.fee = [sourceFee, listed ? outputFee : targetFee];
        r.got = [uint256(0), listed ? 1e21 + out - outputFee : gross];
        r.reported = [r.got[0], r.got[1]]; // a copy, not an alias
    }

    error Judged(uint256 broken, uint256 expected);

    function _only(ExitAuditor judge, ExitRecord memory r, uint256 bit) internal view {
        uint256 broken = judge.audit(r);
        if (broken != bit) revert Judged(broken, bit);
    }

    /// A seeded walk through the fuzzer's own actions with its weights, every
    /// invariant checked every 50 steps: evidence that random parameters reach
    /// the module's success paths, not only its refusals. The counters print
    /// with -vv.
    function testASeededWalkReachesTheSuccessPaths() public {
        uint256 seed = uint256(keccak256("domino.v2.adversarial.auto-exit.walk"));
        for (uint256 step; step < 2000; ++step) {
            seed = uint256(keccak256(abi.encode(seed)));
            _act(seed);
            if (step % 50 == 49) _all();
        }
        _all();
        string[16] memory names = [
            "registrations",
            "executions",
            "TWAP executions",
            "conversions",
            "pool-leg conversions",
            "hostile vault executions",
            "deferred deliveries",
            "deferred fees",
            "claims",
            "flushes",
            "revocations",
            "cancellations",
            "refused executions",
            "halts",
            "resumes",
            "publisher rotations"
        ];
        for (uint256 i; i < names.length; ++i) {
            _log(names[i], handler.success(names[i]));
        }
        for (uint256 i; i < handler.refusalKindCount(); ++i) {
            bytes4 kind = handler.refusalKindAt(i);
            _log(string.concat("refused: ", _errorName(kind)), handler.refusals(kind));
        }
        // Every success path, reached by random parameters alone.
        require(handler.success("executions") >= 10 && handler.success("conversions") >= 3, "few executions");
        require(
            handler.success("TWAP executions") != 0 && handler.success("pool-leg conversions") != 0
                && handler.success("hostile vault executions") != 0,
            "a kind of execution never succeeded"
        );
        require(
            handler.success("deferred deliveries") != 0 && handler.success("deferred fees") != 0
                && handler.success("claims") != 0 && handler.success("flushes") != 0,
            "deferral, claim or flush never happened"
        );
        // And the refusals span the module's own guards and the anchor's.
        require(handler.refusalKindCount() >= 12, "few kinds of refusal");
    }

    function _log(string memory what, uint256 value) internal view {
        (bool ok,) = address(0x000000000000000000636F6e736F6c652e6c6f67).staticcall(
            abi.encodeWithSignature("log(string,uint256)", what, value)
        );
        ok;
    }

    function _errorName(bytes4 kind) internal pure returns (string memory) {
        bytes4[25] memory kinds = [
            IDominoAutoExit.Unauthorized.selector,
            IDominoAutoExitExtension.AutomationHalted.selector,
            IDominoAutoExit.MandateNotActive.selector,
            IDominoAutoExitExtension.ExitModuleNotEnabled.selector,
            IDominoAutoExitExtension.VaultOwnerChanged.selector,
            IDominoAutoExit.InvalidMandate.selector,
            IDominoAutoExitExtension.TwapWindowTooShort.selector,
            IDominoAutoExitExtension.TwapWindowTooLong.selector,
            IDominoAutoExit.TriggerNotReached.selector,
            IDominoAutoExitExtension.InvalidExecution.selector,
            IDominoAutoExitExtension.BelowMinimum.selector,
            IDominoAutoExitExtension.DeliveryMismatch.selector,
            bytes4(keccak256("InvalidObservation()")),
            bytes4(keccak256("ObservationRevoked()")),
            bytes4(keccak256("ObservationExpired()")),
            bytes4(keccak256("TwapUnavailable()")),
            bytes4(keccak256("SpotOutsideBand()")),
            bytes4(keccak256("PoolUnavailable()")),
            bytes4(keccak256("InvalidPlan()")),
            bytes4(keccak256("SwapEffectMismatch()")),
            bytes4(keccak256("ReentrantCall()")),
            bytes4(keccak256("PriceSlippageCheck()")),
            bytes4(keccak256("Error(string)")),
            bytes4(keccak256("Panic(uint256)")),
            bytes4(0)
        ];
        string[25] memory names = [
            "Unauthorized",
            "AutomationHalted",
            "MandateNotActive",
            "ExitModuleNotEnabled",
            "VaultOwnerChanged",
            "InvalidMandate",
            "TwapWindowTooShort",
            "TwapWindowTooLong",
            "TriggerNotReached",
            "InvalidExecution",
            "BelowMinimum",
            "DeliveryMismatch",
            "InvalidObservation",
            "ObservationRevoked",
            "ObservationExpired",
            "TwapUnavailable",
            "SpotOutsideBand",
            "PoolUnavailable",
            "InvalidPlan",
            "SwapEffectMismatch",
            "ReentrantCall",
            "PriceSlippageCheck",
            "Error(string)",
            "Panic",
            "no data"
        ];
        for (uint256 i; i < kinds.length; ++i) {
            if (kinds[i] == kind) return names[i];
        }
        return "other";
    }

    /// One fuzzer step: the action is picked with targetSelectors' weights; a
    /// reverting step is dropped, as fail_on_revert = false drops it.
    function _act(uint256 seed) internal {
        uint256[4] memory s;
        for (uint256 i; i < 4; ++i) {
            s[i] = uint256(keccak256(abi.encode(seed, i)));
        }
        uint256 action = seed % 20;
        if (action < 2) {
            try handler.register(s[0], s[1], s[2], s[3]) {} catch {}
        } else if (action == 2) {
            try handler.revoke(s[0], s[1]) {} catch {}
        } else if (action == 3) {
            try handler.cancelNonce(s[0], s[1]) {} catch {}
        } else if (action < 7) {
            try handler.execute(s[0], s[1], s[2], s[3]) {} catch {}
        } else if (action == 7) {
            try handler.executeUnknown(s[0]) {} catch {}
        } else if (action == 8) {
            try handler.movePrice(s[0], s[1]) {} catch {}
        } else if (action == 9) {
            try handler.warp(s[0]) {} catch {}
        } else if (action == 10) {
            try handler.ownerGoesDark(s[0], s[1], s[2]) {} catch {}
        } else if (action == 11) {
            try handler.claim(s[0], s[1], s[2]) {} catch {}
        } else if (action == 12) {
            try handler.recipientGoesDark(s[0], s[1]) {} catch {}
        } else if (action == 13) {
            try handler.flush(s[0]) {} catch {}
        } else if (action == 14) {
            try handler.donate(s[0], s[1]) {} catch {}
        } else if (action == 15) {
            try handler.toggleModule(s[0], s[1]) {} catch {}
        } else if (action == 16) {
            try handler.vaultMisbehaves(s[0], s[1], s[2]) {} catch {}
        } else if (action == 17) {
            try handler.guardianActs(s[0]) {} catch {}
        } else if (action == 18) {
            try handler.governanceActs(s[0]) {} catch {}
        } else {
            try handler.refill(s[0], s[1], s[2]) {} catch {}
        }
    }

    /// register's termsSeed, field by field: slippage (index 2: 1 + value % 1000),
    /// a validity in the future, the nonce and who signs (5: the owner; 1: a
    /// key that is not the owner's; 0: another owner for itself).
    function _terms(uint256 slippage, uint256 validFor, uint256 nonce, uint256 who) internal pure returns (uint256) {
        return 2 | ((slippage - 1) << 8) | (5 << 24) | (validFor << 32) | (nonce << 64) | (who << 72);
    }

    function _all() internal view {
        invariant_everyTokenBacksOwedFeesAndCredits();
        invariant_nothingElseStaysInTheModule();
        invariant_mandatesExecuteOnceOnlyWhileActiveAndAuthorized();
        invariant_executionsNeedACrossedTriggerOnFreshEvidenceInsideTheBand();
        invariant_tariffDeliveryAndFloorFollowTheRules();
        invariant_noncesAreSingleUseAndRegistrationFollowsItsRules();
        invariant_claimsAndFlushesAreExact();
    }

    /// I16.
    function invariant_everyTokenBacksOwedFeesAndCredits() public view {
        for (uint256 i; i < 4; ++i) {
            address token = handler.tokenAt(i);
            require(_held(token) >= _debtAndCredits(token), "I16: a token does not back its debt and credits");
        }
    }

    function invariant_nothingElseStaysInTheModule() public view {
        for (uint256 i; i < 4; ++i) {
            address token = handler.tokenAt(i);
            require(_held(token) == _debtAndCredits(token) + handler.gifts(i), "the module kept something of an action");
        }
        require(handler.breach("an execution that left something in the module") == 0, "an execution left something");
        require(handler.breach("native currency accepted outside an execution") == 0, "native accepted outside an execution");
    }

    function invariant_mandatesExecuteOnceOnlyWhileActiveAndAuthorized() public view {
        require(handler.breach("an execution not authorized") == 0, "an execution not authorized");
        require(handler.breach("an unknown mandate executed") == 0, "an unknown mandate executed");
        require(handler.breach("an execution without its MandateExecuted") == 0, "an execution without its event");
        require(handler.breach("a vault re-entered the module") == 0, "a vault re-entered");
        require(handler.breach("the hostile vault got through") == 0, "the hostile vault got through");
        for (uint256 i; i < handler.trackedCount(); ++i) {
            (bytes32 id, uint8 status,,) = handler.trackedAt(i);
            require(module.mandateStatus(id) == status, "a status differs from the model");
        }
    }

    function invariant_executionsNeedACrossedTriggerOnFreshEvidenceInsideTheBand() public view {
        require(handler.breach("an execution without a crossed trigger") == 0, "no crossed trigger");
        require(handler.breach("an execution on stale or unadmitted evidence") == 0, "stale or unadmitted evidence");
        require(handler.breach("an execution with the spot outside the band") == 0, "spot outside the band");
    }

    function invariant_tariffDeliveryAndFloorFollowTheRules() public view {
        require(handler.breach("an execution that broke the tariff") == 0, "the tariff");
        require(handler.breach("an execution that did not conserve") == 0, "conservation");
        require(handler.breach("an execution under the floor") == 0, "the floor");
        require(handler.breach("an execution whose event misreports") == 0, "the event");
        require(handler.breach("an execution under the removal minimums") == 0, "the removal minimums");
    }

    function invariant_noncesAreSingleUseAndRegistrationFollowsItsRules() public view {
        require(handler.breach("a registration the rules refuse") == 0, "a registration the rules refuse");
        require(handler.breach("a registration refused other than the rules say") == 0, "a registration refused wrongly");
        require(handler.breach("a nonce used twice, or a fresh one refused") == 0, "a nonce");
        require(handler.breach("a revocation the rules do not allow, or one refused") == 0, "a revocation");
        for (uint256 i; i < handler.touchedCount(); ++i) {
            (address owner, uint256 nonce) = handler.touchedAt(i);
            require(module.nonceUsed(owner, nonce) == handler.nonceModel(owner, nonce), "a nonce differs from the model");
        }
    }

    function invariant_claimsAndFlushesAreExact() public view {
        require(handler.breach("owed fees fell without a flush") == 0, "owed fees fell without a flush");
        require(handler.breach("a credit fell without a claim") == 0, "a credit fell without a claim");
        require(handler.breach("a claim that did not move exactly the credit") == 0, "an inexact claim");
        require(handler.breach("a failed claim lost the credit") == 0, "a failed claim");
        require(handler.breach("a claim moved another credit") == 0, "a claim moved another credit");
        require(handler.breach("a flush that did not pay exactly what was owed") == 0, "an inexact flush");
        require(handler.breach("a failed flush lost the debt") == 0, "a failed flush");
        require(handler.totalBreaches() == 0, "a breach of any kind");
    }

    function _held(address token) internal view returns (uint256) {
        return token == address(0) ? address(module).balance : IBalance(token).balanceOf(address(module));
    }

    function _debtAndCredits(address token) internal view returns (uint256 total) {
        total = module.owedFees(token);
        for (uint256 o; o < 5; ++o) {
            total += module.unclaimed(handler.ownerAt(o), token);
        }
    }
}

interface IModuleView {
    function mandateStatus(bytes32 id) external view returns (uint8);
    function nonceUsed(address owner, uint256 nonce) external view returns (bool);
    function owedFees(address token) external view returns (uint256);
    function unclaimed(address owner, address token) external view returns (uint256);
}

interface IBalance {
    function balanceOf(address account) external view returns (uint256);
}
