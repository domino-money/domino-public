// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IV4PoolManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {DominoAssistedSwap} from "../../../src/v2/route/DominoAssistedSwap.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {DominoTokenOps} from "../../../src/v2/route/DominoTokenOps.sol";

/// Foundry cheatcodes the V2 fee and route suites use (no forge-std in this repository).
interface V2Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function deal(address account, uint256 balance) external;
    function etch(address target, bytes calldata code) external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 id) external;
    function getCode(string calldata artifact) external view returns (bytes memory);
    function load(address target, bytes32 slot) external view returns (bytes32);
    function snapshotState() external returns (uint256 snapshotId);
    function revertToState(uint256 snapshotId) external returns (bool success);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// Shared helpers: the cheatcode handle, revert-data assertions and log lookups.
abstract contract V2TestBase {
    V2Vm internal constant vm = V2Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error Unexpected(string what);

    /// The call must revert with exactly `selector` (and any arguments).
    function _expectRevert(address target, uint256 value, bytes memory data, bytes4 selector, string memory what)
        internal
    {
        (bool ok, bytes memory out) = target.call{value: value}(data);
        if (ok || out.length < 4 || bytes4(out) != selector) revert Unexpected(what);
    }

    function _expectRevert(address target, bytes memory data, bytes4 selector, string memory what) internal {
        _expectRevert(target, 0, data, selector, what);
    }

    /// The call must revert with exactly this revert data.
    function _expectRevertData(address target, bytes memory data, bytes memory expected, string memory what) internal {
        (bool ok, bytes memory out) = target.call(data);
        if (ok || keccak256(out) != keccak256(expected)) revert Unexpected(what);
    }

    function _check(bool condition, string memory what) internal pure {
        if (!condition) revert Unexpected(what);
    }

    function _eq(uint256 actual, uint256 expected, string memory what) internal pure {
        if (actual != expected) revert Unexpected(what);
    }

    /// The number of recorded logs from `emitter` with topic0 `signature`.
    function _count(V2Vm.Log[] memory logs, address emitter, bytes32 signature) internal pure returns (uint256 found) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == signature) ++found;
        }
    }

    /// The first recorded log from `emitter` with topic0 `signature`.
    function _first(V2Vm.Log[] memory logs, address emitter, bytes32 signature)
        internal
        pure
        returns (V2Vm.Log memory log)
    {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == signature) {
                return logs[i];
            }
        }
        revert Unexpected("log not found");
    }

    function _deployCode(bytes memory init) internal returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create(0, add(init, 0x20), mload(init))
        }
        _check(deployed != address(0), "deployment");
    }
}

/// An ERC-20 whose misbehaviours the suites switch on one at a time.
contract TestToken {
    uint8 internal constant NORMAL = 0;
    uint8 internal constant RETURNS_FALSE = 1; // transfer returns false and moves nothing
    uint8 internal constant RETURNS_NOTHING = 2; // USDT style: no return value
    uint8 internal constant OVERDEBITS = 3; // debits the sender one unit more than asked

    uint8 internal constant BALANCE_OF_REVERTS = 1;
    uint8 internal constant ALLOWANCE_REVERTS = 2;
    uint8 internal constant APPROVE_FAILS = 4;

    mapping(address => uint256) internal balances;
    mapping(address => mapping(address => uint256)) internal allowances;
    mapping(address => bool) public blocked;
    uint256 public totalSupply;
    uint16 public taxBps; // kept from what the recipient is credited, and burned
    uint8 public mode;
    uint8 public broken; // views or approve that fail (bit flags above)
    address public backdoor; // may transferFrom anyone without an allowance (a hostile token)
    bool public spendsWholeAllowance; // any transferFrom zeroes the allowance
    bool public keepsAllowance; // transferFrom never decreases the allowance
    address public hookTarget; // called after every transfer
    bytes public hookData;

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
        totalSupply += amount;
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function setTax(uint16 bps) external {
        taxBps = bps;
    }

    function setMode(uint8 value) external {
        mode = value;
    }

    function setBroken(uint8 value) external {
        broken = value;
    }

    function setAllowanceQuirks(address backdoor_, bool whole, bool keep) external {
        (backdoor, spendsWholeAllowance, keepsAllowance) = (backdoor_, whole, keep);
    }

    function setHook(address target, bytes calldata data) external {
        (hookTarget, hookData) = (target, data);
    }

    function balanceOf(address account) external view returns (uint256) {
        require(broken & BALANCE_OF_REVERTS == 0, "balanceOf");
        return balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        require(broken & ALLOWANCE_REVERTS == 0, "allowance view");
        return allowances[owner][spender];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (broken & APPROVE_FAILS != 0) return false;
        allowances[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (msg.sender != backdoor) {
            uint256 allowed = allowances[from][msg.sender];
            require(allowed >= amount, "allowance");
            if (spendsWholeAllowance) allowances[from][msg.sender] = 0;
            else if (!keepsAllowance && allowed != type(uint256).max) allowances[from][msg.sender] = allowed - amount;
        }
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) private returns (bool) {
        require(!blocked[from] && !blocked[to], "blocked");
        if (mode == RETURNS_FALSE) return false;
        uint256 debit = mode == OVERDEBITS ? amount + 1 : amount;
        balances[from] -= debit;
        uint256 tax = amount * taxBps / 10_000;
        balances[to] += amount - tax;
        totalSupply -= tax + debit - amount;
        address target = hookTarget;
        if (target != address(0)) {
            (bool ok, bytes memory out) = target.call(hookData);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(out, 0x20), mload(out))
                }
            }
        }
        if (mode == RETURNS_NOTHING) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
        return true;
    }
}

/// The registry views the fee and route modules read, set directly by the suites.
contract MockDominoRegistry {
    mapping(address => uint16) public routerVersion;
    mapping(address => uint8) public chargeCurrencyRank;
    address private recipient;
    bool public recipientReverts;

    function setRouter(address router, uint16 version) external {
        routerVersion[router] = version;
    }

    function setRank(address token, uint8 rank) external {
        chargeCurrencyRank[token] = rank;
    }

    function setFeeRecipient(address next) external {
        recipient = next;
    }

    function setRecipientReverts(bool value) external {
        recipientReverts = value;
    }

    function feeRecipient() external view returns (address) {
        require(!recipientReverts, "registry unavailable");
        return recipient;
    }
}

/// A recipient that refuses native currency (an EIP-7702 account without receive).
contract RejectingRecipient {
    receive() external payable {
        revert("no receive");
    }
}

/// A recipient whose receive burns all the gas it is given.
contract GasBurningRecipient {
    receive() external payable {
        while (true) {}
    }
}

/// A recipient that accepts native currency and records what it got.
contract AcceptingRecipient {
    uint256 public received;

    receive() external payable {
        received += msg.value;
    }
}

/// A recipient that calls back into the fee module when paid in native currency.
contract ReenteringRecipient {
    address public target;
    bytes public data;
    bool public reverted;
    bytes public revertData;

    function arm(address target_, bytes calldata data_) external {
        (target, data) = (target_, data_);
    }

    receive() external payable {
        (bool ok, bytes memory out) = target.call(data);
        reverted = !ok;
        revertData = out;
    }
}

/// The fee and route modules as a host contract uses them: every entry point
/// runs inside the shared lock, and the host accepts native currency.
contract AssistedSwapHarness is DominoAssistedSwap {
    bool private netting;
    bool public lastCallbackHadLeg;

    constructor(DominoSwapExecutor.RouteConfig memory config) DominoAssistedSwap(config) {}

    receive() external payable {}

    function executeLegs(DominoV2Types.SwapLeg[] calldata legs, address[] calldata extraTracked)
        external
        payable
        nonReentrant
        returns (uint256[] memory)
    {
        return _executeLegs(legs, extraTracked);
    }

    /// The executor refuses to run outside a locked action.
    function executeLegsUnlocked(DominoV2Types.SwapLeg[] calldata legs, address[] calldata extraTracked)
        external
        returns (uint256[] memory)
    {
        return _executeLegs(legs, extraTracked);
    }

    function assistedSwap(
        DominoV2Types.SwapLeg[] calldata legs,
        address[] calldata extraTracked,
        uint16 feeBps,
        address feeToken,
        address payer,
        bytes32 ref
    ) external payable nonReentrant returns (uint256[] memory amountsOut, uint256 fee) {
        return _assistedSwap(legs, extraTracked, feeBps, feeToken, payer, ref);
    }

    function chargeFee(uint8 kind, address token, address payer, uint256 amount, bytes32 ref)
        external
        payable
        nonReentrant
        returns (uint256 deferred)
    {
        return _chargeFee(kind, token, payer, amount, ref);
    }

    function unowedBalance(address token) external view returns (uint256) {
        return _unowedBalance(token);
    }

    function swapInProgress() external view returns (bool) {
        return _swapInProgress();
    }

    /// A host's own unlock that nets a path swap (F3's compounding shape):
    /// _v4SwapPath inside the open unlock, then one settle and one take.
    function nettedV4Swap(address tokenIn, uint256 amountIn, DominoV2Types.PoolRef[] calldata pools)
        external
        payable
        nonReentrant
        returns (uint256 amountOut)
    {
        netting = true;
        bytes memory result = IV4PoolManagerMinimal(V4_POOL_MANAGER).unlock(abi.encode(tokenIn, amountIn, pools));
        amountOut = abi.decode(result, (uint256));
    }

    /// Starts an unlock without registering a swap leg: the executor's
    /// callback must refuse it.
    function unlockWithoutLeg(bytes calldata data) external {
        IV4PoolManagerMinimal(V4_POOL_MANAGER).unlock(data);
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        lastCallbackHadLeg = _v4LegPending();
        if (!netting) return _v4LegCallback(data);
        netting = false;
        require(msg.sender == V4_POOL_MANAGER, "manager");
        (address tokenIn, uint256 amountIn, DominoV2Types.PoolRef[] memory pools) =
            abi.decode(data, (address, uint256, DominoV2Types.PoolRef[]));
        (address tokenOut, uint256 amountOut) = _v4SwapPath(tokenIn, amountIn, pools);
        IV4PoolManagerMinimal manager = IV4PoolManagerMinimal(V4_POOL_MANAGER);
        manager.sync(tokenIn);
        if (tokenIn == address(0)) {
            manager.settle{value: amountIn}();
        } else {
            DominoTokenOps.transfer(tokenIn, address(manager), amountIn);
            manager.settle();
        }
        manager.take(tokenOut, address(this), amountOut);
        return abi.encode(amountOut);
    }

    function registry() external view returns (IDominoRegistry) {
        return ROUTE_REGISTRY;
    }
}

/// The PoolManager functions the suites use to build pools (v4-core 1.0,
/// identical selectors on the deployed and the vendored builds).
interface IV4PoolManagerTest {
    struct ModifyLiquidityParams {
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
    }

    function initialize(IV4PoolManagerMinimal.PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function modifyLiquidity(
        IV4PoolManagerMinimal.PoolKey memory key,
        ModifyLiquidityParams memory params,
        bytes calldata hookData
    ) external returns (int256 callerDelta, int256 feesAccrued);
    function unlock(bytes calldata data) external returns (bytes memory);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
    function setProtocolFeeController(address controller) external;
    function setProtocolFee(IV4PoolManagerMinimal.PoolKey memory key, uint24 newProtocolFee) external;
}

/// Adds liquidity to a v4 pool and pays for it, for the suites' pool setup.
contract V4LiquidityHelper {
    IV4PoolManagerTest public immutable manager;

    constructor(address manager_) {
        manager = IV4PoolManagerTest(manager_);
    }

    receive() external payable {}

    function add(IV4PoolManagerMinimal.PoolKey memory key, int24 tickLower, int24 tickUpper, int256 liquidity)
        external
        payable
    {
        manager.unlock(abi.encode(key, tickLower, tickUpper, liquidity));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "manager");
        (IV4PoolManagerMinimal.PoolKey memory key, int24 tickLower, int24 tickUpper, int256 liquidity) =
            abi.decode(data, (IV4PoolManagerMinimal.PoolKey, int24, int24, int256));
        (int256 delta,) = manager.modifyLiquidity(
            key, IV4PoolManagerTest.ModifyLiquidityParams(tickLower, tickUpper, liquidity, bytes32(0)), ""
        );
        _pay(key.currency0, int128(delta >> 128));
        _pay(key.currency1, int128(delta));
        return "";
    }

    function _pay(address currency, int128 delta) private {
        if (delta >= 0) return;
        uint256 amount = uint256(int256(-delta));
        manager.sync(currency);
        if (currency == address(0)) {
            manager.settle{value: amount}();
        } else {
            TestToken(currency).transfer(address(manager), amount);
            manager.settle();
        }
    }
}
