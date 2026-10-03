// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IUniswapV3PoolMinimal, IUniswapV3PositionManagerMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IV4PoolManagerMinimal, IV4StateViewMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IDominoVault, IDominoVaultFactory} from "../../../src/v2/interfaces/IDominoVault.sol";
import {DominoSwapExecutor, IPermit2AllowanceMinimal} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {DominoSwapFloor} from "../../../src/v2/route/DominoSwapFloor.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {IPositionNft, IZap, ZapTestBase} from "../zap/ZapTestKit.sol";
import {
    IntegrationChain,
    IntegrationChargeCurrency,
    IntegrationRegistryConfig,
    IntegrationVm,
    IIntegrationAnchor,
    IIntegrationLiquidity,
    IIntegrationProbe,
    IIntegrationStage,
    IIntegrationToken,
    IIntegrationTrader,
    IIntegrationV3Initializer,
    IIntegrationV4Initializer,
    IIntegrationVault
} from "./IntegrationInterfaces.sol";

/// Universal Router 2.1.2's v4 ExactInputSingleParams (v4-periphery with minHopPriceX36).
struct IntegrationExactInput {
    IV4PoolManagerMinimal.PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}

/// @notice The wired V2 world every journey runs in: the real registry and
/// price anchor configured through the timelock, the real zap (and v4 zap
/// steps), swap module, vault implementation with the executor its
/// constructor creates, factory and, in the auto-exit journeys, the auto-exit
/// module, all from their production artifacts, over the deployed Uniswap
/// bytecode of Base and the Robinhood Permit2 and Universal Router 2.1.2.
/// Only the currencies, the LP seed capital, the traders and the actors are
/// test helpers.
/// @dev Three currencies, sorted by address: `base` (no charge currency),
/// `quote` (rank 1) and `second` (rank 2). Three markets on the suite's DEX,
/// each a position pool (0.3%) and a deep pool for swap legs (0.05%):
/// `main` (base, quote) has the rank-1 currency as currency1, `inverse`
/// (quote, second) as currency0, `side` (base, second) has none. `thin` is a
/// 1% main pool with almost no liquidity, for a conversion that must miss the
/// anchor floor. The router's own PoolManager has the main deep pool.
abstract contract IntegrationWorld is ZapTestBase {
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant PUBLISHER_KEY = 0xB0B0CAFE;
    uint256 internal constant NEXT_PUBLISHER_KEY = 0xB0B0D00D;
    address internal constant OPERATOR = address(0x0BE7);
    address internal constant NEXT_OPERATOR = address(0x0BE8);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant FEE_RECIPIENT = address(0xFEE);
    address internal constant RELAYER = address(0xB0B);
    address internal constant STRANGER = address(0xBAD);
    uint32 internal constant TIMELOCK = 1 hours;
    uint32 internal constant ANCHOR_MAX_AGE = 300;
    uint32 internal constant ANCHOR_MIN_TWAP = 60;
    bytes32 internal constant BASE_V3_INIT_CODE_HASH =
        0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    string internal constant STAGE_ARTIFACT = "IntegrationArtifacts.sol:IntegrationStage";
    uint256 internal constant SEED = 1e22;
    uint256 internal constant DEEP_SEED = 1e25;
    uint256 internal constant THIN_SEED = 1e18;
    uint256 internal constant FUNDS = 1e30;
    uint256 internal constant ROOT_AMOUNT = 1e20;
    IntegrationVm internal constant cheats = IntegrationVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 internal constant FEES_COLLECTED = keccak256("FeesCollected(uint256,uint256,uint256)");
    bytes32 internal constant SWAPPED = keccak256("Swapped(uint256,bool,uint256,uint256)");

    struct Market {
        /// 0.3%, spacing 60: where positions live.
        DominoV2Types.PoolRef pool;
        /// 0.05%, spacing 10, deep: where swap legs go.
        DominoV2Types.PoolRef deep;
        /// v3 only: the position pool's address.
        address v3Pool;
    }

    /// One vault implementation, its constructor-created executor and its factory.
    struct VaultStack {
        address implementation;
        IDominoVaultFactory factory;
        address exitModule;
    }

    IIntegrationStage internal stage;
    IntegrationChain internal chain;
    IDominoRegistry internal registry;
    IIntegrationAnchor internal priceAnchor;
    IIntegrationToken internal base;
    IIntegrationToken internal quote;
    IIntegrationToken internal second;
    Market internal main;
    Market internal inverse;
    Market internal side;
    DominoV2Types.PoolRef internal thin;
    IIntegrationTrader internal trader;
    address internal owner;
    address internal manager;
    IZap internal zap;
    address internal swapModule;
    uint256 internal clock;

    /// The journey's vault, on `market`.
    Market internal market;
    VaultStack internal stack;
    IIntegrationVault internal vault;
    uint256 internal rootId;

    receive() external payable {}

    function _dex() internal pure virtual returns (uint8);
    function _zapArtifact() internal pure virtual returns (string memory);
    function _vaultArtifact() internal pure virtual returns (string memory);
    function _executorArtifact() internal pure virtual returns (string memory);

    function setUp() public virtual {
        _warp(NOW - TIMELOCK);
        vm.chainId(CHAIN);
        owner = vm.addr(OWNER_KEY);
        stage = IIntegrationStage(_deploy(vm.getCode(STAGE_ARTIFACT)));
        chain = stage.install();
        _makeCurrencies();
        _installGovernance();
        manager = _dex() == DominoV2Types.DEX_V3 ? chain.v3PositionManager : chain.v4PositionManager;
        trader = IIntegrationTrader(stage.trader());
        address[5] memory actors = [address(this), owner, RELAYER, address(trader), STRANGER];
        IIntegrationToken[3] memory currencies = [base, quote, second];
        for (uint256 i; i < actors.length; ++i) {
            for (uint256 j; j < 3; ++j) currencies[j].mint(actors[i], FUNDS);
            vm.deal(actors[i], 1e24);
        }
        _seedMarket(main, address(base), address(quote));
        _seedMarket(inverse, address(quote), address(second));
        _seedMarket(side, address(base), address(second));
        thin = DominoV2Types.PoolRef(_dex(), address(base), address(quote), 10_000, 200, address(0));
        if (_dex() == DominoV2Types.DEX_V3) _seedV3(thin, THIN_SEED);
        else _seedV4(chain.v4PoolManager, thin, THIN_SEED);
        // The deployed router settles with its own (Robinhood) PoolManager.
        _seedV4(chain.routerPoolManager, main.deep, DEEP_SEED);
        DominoSwapExecutor.RouteConfig memory route = _route();
        if (_dex() == DominoV2Types.DEX_V4) {
            address steps = _deploy(vm.getCode("DominoZapV4Steps.sol:DominoZapV4Steps"));
            zap = IZap(_deploy(abi.encodePacked(vm.getCode(_zapArtifact()), abi.encode(route, manager, steps))));
        } else {
            zap = IZap(_deploy(abi.encodePacked(vm.getCode(_zapArtifact()), abi.encode(route, manager))));
        }
        swapModule = _deploy(
            abi.encodePacked(vm.getCode("DominoV2VaultSwapModule.sol:DominoV2VaultSwapModule"), abi.encode(route))
        );
        _approveZap(owner);
        _approveZap(RELAYER);
        market = main;
    }

    // ============================================================ the world

    function _makeCurrencies() private {
        address[3] memory made = [stage.token(), stage.token(), stage.token()];
        for (uint256 i; i < 2; ++i) {
            for (uint256 j; j < 2 - i; ++j) {
                if (made[j] > made[j + 1]) (made[j], made[j + 1]) = (made[j + 1], made[j]);
            }
        }
        (base, quote, second) = (IIntegrationToken(made[0]), IIntegrationToken(made[1]), IIntegrationToken(made[2]));
    }

    /// The registry starts with no operator, publisher, router or charge
    /// currency; every one is admitted through the real timelock.
    function _installGovernance() private {
        IntegrationRegistryConfig memory config;
        config.governance = address(this);
        config.guardian = GUARDIAN;
        config.timelockSeconds = TIMELOCK;
        config.feeRecipient = FEE_RECIPIENT;
        registry = IDominoRegistry(_deploy(abi.encodePacked(vm.getCode("DominoRegistry.sol:DominoRegistry"), abi.encode(config))));
        priceAnchor = IIntegrationAnchor(
            _deploy(
                abi.encodePacked(
                    vm.getCode("DominoPriceAnchor.sol:DominoPriceAnchor"),
                    abi.encode(address(registry), chain.v3Factory, BASE_V3_INIT_CODE_HASH, chain.v4StateView, ANCHOR_MIN_TWAP)
                )
            )
        );
        bytes32[7] memory changes = [
            registry.scheduleChange(DominoV2Types.REGISTRY_OPERATOR, abi.encode(OPERATOR, true)),
            registry.scheduleChange(DominoV2Types.REGISTRY_PUBLISHER, abi.encode(vm.addr(PUBLISHER_KEY), true)),
            registry.scheduleChange(DominoV2Types.REGISTRY_ROUTER, abi.encode(chain.router, uint16(212))),
            registry.scheduleChange(DominoV2Types.REGISTRY_CHARGE_CURRENCY, abi.encode(address(quote), uint8(1))),
            registry.scheduleChange(DominoV2Types.REGISTRY_CHARGE_CURRENCY, abi.encode(address(second), uint8(2))),
            registry.scheduleChange(DominoV2Types.REGISTRY_CHARGE_CURRENCY, abi.encode(chain.weth9, uint8(2))),
            registry.scheduleChange(DominoV2Types.REGISTRY_CHARGE_CURRENCY, abi.encode(address(0), uint8(2)))
        ];
        _advance(TIMELOCK);
        for (uint256 i; i < changes.length; ++i) registry.executeChange(changes[i]);
    }

    function _seedMarket(Market storage m, address a, address b) private {
        (address currency0, address currency1) = _sorted(a, b);
        m.pool = DominoV2Types.PoolRef(_dex(), currency0, currency1, 3000, 60, address(0));
        m.deep = DominoV2Types.PoolRef(_dex(), currency0, currency1, 500, 10, address(0));
        if (_dex() == DominoV2Types.DEX_V3) {
            m.v3Pool = _seedV3(m.pool, SEED);
            _seedV3(m.deep, DEEP_SEED);
        } else {
            _seedV4(chain.v4PoolManager, m.pool, SEED);
            _seedV4(chain.v4PoolManager, m.deep, DEEP_SEED);
        }
    }

    function _seedV3(DominoV2Types.PoolRef memory ref, uint256 amount) private returns (address pool) {
        address npm = chain.v3PositionManager;
        pool = IIntegrationV3Initializer(npm).createAndInitializePoolIfNecessary(
            ref.currency0, ref.currency1, ref.fee, PRICE_ONE
        );
        IIntegrationToken(ref.currency0).approve(npm, type(uint256).max);
        IIntegrationToken(ref.currency1).approve(npm, type(uint256).max);
        int24 full = _fullRange(ref.tickSpacing);
        IUniswapV3PositionManagerMinimal(npm).mint(
            IUniswapV3PositionManagerMinimal.MintParams(
                ref.currency0, ref.currency1, ref.fee, -full, full, amount, amount, 0, 0, address(this), clock
            )
        );
    }

    function _seedV4(address poolManager, DominoV2Types.PoolRef memory ref, uint256 liquidity) private {
        IIntegrationLiquidity helper = IIntegrationLiquidity(stage.liquidity(poolManager));
        IIntegrationToken(ref.currency0).mint(address(helper), FUNDS);
        IIntegrationToken(ref.currency1).mint(address(helper), FUNDS);
        IIntegrationV4Initializer(poolManager).initialize(_key(ref), PRICE_ONE);
        int24 full = _fullRange(ref.tickSpacing);
        helper.add(_key(ref), -full, full, int256(liquidity));
    }

    function _fullRange(int24 spacing) private pure returns (int24) {
        return 887272 / spacing * spacing;
    }

    function _approveZap(address actor) internal {
        IIntegrationToken[3] memory currencies = [base, quote, second];
        vm.startPrank(actor);
        for (uint256 i; i < 3; ++i) {
            currencies[i].approve(address(zap), type(uint256).max);
            currencies[i].approve(PERMIT2, type(uint256).max);
        }
        vm.stopPrank();
    }

    function _route() internal view returns (DominoSwapExecutor.RouteConfig memory) {
        return DominoSwapExecutor.RouteConfig(
            registry, PERMIT2, chain.v3Factory, BASE_V3_INIT_CODE_HASH, chain.v4PoolManager
        );
    }

    // ================================================================ clock

    /// Every journey reads time from `clock`, never block.timestamp after a
    /// warp: via-IR may reuse a TIMESTAMP read across the cheatcode.
    function _warp(uint256 timestamp) internal {
        clock = timestamp;
        vm.warp(timestamp);
    }

    function _advance(uint256 elapsed) internal {
        _warp(clock + elapsed);
    }

    function _governed(bytes32 kind, bytes memory data) internal {
        bytes32 id = registry.scheduleChange(kind, data);
        _advance(TIMELOCK);
        registry.executeChange(id);
    }

    // =============================================================== prices

    function _key(DominoV2Types.PoolRef memory ref) internal pure returns (IV4PoolManagerMinimal.PoolKey memory) {
        return IV4PoolManagerMinimal.PoolKey(ref.currency0, ref.currency1, ref.fee, ref.tickSpacing, ref.hooks);
    }

    function _spot(Market memory m) internal view returns (uint160 price) {
        if (_dex() == DominoV2Types.DEX_V3) {
            (price,,,,,,) = IUniswapV3PoolMinimal(m.v3Pool).slot0();
        } else {
            (price,,,) = IV4StateViewMinimal(chain.v4StateView).getSlot0(keccak256(abi.encode(_key(m.pool))));
        }
    }

    /// Exact input on the market's position pool.
    function _trade(Market memory m, bool zeroForOne, uint256 amount) internal {
        if (_dex() == DominoV2Types.DEX_V3) trader.swapV3(m.v3Pool, zeroForOne, amount, 0);
        else trader.swapV4(chain.v4PoolManager, _key(m.pool), zeroForOne, amount, 0);
    }

    /// Moves the market's position pool to `target` (a real swap that stops at the limit).
    function _tradeTo(Market memory m, uint160 target) internal {
        bool zeroForOne = target < _spot(m);
        if (_dex() == DominoV2Types.DEX_V3) trader.swapV3(m.v3Pool, zeroForOne, 1e27, target);
        else trader.swapV4(chain.v4PoolManager, _key(m.pool), zeroForOne, 1e27, target);
        _eq(_spot(m), target, "pool moved to the target price");
    }

    /// The pool's whole fee for a swap direction, as the vault and the module read it.
    function _poolFeePips(Market memory m, bool zeroForOne) internal view returns (uint24) {
        if (_dex() == DominoV2Types.DEX_V3) return m.pool.fee;
        (,, uint24 protocolFee, uint24 lpFee) =
            IV4StateViewMinimal(chain.v4StateView).getSlot0(keccak256(abi.encode(_key(m.pool))));
        return DominoSwapFloor.v4SwapFeePips(protocolFee, lpFee, zeroForOne);
    }

    /// The vault's swap floor for `amountIn` at `price`: its pool's fee and the owner's slippage excluded.
    function _floor(Market memory m, uint128 amountIn, uint160 price, bool zeroForOne, uint16 slippageBps)
        internal
        view
        returns (uint128)
    {
        return uint128(DominoSwapFloor.minimumOutput(amountIn, price, zeroForOne, _poolFeePips(m, zeroForOne), slippageBps));
    }

    /// `sqrtPrice` with its price (its square) scaled by (10000 + bps) / 10000, rounded down.
    function _scaled(uint160 sqrtPrice, uint256 bpsNumerator) internal pure returns (uint160) {
        return uint160(_sqrt(uint256(sqrtPrice) * sqrtPrice * bpsNumerator / 10_000));
    }

    /// The highest sqrt price the anchor still accepts above `spot` with a
    /// band of `bandBps`: the largest a with a^2 * 10000 <= spot^2 * (10000 + band).
    function _bandEdge(uint160 spot, uint16 bandBps) internal pure returns (uint160) {
        return _scaled(spot, 10_000 + uint256(bandBps));
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        y = x;
        uint256 z = (x + 1) / 2;
        while (z < y) (y, z) = (z, (x / z + z) / 2);
    }

    // ============================================================= evidence

    function _observation(DominoV2Types.PoolRef memory pool, uint160 price)
        internal
        view
        returns (DominoV2Types.PriceObservation memory)
    {
        return DominoV2Types.PriceObservation(pool, price, uint64(clock), uint64(clock + ANCHOR_MAX_AGE), 1);
    }

    function _evidence(DominoV2Types.PoolRef memory pool, uint160 price) internal view returns (bytes memory) {
        return _evidenceBy(PUBLISHER_KEY, pool, price);
    }

    function _evidenceBy(uint256 key, DominoV2Types.PoolRef memory pool, uint160 price)
        internal
        view
        returns (bytes memory)
    {
        DominoV2Types.PriceObservation memory point = _observation(pool, price);
        return abi.encode(point, _signature(key, priceAnchor.hashObservation(point)));
    }

    // ================================================================= legs

    /// A direct pool leg through `ref` (a v3 path or a v4 PoolRef[]).
    function _poolLeg(DominoV2Types.PoolRef memory ref, address tokenIn, address tokenOut, uint128 amountIn, uint128 minOut)
        internal
        pure
        returns (DominoV2Types.SwapLeg memory)
    {
        bytes memory path;
        if (ref.dex == DominoV2Types.DEX_V3) {
            path = abi.encodePacked(tokenIn, ref.fee, tokenOut);
        } else {
            DominoV2Types.PoolRef[] memory refs = new DominoV2Types.PoolRef[](1);
            refs[0] = ref;
            path = abi.encode(refs);
        }
        uint8 kind = ref.dex == DominoV2Types.DEX_V3 ? DominoV2Types.LEG_V3_POOL : DominoV2Types.LEG_V4_POOL;
        return DominoV2Types.SwapLeg(kind, address(0), tokenIn, tokenOut, amountIn, minOut, path);
    }

    /// A leg through a market's deep pool, at most 2% under a 1:1 price.
    function _deepLeg(Market memory m, address tokenIn, address tokenOut, uint128 amountIn)
        internal
        pure
        returns (DominoV2Types.SwapLeg memory)
    {
        return _poolLeg(m.deep, tokenIn, tokenOut, amountIn, amountIn * 98 / 100);
    }

    /// A Universal Router 2.1.2 V4_SWAP of the main deep pool on the router's own PoolManager.
    function _routerLeg(address tokenIn, address tokenOut, uint128 amount)
        internal
        view
        returns (DominoV2Types.SwapLeg memory)
    {
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IntegrationExactInput(_key(main.deep), tokenIn == main.deep.currency0, amount, 0, 0, "")
        );
        params[1] = abi.encode(tokenIn, uint256(amount));
        params[2] = abi.encode(tokenOut, uint256(0));
        bytes[] memory inputs = new bytes[](1);
        // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL inside one V4_SWAP command.
        inputs[0] = abi.encode(hex"060c0f", params);
        return DominoV2Types.SwapLeg(
            DominoV2Types.LEG_UNIVERSAL_ROUTER,
            chain.router,
            tokenIn,
            tokenOut,
            amount,
            amount * 98 / 100,
            abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"10", inputs, clock + 600)
        );
    }

    function _twoLegs(DominoV2Types.SwapLeg memory first, DominoV2Types.SwapLeg memory then)
        internal
        pure
        returns (DominoV2Types.SwapLeg[] memory legs)
    {
        legs = new DominoV2Types.SwapLeg[](2);
        (legs[0], legs[1]) = (first, then);
    }

    // ============================================================ positions

    function _liquidity(uint256 id) internal view returns (uint128 value) {
        if (_dex() == DominoV2Types.DEX_V3) {
            (,,,,,,, value,,,,) = IUniswapV3PositionManagerMinimal(manager).positions(id);
        } else {
            (bool ok, bytes memory out) = manager.staticcall(abi.encodeWithSignature("getPositionLiquidity(uint256)", id));
            _check(ok, "v4 position liquidity");
            value = abi.decode(out, (uint128));
        }
    }

    /// The owner mints a position on `m` through the zap, both currencies, no swap.
    function _mintPosition(Market memory m, int24 lower, int24 upper, uint256 nonce) internal returns (uint256 id) {
        IDominoPositionActions.CreatePlan memory p;
        p.inputs = new DominoV2Types.TokenAmount[](2);
        p.inputs[0] = DominoV2Types.TokenAmount(m.pool.currency0, uint128(ROOT_AMOUNT));
        p.inputs[1] = DominoV2Types.TokenAmount(m.pool.currency1, uint128(ROOT_AMOUNT));
        p.legs = _noLegs();
        p.intent = _intent(DominoV2Types.ACTION_CREATE, m.pool, 0, lower, upper, 1, p.legs, address(0), owner, nonce);
        p.amount0Max = type(uint128).max;
        p.amount1Max = type(uint128).max;
        vm.prank(owner);
        id = zap.create(p).tokenId;
    }

    // ================================================================ vault

    /// A vault implementation for this DEX wired to this world and to
    /// `exitModule`, and the factory it was built for (at the address the
    /// implementation's constructor was given).
    function _vaultStack(address exitModule) internal returns (VaultStack memory s) {
        address predictedFactory = cheats.computeCreateAddress(address(this), cheats.getNonce(address(this)) + 1);
        DominoV2VaultStorage.Deployment memory deployment = DominoV2VaultStorage.Deployment(
            predictedFactory, address(registry), address(priceAnchor), manager, swapModule, exitModule
        );
        s.implementation = _deploy(abi.encodePacked(vm.getCode(_vaultArtifact()), abi.encode(deployment)));
        s.factory = IDominoVaultFactory(
            _deploy(abi.encodePacked(vm.getCode("DominoV2VaultFactory.sol:DominoV2VaultFactory"), abi.encode(s.implementation)))
        );
        _check(address(s.factory) == predictedFactory, "factory at the address its implementation names");
        s.exitModule = exitModule;
    }

    /// The owner approves the predicted clone, creates it and keeps the root.
    function _openVault(VaultStack memory s, Market memory m, uint8 mode, int24 lower, int24 upper)
        internal
        returns (IIntegrationVault opened, uint256 id)
    {
        id = _mintPosition(m, lower, upper, 0);
        uint256 nonce = s.factory.nextNonce(owner);
        address predicted = s.factory.predictVault(owner, nonce);
        vm.prank(owner);
        IPositionNft(manager).approve(predicted, id);
        IDominoVault.Init memory init = IDominoVault.Init(
            DominoV2Types.PositionRef(_dex(), manager, id),
            IDominoVault.Policy(mode, 500, 2000, 60, mode == DominoV2Types.MODE_SIMPLE ? 1 : 3),
            IDominoVault.Limits(100, 200, ANCHOR_MAX_AGE, 5000),
            false,
            true
        );
        vm.prank(owner);
        opened = IIntegrationVault(s.factory.createVault(init, nonce));
        _check(address(opened) == predicted && s.factory.isVault(predicted), "clone at the predicted CREATE2 address");
        _check(IPositionNft(manager).ownerOf(id) == owner && opened.rootArmed(), "the owner keeps the armed root");
        // The clone is the factory's EIP-1167 proxy to this stack's
        // implementation, and what it runs is wired to this world.
        _check(
            keccak256(address(opened).code)
                == keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73", s.implementation, hex"5af43d82803e903d91602b57fd5bf3")),
            "minimal proxy to the stack's implementation"
        );
        DominoV2VaultStorage.Deployment memory wired = opened.wiring();
        _check(
            wired.factory == address(s.factory) && wired.registry == address(registry)
                && wired.priceAnchor == address(priceAnchor) && wired.positionManager == manager
                && wired.swapModule == swapModule && wired.autoExit == s.exitModule,
            "clone wired to this world's components"
        );
        // A contract's first CREATE is at nonce 1: the executor is the one the
        // implementation's constructor made.
        _check(opened.executor() == cheats.computeCreateAddress(s.implementation, 1), "constructor-created executor");
    }

    function _createVault(Market memory m, uint8 mode, int24 lower, int24 upper) internal {
        market = m;
        (vault, rootId) = _openVault(stack, m, mode, lower, upper);
    }

    /// A compound of the root from its own fees, anchored at the current spot.
    function _plan() internal view returns (Plan.PlanV1 memory p) {
        p.action = Plan.ACTION_COMPOUND;
        p.stateNonce = vault.stateNonce();
        p.deadline = uint64(clock + 600);
        p.target = rootId;
        p.amount0Max = type(uint128).max;
        p.amount1Max = type(uint128).max;
        p.minLiquidity = 1;
        p.collect = new uint256[](1);
        p.collect[0] = rootId;
        p.budgets = new Plan.Budget[](1);
        p.budgets[0] = Plan.Budget(rootId, type(uint128).max, type(uint128).max);
        p.anchorEvidence = _evidence(market.pool, _spot(market));
    }

    function _execute(Plan.PlanV1 memory p) internal returns (bytes32) {
        vm.prank(OPERATOR);
        return vault.execute(Plan.encode(p));
    }

    /// Trading fees for every position in the market's pool, both directions.
    function _accrueFees(Market memory m) internal {
        _trade(m, true, 1e19);
        _trade(m, false, 1e19);
    }

    // =========================================================== invariants

    /// The zap holds only backed debt, no native currency and no allowance.
    function _cleanZap() internal view {
        address[3] memory currencies = [address(base), address(quote), address(second)];
        for (uint256 i; i < 3; ++i) {
            _eq(_balance(currencies[i], address(zap)), zap.owedFees(currencies[i]), "zap holds only backed debt");
            _eq(_allowance(currencies[i], address(zap), manager), 0, "zap manager allowance cleared");
            _eq(_allowance(currencies[i], address(zap), PERMIT2), 0, "zap Permit2 allowance cleared");
            (uint160 permitted,,) = IPermit2AllowanceMinimal(PERMIT2).allowance(address(zap), currencies[i], chain.router);
            _eq(permitted, 0, "zap router allowance cleared");
        }
        _eq(address(zap).balance, 0, "zap holds no native currency");
    }

    /// The vault's balances are its ledger (reserves plus backed debt) and it
    /// leaves no allowance; the zap is clean too.
    function _ledgerBalanced() internal view {
        _cleanZap();
        address[3] memory currencies = [address(base), address(quote), address(second)];
        for (uint256 i; i < 3; ++i) {
            address token = currencies[i];
            bool pooled = token == market.pool.currency0 || token == market.pool.currency1;
            uint256 accounted = pooled ? vault.reserves(token) + vault.owedFees(token) : 0;
            _eq(_balance(token, address(vault)), accounted, "vault balance is its ledger");
            _eq(_allowance(token, address(vault), manager), 0, "vault manager allowance cleared");
            _eq(_allowance(token, address(vault), PERMIT2), 0, "vault Permit2 allowance cleared");
            (uint160 permitted,,) = IPermit2AllowanceMinimal(PERMIT2).allowance(address(vault), token, chain.router);
            _eq(permitted, 0, "vault router allowance cleared");
        }
    }

    /// Amounts of each currency an account holds, in [base, quote, second] order.
    function _holdings(address account) internal view returns (uint256[3] memory amounts) {
        amounts = [base.balanceOf(account), quote.balanceOf(account), second.balanceOf(account)];
    }

    function _probe() internal returns (IIntegrationProbe) {
        return IIntegrationProbe(stage.probe());
    }
}
