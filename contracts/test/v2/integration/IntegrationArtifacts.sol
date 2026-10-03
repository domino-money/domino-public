// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IUniswapV3PoolMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IV4PoolManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {UniswapBase8453} from "../positions/fixtures/UniswapBase8453.sol";
import {RobinhoodPermit2} from "../route/fixtures/RobinhoodPermit2.sol";
import {RobinhoodPoolManager} from "../route/fixtures/RobinhoodPoolManager.sol";
import {RobinhoodUniversalRouter212} from "../route/fixtures/RobinhoodUniversalRouter212.sol";
import {IntegrationChain} from "./IntegrationInterfaces.sol";

// The concrete helpers of the integration journeys, built once into artifacts
// that the suites deploy with vm.getCode. No suite imports this file: CI's
// Contracts (v2) job builds it before the suites, and locally
//     node scripts/test-contracts.mjs build test/v2/integration/IntegrationArtifacts.sol
// does (run it from contracts/). See docs/v2/INTEGRATION_TESTS.md for why.

interface IntegrationStageVm {
    function etch(address target, bytes calldata code) external;
    function store(address target, bytes32 slot, bytes32 value) external;
    function getCode(string calldata artifact) external view returns (bytes memory);
}

/// @notice TEST ONLY. Creation code that returns the Robinhood Permit2 runtime (F1b fixture).
contract IntegrationRobinhoodPermit2 {
    constructor() {
        bytes memory runtime = RobinhoodPermit2.RUNTIME;
        assembly ("memory-safe") {
            return(add(runtime, 0x20), mload(runtime))
        }
    }
}

/// @notice TEST ONLY. Creation code that returns the Robinhood PoolManager runtime (F1b fixture).
contract IntegrationRobinhoodPoolManager {
    constructor() {
        bytes memory runtime = RobinhoodPoolManager.RUNTIME;
        assembly ("memory-safe") {
            return(add(runtime, 0x20), mload(runtime))
        }
    }
}

/// @notice TEST ONLY. Creation code that returns the Robinhood Universal Router 2.1.2 runtime (F1b fixture).
contract IntegrationRobinhoodRouter {
    constructor() {
        bytes memory runtime = RobinhoodUniversalRouter212.RUNTIME;
        assembly ("memory-safe") {
            return(add(runtime, 0x20), mload(runtime))
        }
    }
}

/// @notice TEST ONLY. An ERC-20 with two switches the journeys need: an account
/// that cannot send or receive (a frozen recipient or owner) and a call made
/// after a transfer (a hostile token reentering whoever moved it): after every
/// transfer, or only after those to `hookRecipient` when one is set. A failing
/// hook fails the transfer with the hook's own revert data.
contract IntegrationToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    address public hookTarget;
    address public hookRecipient;
    bytes public hookData;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function setHook(address target, bytes calldata data) external {
        (hookTarget, hookData) = (target, data);
    }

    function setHookRecipient(address to) external {
        hookRecipient = to;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(!blocked[from] && !blocked[to], "blocked");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        address target = hookTarget;
        if (target != address(0) && (hookRecipient == address(0) || to == hookRecipient)) {
            (bool ok, bytes memory out) = target.call(hookData);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(out, 0x20), mload(out))
                }
            }
        }
    }
}

/// @notice TEST ONLY. Exact-input swaps on a v3 pool or a v4 PoolManager that
/// stop at a price limit, so a journey moves a pool to the price it needs.
contract IntegrationTrader {
    uint160 private constant MIN_LIMIT = 4295128739 + 1;
    uint160 private constant MAX_LIMIT = 1461446703485210103287273052203988822378723970342 - 1;

    address private _pending;

    function swapV3(address pool, bool zeroForOne, uint256 amountIn, uint160 limit) external {
        _pending = pool;
        IUniswapV3PoolMinimal(pool).swap(address(this), zeroForOne, int256(amountIn), _limit(zeroForOne, limit), "");
        _pending = address(0);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == _pending, "pool");
        if (amount0Delta > 0) {
            IntegrationToken(IUniswapV3PoolMinimal(msg.sender).token0()).transfer(msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IntegrationToken(IUniswapV3PoolMinimal(msg.sender).token1()).transfer(msg.sender, uint256(amount1Delta));
        }
    }

    function swapV4(address manager, IV4PoolManagerMinimal.PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint160 limit)
        external
    {
        _pending = manager;
        IV4PoolManagerMinimal(manager).unlock(abi.encode(key, zeroForOne, amountIn, _limit(zeroForOne, limit)));
        _pending = address(0);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == _pending, "manager");
        (IV4PoolManagerMinimal.PoolKey memory key, bool zeroForOne, uint256 amountIn, uint160 limit) =
            abi.decode(data, (IV4PoolManagerMinimal.PoolKey, bool, uint256, uint160));
        IV4PoolManagerMinimal(msg.sender).swap(
            key, IV4PoolManagerMinimal.SwapParams(zeroForOne, -int256(amountIn), limit), ""
        );
        _settle(IV4PoolManagerMinimal(msg.sender), key.currency0);
        _settle(IV4PoolManagerMinimal(msg.sender), key.currency1);
        return "";
    }

    function _settle(IV4PoolManagerMinimal manager, address currency) private {
        int256 delta = int256(uint256(manager.exttload(keccak256(abi.encode(address(this), currency)))));
        if (delta > 0) {
            manager.take(currency, address(this), uint256(delta));
        } else if (delta < 0) {
            manager.sync(currency);
            IntegrationToken(currency).transfer(address(manager), uint256(-delta));
            manager.settle();
        }
    }

    function _limit(bool zeroForOne, uint160 limit) private pure returns (uint160) {
        if (limit != 0) return limit;
        return zeroForOne ? MIN_LIMIT : MAX_LIMIT;
    }
}

/// @notice TEST ONLY. Adds liquidity to a v4 pool and pays for it.
contract IntegrationLiquidity {
    struct ModifyLiquidityParams {
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
    }

    address public immutable manager;

    constructor(address manager_) {
        manager = manager_;
    }

    function add(IV4PoolManagerMinimal.PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidity) external {
        IV4PoolManagerMinimal(manager).unlock(abi.encode(key, tickLower, tickUpper, liquidity));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == manager, "manager");
        (IV4PoolManagerMinimal.PoolKey memory key, int24 tickLower, int24 tickUpper, int256 liquidity) =
            abi.decode(data, (IV4PoolManagerMinimal.PoolKey, int24, int24, int256));
        (bool ok, bytes memory out) = manager.call(
            abi.encodeWithSignature(
                "modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)",
                key,
                ModifyLiquidityParams(tickLower, tickUpper, liquidity, bytes32(0)),
                bytes("")
            )
        );
        require(ok, "modifyLiquidity");
        (int256 delta,) = abi.decode(out, (int256, int256));
        _pay(key.currency0, int128(delta >> 128));
        _pay(key.currency1, int128(delta));
        return "";
    }

    function _pay(address currency, int128 delta) private {
        if (delta >= 0) return;
        IV4PoolManagerMinimal(manager).sync(currency);
        IntegrationToken(currency).transfer(manager, uint256(int256(-delta)));
        IV4PoolManagerMinimal(manager).settle();
    }
}

/// @notice TEST ONLY. A token hook's callee: calls the armed target with the
/// armed payload and records what happened, never reverting itself.
contract IntegrationProbe {
    address public target;
    bytes public payload;
    uint256 public calls;
    uint256 public successes;
    bytes4 public lastError;

    function arm(address target_, bytes calldata payload_) external {
        (target, payload) = (target_, payload_);
    }

    function fire() external {
        (bool ok, bytes memory out) = target.call(payload);
        ++calls;
        if (ok) ++successes;
        lastError = out.length >= 4 && !ok ? bytes4(out) : bytes4(0);
    }
}

/// @notice TEST ONLY. Installs the real Uniswap bytecode the journeys run on
/// and makes their helpers. Base (8453) v3 factory, NonfungiblePositionManager,
/// WETH9, v4 PoolManager, PositionManager and StateView (F1c fixtures, with the
/// storage their constructors wrote) and the Robinhood Permit2, PoolManager and
/// Universal Router 2.1.2 (F1b fixtures), each etched at its own address and
/// checked against the code hash api-contracts/v2/chains records.
contract IntegrationStage {
    IntegrationStageVm private constant vm = IntegrationStageVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function install() external returns (IntegrationChain memory chain) {
        _etch(UniswapBase8453.V3_FACTORY, UniswapBase8453.V3_FACTORY_ARTIFACT, UniswapBase8453.V3_FACTORY_CODEHASH);
        _etch(
            UniswapBase8453.V3_POSITION_MANAGER,
            UniswapBase8453.V3_POSITION_MANAGER_ARTIFACT,
            UniswapBase8453.V3_POSITION_MANAGER_CODEHASH
        );
        _etch(UniswapBase8453.WETH9, UniswapBase8453.WETH9_ARTIFACT, UniswapBase8453.WETH9_CODEHASH);
        _etch(
            UniswapBase8453.V4_POOL_MANAGER, UniswapBase8453.V4_POOL_MANAGER_ARTIFACT, UniswapBase8453.V4_POOL_MANAGER_CODEHASH
        );
        _etch(
            UniswapBase8453.V4_POSITION_MANAGER,
            UniswapBase8453.V4_POSITION_MANAGER_ARTIFACT,
            UniswapBase8453.V4_POSITION_MANAGER_CODEHASH
        );
        _etch(UniswapBase8453.V4_STATE_VIEW, UniswapBase8453.V4_STATE_VIEW_ARTIFACT, UniswapBase8453.V4_STATE_VIEW_CODEHASH);
        (address[] memory accounts, bytes32[] memory slots, bytes32[] memory values) =
            UniswapBase8453.constructorStorage();
        for (uint256 i; i < accounts.length; ++i) {
            vm.store(accounts[i], slots[i], values[i]);
        }
        _etch(RobinhoodPermit2.ADDRESS, "IntegrationArtifacts.sol:IntegrationRobinhoodPermit2", RobinhoodPermit2.CODEHASH);
        _etch(
            RobinhoodPoolManager.ADDRESS,
            "IntegrationArtifacts.sol:IntegrationRobinhoodPoolManager",
            RobinhoodPoolManager.CODEHASH
        );
        _etch(
            RobinhoodUniversalRouter212.ADDRESS,
            "IntegrationArtifacts.sol:IntegrationRobinhoodRouter",
            RobinhoodUniversalRouter212.CODEHASH
        );
        chain = IntegrationChain({
            v3Factory: UniswapBase8453.V3_FACTORY,
            v3PositionManager: UniswapBase8453.V3_POSITION_MANAGER,
            weth9: UniswapBase8453.WETH9,
            v4PoolManager: UniswapBase8453.V4_POOL_MANAGER,
            v4PositionManager: UniswapBase8453.V4_POSITION_MANAGER,
            v4StateView: UniswapBase8453.V4_STATE_VIEW,
            permit2: RobinhoodPermit2.ADDRESS,
            routerPoolManager: RobinhoodPoolManager.ADDRESS,
            router: RobinhoodUniversalRouter212.ADDRESS
        });
    }

    function token() external returns (address) {
        return address(new IntegrationToken());
    }

    function trader() external returns (address) {
        return address(new IntegrationTrader());
    }

    function liquidity(address poolManager) external returns (address) {
        return address(new IntegrationLiquidity(poolManager));
    }

    function probe() external returns (address) {
        return address(new IntegrationProbe());
    }

    /// The fixture's runtime, as its creation code returns it, at `target`.
    function _etch(address target, string memory artifact, bytes32 codehash) private {
        bytes memory init = vm.getCode(artifact);
        address deployed;
        assembly ("memory-safe") {
            deployed := create(0, add(init, 0x20), mload(init))
        }
        require(deployed != address(0) && deployed.codehash == codehash, "fixture code hash");
        vm.etch(target, deployed.code);
        require(target.codehash == codehash, "etched code hash");
    }
}
