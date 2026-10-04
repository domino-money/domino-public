// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev The token-behaviour matrix (attack map gap 6): hostile and unusual
/// ERC-20s for the adversarial suites, and the cheatcodes those suites add to
/// the ones their bases declare. Nothing here is evidence about a real token;
/// each behaviour is modelled on a token class seen in the wild (USDT,
/// fee-on-transfer, paused or frozen tokens, rebasing tokens, double-entry
/// tokens like the legacy TUSD) or on an attack (return bombs, gas burners,
/// tokens that misreport their own state).

/// Foundry cheatcodes the adversarial suites need beyond their bases' (no
/// forge-std in this repository); the same address as every other Vm handle.
interface AdversarialVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function deal(address account, uint256 balance) external;
    function warp(uint256 timestamp) external;
    function assume(bool condition) external pure;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function snapshotState() external returns (uint256 snapshotId);
    function revertToState(uint256 snapshotId) external returns (bool success);
    function load(address target, bytes32 slot) external view returns (bytes32);
    function toString(uint256 value) external pure returns (string memory);
}

address constant CHEATS = address(uint160(uint256(keccak256("hevm cheat code"))));
address constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;

/// Prints a line with forge's console (visible with -vv); the matrix tables use it.
function consoleLog(string memory line) view {
    (bool ok,) = CONSOLE.staticcall(abi.encodeWithSignature("log(string)", line));
    ok;
}

/// The matrix's behaviours, one at a time, each with one parameter. "A
/// payment by the subject" is a transfer the subject makes (and, when the
/// token is aimed with `pulls`, a transferFrom out of the subject's balance).
library Behaviour {
    uint8 internal constant NORMAL = 0;
    /// A payment by the subject moves nothing and returns false.
    uint8 internal constant RETURNS_FALSE = 1;
    /// A payment by the subject moves and returns no data at all (USDT).
    uint8 internal constant RETURNS_NOTHING = 2;
    /// A payment by the subject reverts (a paused token, a frozen account).
    uint8 internal constant REVERTS = 3;
    /// A payment by the subject delivers `param` bps less; the rest is burned.
    uint8 internal constant TAXED = 4;
    /// A payment by the subject debits it `param` more than asked (a sender-side fee).
    uint8 internal constant OVERDEBITS = 5;
    /// A payment by the subject burns every unit of gas it is given.
    uint8 internal constant BURNS_GAS = 6;
    /// A payment by the subject succeeds and answers with `param` bytes (a
    /// return bomb) whose first word is true.
    uint8 internal constant RETURN_BOMB = 7;
    /// balanceOf(subject) reports `param` more than the subject holds.
    uint8 internal constant BALANCE_LIES = 8;
    /// balanceOf(subject) reverts.
    uint8 internal constant BALANCE_REVERTS = 9;
    /// A payment by the subject moves and still returns false.
    uint8 internal constant MOVES_BUT_FALSE = 10;
    /// A payment by the subject returns true and moves nothing.
    uint8 internal constant TRUE_BUT_STILL = 11;
    /// Any transfer of zero reverts (for everyone).
    uint8 internal constant ZERO_REVERTS = 12;
    /// approve from a nonzero allowance to another nonzero one reverts (USDT, for everyone).
    uint8 internal constant APPROVE_RACE = 13;
    /// approve(spender, 0) by the subject reverts.
    uint8 internal constant APPROVE_ZERO_REVERTS = 14;
    /// A payment to the subject credits it `param` more than was sent (a rebase in transit).
    uint8 internal constant INFLATES = 15;
    /// A payment by or to the subject calls `hookTarget` with `hookData` once
    /// it has moved; a failing hook fails the payment (re-entry, a rebase mid-action).
    uint8 internal constant HOOKED = 16;
    /// approve by the subject adds to the allowance instead of setting it.
    uint8 internal constant APPROVE_ADDS = 17;
    /// An approve by the subject succeeds and answers with `param` bytes (a
    /// return bomb on approve alone) whose first word is true.
    uint8 internal constant APPROVE_BOMB = 18;
    uint8 internal constant COUNT = 19;

    function name(uint8 behaviour) internal pure returns (string memory) {
        string[19] memory names = [
            "normal",
            "returns false",
            "returns nothing",
            "reverts",
            "taxed",
            "over-debits",
            "burns gas",
            "return bomb",
            "balanceOf lies",
            "balanceOf reverts",
            "moves but false",
            "true but still",
            "zero reverts",
            "approve race",
            "approve zero reverts",
            "inflates",
            "hooked",
            "approve adds",
            "approve bomb"
        ];
        return names[behaviour];
    }
}

/// @notice An ERC-20 that is honest with everyone but one account, its
/// `subject` (the Domino contract under test). The Uniswap contracts and the
/// test doubles around the subject keep working, while every call the subject
/// makes meets the one misbehaviour a suite switched on (`aim`). It answers
/// TestToken's and MockToken's surfaces, so it drops into both the zap's and
/// the vault's worlds. `heldBy` always tells the truth.
contract MatrixToken {
    /// A subject that stands for every sender: the payment misbehaviours then
    /// apply to everyone's transfers (a fee-on-transfer token taxes them all).
    address public constant ANYONE = address(type(uint160).max);

    mapping(address => uint256) internal balances;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    uint256 public totalSupply;

    address public subject;
    uint8 public behaviour;
    uint256 public param;
    /// Whether the subject's misbehaviour also applies to transferFrom out of
    /// its balance (a pull by a position manager), not only to its own transfers.
    bool public pulls;
    /// A second address that moves these same balances (double entry).
    address public twin;
    address public hookTarget;
    bytes public hookData;

    function aim(address subject_, uint8 behaviour_, uint256 param_, bool pulls_) external {
        require(behaviour_ < Behaviour.COUNT, "behaviour");
        (subject, behaviour, param, pulls) = (subject_, behaviour_, param_, pulls_);
    }

    function setHook(address target, bytes calldata data) external {
        (hookTarget, hookData) = (target, data);
    }

    function setTwin(address twin_) external {
        twin = twin_;
    }

    // ----------------------------------------------------- test controls

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
        totalSupply += amount;
    }

    function burn(address from, uint256 amount) external {
        balances[from] -= amount;
        totalSupply -= amount;
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    /// What `account` really holds, whatever balanceOf reports.
    function heldBy(address account) external view returns (uint256) {
        return balances[account];
    }

    // ---------------------------------------------------------- ERC-20

    function balanceOf(address account) external view returns (uint256) {
        uint256 held = balances[account];
        if (account == subject) {
            uint8 b = behaviour;
            if (b == Behaviour.BALANCE_REVERTS) revert("balanceOf");
            if (b == Behaviour.BALANCE_LIES) return held + param;
        }
        return held;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _approve(msg.sender, spender, amount);
        if (msg.sender == subject && behaviour == Behaviour.APPROVE_BOMB) _bomb();
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _send(msg.sender, to, amount, true);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spend(from, msg.sender, amount);
        return _send(from, to, amount, pulls);
    }

    // ------------------------------------------------------ double entry

    function twinTransfer(address sender, address to, uint256 amount) external returns (bool) {
        require(msg.sender == twin, "twin only");
        return _send(sender, to, amount, true);
    }

    function twinTransferFrom(address spender, address from, address to, uint256 amount) external returns (bool) {
        require(msg.sender == twin, "twin only");
        _spend(from, spender, amount);
        return _send(from, to, amount, pulls);
    }

    function twinApprove(address owner, address spender, uint256 amount) external returns (bool) {
        require(msg.sender == twin, "twin only");
        _approve(owner, spender, amount);
        return true;
    }

    // --------------------------------------------------------- internals

    function _approve(address owner, address spender, uint256 amount) private {
        uint8 b = behaviour;
        if (b == Behaviour.APPROVE_RACE && amount != 0 && allowance[owner][spender] != 0) {
            revert("approve from nonzero");
        }
        if (owner == subject) {
            if (b == Behaviour.APPROVE_ZERO_REVERTS && amount == 0) revert("approve zero");
            if (b == Behaviour.APPROVE_ADDS) amount += allowance[owner][spender];
        }
        allowance[owner][spender] = amount;
    }

    function _spend(address from, address spender, uint256 amount) private {
        uint256 allowed = allowance[from][spender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][spender] = allowed - amount;
    }

    /// Moves `amount` from `from` to `to`; `aimed` says whether a payment by
    /// the subject may misbehave on this path.
    function _send(address from, address to, uint256 amount, bool aimed) private returns (bool) {
        require(!blocked[from] && !blocked[to], "blocked");
        uint8 b = behaviour;
        if (b == Behaviour.ZERO_REVERTS && amount == 0) revert("zero transfer");
        uint8 own = aimed && (from == subject || subject == ANYONE) ? b : Behaviour.NORMAL;
        if (own == Behaviour.REVERTS) revert("paused");
        if (own == Behaviour.BURNS_GAS) {
            assembly ("memory-safe") {
                invalid()
            }
        }
        if (own == Behaviour.RETURNS_FALSE) return false;
        if (own == Behaviour.TRUE_BUT_STILL) return true;
        uint256 debit = own == Behaviour.OVERDEBITS ? amount + param : amount;
        uint256 credit = own == Behaviour.TAXED ? amount - amount * param / 10_000 : amount;
        if (b == Behaviour.INFLATES && to == subject) credit += param;
        balances[from] -= debit;
        balances[to] += credit;
        totalSupply = totalSupply + credit - debit;
        if (b == Behaviour.HOOKED && (from == subject || to == subject) && hookTarget != address(0)) _hook();
        if (own == Behaviour.MOVES_BUT_FALSE) return false;
        if (own == Behaviour.RETURNS_NOTHING) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
        if (own == Behaviour.RETURN_BOMB) _bomb();
        return true;
    }

    function _hook() private {
        (bool ok, bytes memory out) = hookTarget.call(hookData);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(out, 0x20), mload(out))
            }
        }
    }

    /// Ends the call with `param` bytes of return data whose first word is
    /// true: the token pays for that memory, and only a caller that copies the
    /// whole payload pays again.
    function _bomb() private view {
        uint256 size = param;
        assembly ("memory-safe") {
            mstore(0, 1)
            return(0, size)
        }
    }
}

/// @notice The second address of a double-entry token (the legacy TUSD
/// shape): every call moves the main token's balances, so a holder's balance
/// is the same at both addresses.
contract TwinEntry {
    MatrixToken public immutable main;

    constructor(MatrixToken main_) {
        main = main_;
    }

    function balanceOf(address account) external view returns (uint256) {
        return main.balanceOf(account);
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return main.allowance(owner, spender);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        return main.twinApprove(msg.sender, spender, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return main.twinTransfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        return main.twinTransferFrom(msg.sender, from, to, amount);
    }

    function mint(address to, uint256 amount) external {
        main.mint(to, amount);
    }

    function heldBy(address account) external view returns (uint256) {
        return main.heldBy(account);
    }
}
