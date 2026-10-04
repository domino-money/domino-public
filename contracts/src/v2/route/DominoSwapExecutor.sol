// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IDominoPositionActions} from "../interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../interfaces/IDominoRegistry.sol";
import {IUniswapV3PoolMinimal} from "../external/IUniswapV3Minimal.sol";
import {IV4PoolManagerMinimal} from "../external/IUniswapV4Minimal.sol";
import {DominoActionLock} from "./DominoActionLock.sol";
import {DominoTokenOps} from "./DominoTokenOps.sol";

/// @notice Permit2's AllowanceTransfer surface (Uniswap permit2,
/// IAllowanceTransfer), limited to what the executor uses.
interface IPermit2AllowanceMinimal {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
    function allowance(address user, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

/// @notice Executes DominoV2Types.SwapLeg[] for the contract that inherits it
/// (the zap, the vault) and accepts each leg by its effect on this contract,
/// never by its calldata:
/// - exactly amountIn of tokenIn leaves;
/// - at least minAmountOut of tokenOut arrives (measured, so a transfer tax
///   on the output counts against the floor);
/// - no other tracked balance moves;
/// - no allowance survives.
/// Leg kinds:
/// - LEG_UNIVERSAL_ROUTER: `data` is the calldata for `router`, which the
///   registry must admit (Universal Router 2.1.2 on the target chains). The
///   router pulls tokenIn through Permit2: this contract grants Permit2 an
///   ERC-20 allowance of exactly amountIn and the router a Permit2 allowance
///   of exactly amountIn that expires in this block; both must be spent. A
///   native input (tokenIn = address(0)) is sent as call value instead.
/// - LEG_V3_POOL: `data` is a Uniswap v3 path (token, fee, token, ...). Each
///   hop swaps exact input on the pool at CREATE2(factory, salt, init code
///   hash) from the chain profile; the callback must come from that pool,
///   inside that swap, and asks for exactly the hop's input. ERC-20s only.
/// - LEG_V4_POOL: `data` is abi.encode(PoolRef[]). One PoolManager unlock
///   swaps every hop (hooks allowed: only the swap touches the hooked pool),
///   requires each hop to consume its exact input, settles the input and takes
///   the output. Native currency is address(0).
/// `router` must be zero for pool legs. Legs are bound to the owner's intent
/// by routesHash = keccak256(abi.encode(legs)) (DominoV2Types.routesHash).
/// @dev The inheriting contract must run _executeLegs inside a nonReentrant
/// action and accept native ETH (receive) from the PoolManager and admitted
/// routers while a leg runs (see _swapInProgress). It must not implement
/// EIP-1271: an admitted router must never be able to obtain a Permit2
/// signature from it.
abstract contract DominoSwapExecutor is DominoActionLock {
    error InvalidRouteConfig();

    /// Per-chain configuration, from api-contracts/v2/chains. A zero v3Factory
    /// or v4PoolManager disables that leg kind on chains without it.
    struct RouteConfig {
        IDominoRegistry registry;
        address permit2;
        address v3Factory;
        bytes32 v3PoolInitCodeHash;
        address v4PoolManager;
    }

    /// One receipt line per executed leg; amounts are the measured effect.
    event SwapLegExecuted(
        uint8 indexed kind,
        address indexed tokenIn,
        address indexed tokenOut,
        address venue,
        uint256 amountIn,
        uint256 amountOut
    );

    uint256 internal constant MAX_LEGS = 8;
    uint256 internal constant MAX_HOPS = 4;

    /// Universal Router commands a leg may carry (Commands.sol of Universal
    /// Router 2.x), one bit per command: the v3, v2 and v4 swaps, a Permit2
    /// pull from this contract (bounded by the allowance below), payments out
    /// of the router's own balance (SWEEP, TRANSFER, PAY_PORTION), WETH
    /// wrapping and the ERC-20 balance check. Every other command is refused:
    /// above all the position managers' calls (V3_POSITION_MANAGER_PERMIT and
    /// _CALL, V4_POSITION_MANAGER_CALL), which the router authorises by its
    /// caller, this contract, so a leg could reach any position this contract
    /// is approved for; also a nested EXECUTE_SUB_PLAN, permits, and whatever
    /// a later router adds. Bit 0x80 of a command only lets it revert.
    uint256 private constant ROUTER_COMMANDS = 1 << 0x00 | 1 << 0x01 | 1 << 0x02 | 1 << 0x04 | 1 << 0x05 | 1 << 0x06
        | 1 << 0x08 | 1 << 0x09 | 1 << 0x0b | 1 << 0x0c | 1 << 0x0e | 1 << 0x10;
    uint256 private constant ALLOW_REVERT = 0x80;
    bytes4 private constant ROUTER_EXECUTE = 0x3593564c; // execute(bytes,bytes[],uint256)
    bytes4 private constant ROUTER_EXECUTE_NOW = 0x24856bc3; // execute(bytes,bytes[])

    uint160 private constant MIN_SQRT_PRICE_LIMIT = 4295128739 + 1;
    uint160 private constant MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970342 - 1;

    // keccak256("domino.v2.route.swapping") - 1
    bytes32 private constant SWAPPING_SLOT = 0xd67de005bf3c0d6ec498b8ba93f680d54b6984d1b06ddae9b1ec1cd73ed5f4d0;
    // keccak256("domino.v2.route.v3.pool") - 1
    bytes32 private constant V3_POOL_SLOT = 0x6ffa70dfe9c67f53e0e608b77d54c2c8a01c6f6b85273a5a13af37a870a94247;
    // keccak256("domino.v2.route.v3.payment") - 1: the hop's input token | zeroForOne << 160
    bytes32 private constant V3_PAYMENT_SLOT = 0x6d79cddbe67278c814da4a86500875f11a451fdb1ac0f957ec304027b48ed568;
    // keccak256("domino.v2.route.v3.amount") - 1
    bytes32 private constant V3_AMOUNT_SLOT = 0xd385aef72666ab40c991714261924ab9891309e06a6f9676d81e44d4a6620e6c;
    // keccak256("domino.v2.route.v4.callback") - 1: keccak256 of the pending unlock data
    bytes32 private constant V4_CALLBACK_SLOT = 0x352995b10f3f34519e63b18cdc1914ea769823e498193a8c7f7db00c92920efb;

    IDominoRegistry internal immutable ROUTE_REGISTRY;
    address internal immutable PERMIT2;
    address internal immutable V3_FACTORY;
    bytes32 internal immutable V3_POOL_INIT_CODE_HASH;
    address internal immutable V4_POOL_MANAGER;

    constructor(RouteConfig memory config) {
        if (address(config.registry).code.length == 0 || config.permit2.code.length == 0
            || (config.v3Factory != address(0)
                && (config.v3Factory.code.length == 0 || config.v3PoolInitCodeHash == bytes32(0)))
            || (config.v4PoolManager != address(0) && config.v4PoolManager.code.length == 0)) {
            revert InvalidRouteConfig();
        }
        ROUTE_REGISTRY = config.registry;
        PERMIT2 = config.permit2;
        V3_FACTORY = config.v3Factory;
        V3_POOL_INIT_CODE_HASH = config.v3PoolInitCodeHash;
        V4_POOL_MANAGER = config.v4PoolManager;
    }

    // ------------------------------------------------------------ executor
    /// @notice Executes `legs` in order and returns what each one delivered.
    /// @param extraTracked Tokens of the action besides the legs' own (pool
    /// currencies, inputs, the fee token) whose balance no leg may move.
    /// Every leg's tokenIn and tokenOut are tracked as well.
    function _executeLegs(DominoV2Types.SwapLeg[] memory legs, address[] memory extraTracked)
        internal
        returns (uint256[] memory amountsOut)
    {
        if (!_actionLocked() || _swapInProgress()) revert IDominoPositionActions.Unauthorized();
        uint256 count = legs.length;
        if (count > MAX_LEGS) revert IDominoPositionActions.InvalidPlan();
        amountsOut = new uint256[](count);
        if (count == 0) return amountsOut;
        address[] memory tracked = _trackedTokens(legs, extraTracked);
        uint256[] memory before = _balances(tracked);
        _setSwapping(1);
        for (uint256 i; i < count; ++i) {
            DominoV2Types.SwapLeg memory leg = legs[i];
            address venue = _runLeg(leg);
            uint256[] memory current = _balances(tracked);
            amountsOut[i] = _checkEffect(leg, tracked, before, current);
            before = current;
            emit SwapLegExecuted(leg.kind, leg.tokenIn, leg.tokenOut, venue, leg.amountIn, amountsOut[i]);
        }
        _setSwapping(0);
    }

    /// True while _executeLegs runs: a host's receive() may admit ETH only then.
    function _swapInProgress() internal view returns (bool swapping) {
        assembly ("memory-safe") {
            swapping := tload(SWAPPING_SLOT)
        }
    }

    // ---------------------------------------------------------- callbacks
    /// @notice Uniswap v3 swap callback: only the pool this contract is
    /// swapping on right now, for exactly the hop's input.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        address pool;
        uint256 payment;
        uint256 amount;
        assembly ("memory-safe") {
            pool := tload(V3_POOL_SLOT)
            payment := tload(V3_PAYMENT_SLOT)
            amount := tload(V3_AMOUNT_SLOT)
        }
        if (msg.sender != pool) revert IDominoPositionActions.Unauthorized(); // no swap: pool is zero
        assembly ("memory-safe") {
            tstore(V3_POOL_SLOT, 0)
        }
        bool zeroForOne = payment >> 160 != 0;
        if ((zeroForOne ? amount0Delta : amount1Delta) != int256(amount)) {
            revert IDominoPositionActions.SwapEffectMismatch();
        }
        DominoTokenOps.transfer(address(uint160(payment)), pool, amount);
    }

    /// @notice PoolManager unlock callback for LEG_V4_POOL. A host that also
    /// unlocks for itself overrides this and routes swap legs to
    /// _v4LegCallback while _v4LegPending() is true.
    function unlockCallback(bytes calldata data) external virtual returns (bytes memory) {
        return _v4LegCallback(data);
    }

    function _v4LegPending() internal view returns (bool pending) {
        assembly ("memory-safe") {
            pending := iszero(iszero(tload(V4_CALLBACK_SLOT)))
        }
    }

    function _v4LegCallback(bytes calldata data) internal returns (bytes memory) {
        bytes32 pending;
        assembly ("memory-safe") {
            pending := tload(V4_CALLBACK_SLOT)
        }
        if (msg.sender != V4_POOL_MANAGER || pending != keccak256(data)) revert IDominoPositionActions.Unauthorized();
        assembly ("memory-safe") {
            tstore(V4_CALLBACK_SLOT, 0)
        }
        (address tokenIn, address expectedOut, uint256 amountIn, DominoV2Types.PoolRef[] memory pools) =
            abi.decode(data, (address, address, uint256, DominoV2Types.PoolRef[]));
        (address tokenOut, uint256 amountOut) = _v4SwapPath(tokenIn, amountIn, pools);
        if (tokenOut != expectedOut) revert IDominoPositionActions.InvalidPlan();
        IV4PoolManagerMinimal manager = IV4PoolManagerMinimal(V4_POOL_MANAGER);
        manager.sync(tokenIn);
        uint256 paid;
        if (tokenIn == address(0)) {
            paid = manager.settle{value: amountIn}();
        } else {
            DominoTokenOps.transfer(tokenIn, address(manager), amountIn);
            paid = manager.settle();
        }
        if (paid != amountIn) revert IDominoPositionActions.SwapEffectMismatch();
        manager.take(tokenOut, address(this), amountOut);
        return "";
    }

    /// @notice Swaps exact input along `pools` inside an unlock that is already
    /// open, leaving the deltas for the caller to settle (a vault can net them
    /// against a liquidity change). Every hop must consume exactly its input,
    /// hook deltas included, and deliver a positive output.
    function _v4SwapPath(address tokenIn, uint256 amountIn, DominoV2Types.PoolRef[] memory pools)
        internal
        returns (address tokenOut, uint256 amountOut)
    {
        IV4PoolManagerMinimal manager = IV4PoolManagerMinimal(V4_POOL_MANAGER);
        (tokenOut, amountOut) = (tokenIn, amountIn);
        for (uint256 h; h < pools.length; ++h) {
            DominoV2Types.PoolRef memory pool = pools[h];
            bool zeroForOne = tokenOut == pool.currency0;
            if (pool.dex != DominoV2Types.DEX_V4 || (!zeroForOne && tokenOut != pool.currency1)
                || amountOut > uint256(uint128(type(int128).max))) revert IDominoPositionActions.InvalidPlan();
            int256 delta = manager.swap(
                IV4PoolManagerMinimal.PoolKey(pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks),
                IV4PoolManagerMinimal.SwapParams(
                    zeroForOne, -int256(amountOut), zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT
                ),
                ""
            );
            int128 amount0 = int128(delta >> 128);
            int128 amount1 = int128(delta);
            (int128 spent, int128 received) = zeroForOne ? (amount0, amount1) : (amount1, amount0);
            if (int256(spent) != -int256(amountOut) || received <= 0) {
                revert IDominoPositionActions.SwapEffectMismatch();
            }
            (tokenOut, amountOut) = (zeroForOne ? pool.currency1 : pool.currency0, uint256(int256(received)));
        }
    }

    // ------------------------------------------------------------ legs
    function _runLeg(DominoV2Types.SwapLeg memory leg) private returns (address venue) {
        if (leg.tokenIn == leg.tokenOut || leg.amountIn == 0 || leg.minAmountOut == 0) {
            revert IDominoPositionActions.InvalidPlan();
        }
        if (leg.kind == DominoV2Types.LEG_UNIVERSAL_ROUTER) return _callRouter(leg);
        if (leg.router != address(0)) revert IDominoPositionActions.InvalidPlan();
        if (leg.kind == DominoV2Types.LEG_V3_POOL) return _swapV3(leg);
        if (leg.kind == DominoV2Types.LEG_V4_POOL) return _swapV4(leg);
        revert IDominoPositionActions.InvalidPlan();
    }

    function _callRouter(DominoV2Types.SwapLeg memory leg) private returns (address router) {
        router = leg.router;
        if (ROUTE_REGISTRY.routerVersion(router) == 0) revert IDominoPositionActions.InvalidPlan();
        _checkRouterCommands(leg.data);
        address token = leg.tokenIn;
        bool native = token == address(0);
        if (!native) {
            DominoTokenOps.approve(token, PERMIT2, leg.amountIn);
            IPermit2AllowanceMinimal(PERMIT2).approve(token, router, uint160(leg.amountIn), uint48(block.timestamp));
        }
        (bool ok, bytes memory result) = router.call{value: native ? leg.amountIn : 0}(leg.data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
        if (!native) {
            (uint160 left,,) = IPermit2AllowanceMinimal(PERMIT2).allowance(address(this), token, router);
            if (left != 0 || DominoTokenOps.allowance(token, address(this), PERMIT2) != 0) {
                revert IDominoPositionActions.SwapEffectMismatch();
            }
        }
    }

    /// `data` must be execute(bytes commands, bytes[] inputs[, uint256 deadline])
    /// whose every command is in ROUTER_COMMANDS. The commands are read where
    /// the router's ABI decoder reads them, through the first argument's offset.
    function _checkRouterCommands(bytes memory data) private pure {
        uint256 size = data.length;
        uint256 head;
        uint256 offset;
        assembly ("memory-safe") {
            head := mload(add(data, 0x20))
            offset := mload(add(data, 0x24))
        }
        bytes4 selector = bytes4(bytes32(head));
        // The selector, the first argument's offset, then `commands` itself:
        // its length word at 4 + offset and its bytes right after, all inside.
        if (size < 0x24 || (selector != ROUTER_EXECUTE && selector != ROUTER_EXECUTE_NOW) || offset > size - 0x24) {
            revert IDominoPositionActions.InvalidPlan();
        }
        uint256 count;
        assembly ("memory-safe") {
            count := mload(add(add(data, 0x24), offset))
        }
        if (count > size - 0x24 - offset) revert IDominoPositionActions.InvalidPlan();
        for (uint256 i; i < count; ++i) {
            uint256 command;
            assembly ("memory-safe") {
                command := byte(0, mload(add(add(add(data, 0x44), offset), i)))
            }
            command &= ~ALLOW_REVERT;
            if ((ROUTER_COMMANDS >> command) & 1 == 0) revert IDominoPositionActions.InvalidPlan();
        }
    }

    function _swapV3(DominoV2Types.SwapLeg memory leg) private returns (address firstPool) {
        bytes memory path = leg.data;
        uint256 length = path.length;
        if (length < 43 || (length - 20) % 23 != 0 || (length - 20) / 23 > MAX_HOPS) {
            revert IDominoPositionActions.InvalidPlan();
        }
        uint256 hops = (length - 20) / 23;
        uint256 amount = leg.amountIn;
        address tokenIn;
        address tokenOut;
        for (uint256 h; h < hops; ++h) {
            uint24 fee;
            assembly ("memory-safe") {
                let hop := add(add(path, 0x20), mul(h, 23))
                tokenIn := shr(96, mload(hop))
                fee := shr(232, mload(add(hop, 20)))
                tokenOut := shr(96, mload(add(hop, 23)))
            }
            if (h == 0 && tokenIn != leg.tokenIn) revert IDominoPositionActions.InvalidPlan();
            address pool;
            (pool, amount) = _swapV3Hop(tokenIn, tokenOut, fee, amount);
            if (h == 0) firstPool = pool;
        }
        if (tokenOut != leg.tokenOut) revert IDominoPositionActions.InvalidPlan();
    }

    function _swapV3Hop(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        private
        returns (address pool, uint256 amountOut)
    {
        bool zeroForOne = tokenIn < tokenOut;
        (address token0, address token1) = zeroForOne ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        pool = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex"ff", V3_FACTORY, keccak256(abi.encode(token0, token1, fee)), V3_POOL_INIT_CODE_HASH
                        )
                    )
                )
            )
        );
        // No pool at the canonical address: a fee tier the factory lacks, a
        // zero or repeated token, the native currency (v3 uses WETH), or no
        // v3 on this chain (a zero factory).
        if (pool.code.length == 0) revert IDominoPositionActions.InvalidPlan();
        uint256 payment = uint256(uint160(tokenIn)) | (zeroForOne ? 1 << 160 : 0);
        assembly ("memory-safe") {
            tstore(V3_POOL_SLOT, pool)
            tstore(V3_PAYMENT_SLOT, payment)
            tstore(V3_AMOUNT_SLOT, amountIn)
        }
        uint256 held = DominoTokenOps.selfBalance(tokenOut);
        IUniswapV3PoolMinimal(pool).swap(
            address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT, ""
        );
        // What arrived feeds the next hop, not what the pool reports: a hop
        // token that delivers less (a tax on what pools send) is never made up
        // from this contract's own balance of it, which may be owed or another
        // account's. The leg's effect check is what accepts the result.
        amountOut = DominoTokenOps.selfBalance(tokenOut) - held;
    }

    function _swapV4(DominoV2Types.SwapLeg memory leg) private returns (address manager) {
        manager = V4_POOL_MANAGER;
        if (manager == address(0)) revert IDominoPositionActions.InvalidPlan();
        DominoV2Types.PoolRef[] memory pools = abi.decode(leg.data, (DominoV2Types.PoolRef[]));
        // An empty path ends where it starts, which the callback refuses as
        // not tokenOut (a leg's tokenIn and tokenOut always differ).
        if (pools.length > MAX_HOPS) revert IDominoPositionActions.InvalidPlan();
        bytes memory data = abi.encode(leg.tokenIn, leg.tokenOut, uint256(leg.amountIn), pools);
        bytes32 pending = keccak256(data);
        assembly ("memory-safe") {
            tstore(V4_CALLBACK_SLOT, pending)
        }
        IV4PoolManagerMinimal(manager).unlock(data);
    }

    // ------------------------------------------------------------ effects
    function _checkEffect(
        DominoV2Types.SwapLeg memory leg,
        address[] memory tracked,
        uint256[] memory before,
        uint256[] memory current
    ) private pure returns (uint256 amountOut) {
        for (uint256 j; j < tracked.length; ++j) {
            address token = tracked[j];
            if (token == leg.tokenIn) {
                if (current[j] + leg.amountIn != before[j]) revert IDominoPositionActions.SwapEffectMismatch();
            } else if (token == leg.tokenOut) {
                if (current[j] < before[j] + leg.minAmountOut) revert IDominoPositionActions.SwapEffectMismatch();
                amountOut = current[j] - before[j];
            } else if (current[j] != before[j]) {
                revert IDominoPositionActions.SwapEffectMismatch();
            }
        }
    }

    function _trackedTokens(DominoV2Types.SwapLeg[] memory legs, address[] memory extra)
        private
        pure
        returns (address[] memory tracked)
    {
        tracked = new address[](legs.length * 2 + extra.length);
        uint256 count;
        for (uint256 i; i < legs.length; ++i) {
            count = _include(tracked, count, legs[i].tokenIn);
            count = _include(tracked, count, legs[i].tokenOut);
        }
        for (uint256 i; i < extra.length; ++i) {
            count = _include(tracked, count, extra[i]);
        }
        assembly ("memory-safe") {
            mstore(tracked, count)
        }
    }

    function _include(address[] memory set, uint256 count, address token) private pure returns (uint256) {
        for (uint256 i; i < count; ++i) {
            if (set[i] == token) return count;
        }
        set[count] = token;
        return count + 1;
    }

    function _balances(address[] memory tokens) private view returns (uint256[] memory amounts) {
        amounts = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            amounts[i] = DominoTokenOps.selfBalance(tokens[i]);
        }
    }

    function _setSwapping(uint256 value) private {
        assembly ("memory-safe") {
            tstore(SWAPPING_SLOT, value)
        }
    }
}
