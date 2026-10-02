// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    IUniswapV3PoolMinimal
} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IV4PoolManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {UniswapBase8453} from "./fixtures/UniswapBase8453.sol";

/// @notice The Foundry cheatcodes the F1c suites use (no forge-std here).
interface PositionsVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function etch(address target, bytes calldata code) external;
    function store(address target, bytes32 slot, bytes32 value) external;
    function load(address target, bytes32 slot) external view returns (bytes32);
    function getCode(string calldata artifact) external view returns (bytes memory);
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
    function expectPartialRevert(bytes4 selector) external;
    function deal(address account, uint256 amount) external;
    function warp(uint256 timestamp) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function assume(bool condition) external pure;
}

/// @notice TEST ONLY. An ERC20 with switchable quirks: no return data
/// (USDT style), a false or reverting approve, a false transfer, and a fee on
/// transfer.
contract PositionTestToken {
    uint8 public constant NO_RETURN_DATA = 1;
    uint8 public constant APPROVE_FALSE = 2;
    uint8 public constant TRANSFER_FALSE = 4;
    uint8 public constant APPROVE_REVERTS = 8;

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public quirks;
    uint256 public transferFeeBps;
    /// A call the token makes on every transfer, as a hostile token could.
    address public hookTarget;
    bytes public hookData;
    uint256 public hookCalls;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(string memory symbol_) {
        name = symbol_;
        symbol = symbol_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function setQuirks(uint8 quirks_, uint256 feeBps) external {
        (quirks, transferFeeBps) = (quirks_, feeBps);
    }

    function setHook(address target, bytes calldata data) external {
        (hookTarget, hookData) = (target, data);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        require(quirks & APPROVE_REVERTS == 0, "approve refused");
        if (quirks & APPROVE_FALSE != 0) return false;
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        _done();
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (quirks & TRANSFER_FALSE != 0) return false;
        _move(msg.sender, to, amount);
        if (hookTarget != address(0)) {
            (bool ok,) = hookTarget.call(hookData);
            if (ok) hookCalls++;
        }
        _done();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        _done();
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = amount * transferFeeBps / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
    }

    function _done() private view {
        if (quirks & NO_RETURN_DATA != 0) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
    }
}

/// @notice TEST ONLY. Swaps on a v4 pool through its own unlock, to accrue fees.
contract V4SwapDriver {
    uint160 private constant MIN_SQRT_PRICE = 4295128739;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;
    IV4PoolManagerMinimal public immutable manager;

    constructor(IV4PoolManagerMinimal manager_) {
        manager = manager_;
    }

    receive() external payable {}

    function swap(IV4PoolManagerMinimal.PoolKey memory key, bool zeroForOne, uint256 amountIn) external {
        manager.unlock(abi.encode(key, zeroForOne, amountIn));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "swap callback");
        (IV4PoolManagerMinimal.PoolKey memory key, bool zeroForOne, uint256 amountIn) =
            abi.decode(data, (IV4PoolManagerMinimal.PoolKey, bool, uint256));
        manager.swap(
            key,
            IV4PoolManagerMinimal.SwapParams(
                zeroForOne, -int256(amountIn), zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            ),
            ""
        );
        _resolve(key.currency0);
        _resolve(key.currency1);
        return "";
    }

    function _resolve(address currency) private {
        int256 delta = int256(uint256(manager.exttload(keccak256(abi.encode(address(this), currency)))));
        if (delta > 0) {
            manager.take(currency, address(this), uint256(delta));
        } else if (delta < 0) {
            manager.sync(currency);
            if (currency == address(0)) {
                manager.settle{value: uint256(-delta)}();
            } else {
                PositionTestToken(currency).transfer(address(manager), uint256(-delta));
                manager.settle();
            }
        }
    }
}

/// @notice TEST ONLY. Swaps on a v3 pool directly, paying in the callback.
contract V3SwapDriver {
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    function swap(address pool, bool zeroForOne, uint256 amountIn) external {
        IUniswapV3PoolMinimal(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(pool)
        );
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "swap callback");
        if (amount0Delta > 0) {
            PositionTestToken(IUniswapV3PoolMinimal(pool).token0()).transfer(pool, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            PositionTestToken(IUniswapV3PoolMinimal(pool).token1()).transfer(pool, uint256(amount1Delta));
        }
    }
}

/// @notice TEST ONLY. A v4 subscriber whose notifications can revert or burn
/// their gas, recording what it was told.
contract V4TestSubscriber {
    bool public revertOnModify;
    bool public revertOnBurn;
    bool public exhaustOnUnsubscribe;
    uint256 public modifications;
    int256 public lastLiquidityChange;
    int256 public lastFeesAccrued;
    uint256 public burns;
    uint256 public unsubscribeGas;

    function configure(bool modify_, bool burn_, bool unsubscribe_) external {
        (revertOnModify, revertOnBurn, exhaustOnUnsubscribe) = (modify_, burn_, unsubscribe_);
    }

    function notifySubscribe(uint256, bytes memory) external {}

    function notifyUnsubscribe(uint256) external {
        unsubscribeGas = gasleft();
        if (exhaustOnUnsubscribe) {
            while (true) {}
        }
    }

    function notifyModifyLiquidity(uint256, int256 liquidityChange, int256 feesAccrued) external {
        require(!revertOnModify, "subscriber refuses");
        modifications++;
        (lastLiquidityChange, lastFeesAccrued) = (liquidityChange, feesAccrued);
    }

    function notifyBurn(uint256, address, uint256, uint256, int256) external {
        require(!revertOnBurn, "subscriber refuses burn");
        burns++;
    }
}

/// @notice Shared helpers: cheatcodes, assertions, and the Base fixtures.
abstract contract PositionTestKit {
    PositionsVm internal constant vm = PositionsVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error Mismatch(string what, uint256 actual, uint256 expected);
    error SignedMismatch(string what, int256 actual, int256 expected);

    function _eq(uint256 actual, uint256 expected, string memory what) internal pure {
        if (actual != expected) revert Mismatch(what, actual, expected);
    }

    function _eqInt(int256 actual, int256 expected, string memory what) internal pure {
        if (actual != expected) revert SignedMismatch(what, actual, expected);
    }

    function _eqAddress(address actual, address expected, string memory what) internal pure {
        if (actual != expected) revert Mismatch(what, uint160(actual), uint160(expected));
    }

    function _true(bool condition, string memory what) internal pure {
        if (!condition) revert Mismatch(what, 0, 1);
    }

    /// x mapped into [lo, hi].
    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (hi == type(uint256).max && lo == 0) return x;
        return lo + x % (hi - lo + 1);
    }

    function _deploy(bytes memory init) internal returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create(0, add(init, 0x20), mload(init))
        }
        require(deployed != address(0), "deploy");
    }

    /// The deployed runtime of a fixture holder, checked against the profile's code hash.
    function _etchFixture(address target, string memory artifact, bytes32 codehash) internal {
        bytes memory runtime = _deploy(vm.getCode(artifact)).code;
        if (keccak256(runtime) != codehash) revert Mismatch("fixture code hash", uint256(keccak256(runtime)), uint256(codehash));
        vm.etch(target, runtime);
    }

    /// Etches the Base (8453) Uniswap v3 deployment (factory, position manager,
    /// WETH9) at its addresses with the storage its constructors set.
    function _installBaseV3() internal {
        _etchFixture(UniswapBase8453.V3_FACTORY, UniswapBase8453.V3_FACTORY_ARTIFACT, UniswapBase8453.V3_FACTORY_CODEHASH);
        _etchFixture(
            UniswapBase8453.V3_POSITION_MANAGER,
            UniswapBase8453.V3_POSITION_MANAGER_ARTIFACT,
            UniswapBase8453.V3_POSITION_MANAGER_CODEHASH
        );
        _etchFixture(UniswapBase8453.WETH9, UniswapBase8453.WETH9_ARTIFACT, UniswapBase8453.WETH9_CODEHASH);
        _constructorStorage();
    }

    /// Etches the Base (8453) Uniswap v4 deployment (PoolManager,
    /// PositionManager, StateView) at its addresses with its constructor storage.
    function _installBaseV4() internal {
        _etchFixture(
            UniswapBase8453.V4_POOL_MANAGER, UniswapBase8453.V4_POOL_MANAGER_ARTIFACT, UniswapBase8453.V4_POOL_MANAGER_CODEHASH
        );
        _etchFixture(
            UniswapBase8453.V4_POSITION_MANAGER,
            UniswapBase8453.V4_POSITION_MANAGER_ARTIFACT,
            UniswapBase8453.V4_POSITION_MANAGER_CODEHASH
        );
        _etchFixture(
            UniswapBase8453.V4_STATE_VIEW, UniswapBase8453.V4_STATE_VIEW_ARTIFACT, UniswapBase8453.V4_STATE_VIEW_CODEHASH
        );
        _constructorStorage();
    }

    function _constructorStorage() private {
        (address[] memory accounts, bytes32[] memory slots, bytes32[] memory values) =
            UniswapBase8453.constructorStorage();
        for (uint256 i; i < accounts.length; ++i) {
            vm.store(accounts[i], slots[i], values[i]);
        }
    }

    /// Two fresh tokens, sorted.
    function _tokens() internal returns (PositionTestToken low, PositionTestToken high) {
        PositionTestToken a = new PositionTestToken("TKA");
        PositionTestToken b = new PositionTestToken("TKB");
        (low, high) = address(a) < address(b) ? (a, b) : (b, a);
    }

    function _balance(address currency, address account) internal view returns (uint256) {
        return currency == address(0) ? account.balance : PositionTestToken(currency).balanceOf(account);
    }
}
