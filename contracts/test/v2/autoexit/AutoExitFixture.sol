// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {DominoAutoExit} from "../../../src/v2/autoexit/DominoAutoExit.sol";
import {IV4PoolManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {IDominoAutoExit} from "../../../src/v2/interfaces/IDominoAutoExit.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {RobinhoodPermit2} from "../route/fixtures/RobinhoodPermit2.sol";
import {ScriptedRouter, scriptedCall} from "../route/RouteAdversaries.sol";
import {IV4PoolManagerTest, V4LiquidityHelper} from "../route/V2RouteTestKit.sol";
import {V2VendoredFixtures} from "../route/V2VendoredFixtures.sol";
import {MockPriceAnchor, MockRegistry, MockToken, MockVault} from "./AutoExitMocks.sol";

/// Foundry cheatcodes these suites use; no forge-std dependency.
interface VmAutoExit {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 chain) external;
    function deal(address account, uint256 amount) external;
    function etch(address target, bytes calldata code) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external returns (address);
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
    function expectCall(address callee, bytes calldata data) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// The world every auto-exit suite starts from: a registry with one operator,
/// one publisher and an admitted router; an anchor; Permit2 (Robinhood's
/// runtime) and the vendored v4 PoolManager with a real pool for the vault's
/// pair and for native/token1; the module wired to them as F1b's executor
/// expects; a vault that enabled it, holding one position whose token1 is
/// the first charge currency and whose token0 is not one; the anchor at the
/// stop price.
abstract contract AutoExitFixture {
    VmAutoExit internal constant vm = VmAutoExit(address(uint160(uint256(keccak256("hevm cheat code")))));

    error Mismatch(string what, uint256 actual, uint256 expected);
    error Unexpected(string what);

    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant PUBLISHER_KEY = 0xB0B;
    uint256 internal constant OTHER_KEY = 0xBAD;
    address internal constant OPERATOR = address(0x0FE7);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant FEE_RECIPIENT = address(0xFEE0);
    address internal constant STRANGER = address(0x5757);
    uint32 internal constant MAX_AGE = 300;
    uint32 internal constant MIN_TWAP = 600;
    uint64 internal constant START = 1_800_000_000;
    uint256 internal constant TOKEN_ID = 3409682;
    uint160 internal constant Q96 = uint160(1 << 96);
    /// sqrt price 2 * 2^96: one token0 is worth four token1.
    uint160 internal constant STOP = 2 * Q96;
    uint256 internal constant HELD0 = 1e18;
    uint256 internal constant HELD1 = 4e18;
    int24 internal constant FULL_RANGE = 887220;

    address internal owner;
    address internal publisher;
    MockRegistry internal registry;
    MockPriceAnchor internal anchor;
    ScriptedRouter internal router;
    IV4PoolManagerTest internal manager;
    V4LiquidityHelper internal liquidity;
    DominoAutoExit internal autoExit;
    MockToken internal token0;
    MockToken internal token1;
    MockVault internal vault;
    DominoV2Types.PoolRef internal pool;

    function setUp() public virtual {
        vm.chainId(4663);
        vm.warp(START);
        vm.etch(PERMIT2, RobinhoodPermit2.RUNTIME);
        owner = vm.addr(OWNER_KEY);
        publisher = vm.addr(PUBLISHER_KEY);
        registry = new MockRegistry(GUARDIAN);
        registry.setOperator(OPERATOR, true);
        registry.setPublisher(publisher, true);
        registry.setFeeRecipient(FEE_RECIPIENT);
        anchor = new MockPriceAnchor(address(registry));
        router = new ScriptedRouter(PERMIT2);
        registry.setRouter(address(router), 212);
        manager = IV4PoolManagerTest(address(V2VendoredFixtures.deployPoolManager(address(this))));
        liquidity = new V4LiquidityHelper(address(manager));
        autoExit = _deployModule();
        MockToken a = new MockToken();
        MockToken b = new MockToken();
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        registry.setChargeCurrency(address(token1), 1);
        token0.mint(address(liquidity), 1e30);
        token1.mint(address(liquidity), 1e30);
        vm.deal(address(liquidity), 1e27);
        pool = _v4Pool(address(token0), address(token1), 3000, 60);
        _v4Pool(address(0), address(token1), 3000, 60);
        vault = _newVault(pool, HELD0, HELD1);
        anchor.setSpot(pool, STOP);
    }

    function _deployModule() internal returns (DominoAutoExit) {
        return new DominoAutoExit(
            DominoSwapExecutor.RouteConfig(IDominoRegistry(address(registry)), PERMIT2, address(0), bytes32(0), address(manager)),
            address(anchor),
            MAX_AGE,
            MIN_TWAP
        );
    }

    // ------------------------------------------------------------ world
    function _poolOf(uint8 dex, address currency0, address currency1)
        internal
        pure
        returns (DominoV2Types.PoolRef memory)
    {
        return DominoV2Types.PoolRef({
            dex: dex,
            currency0: currency0,
            currency1: currency1,
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
    }

    /// A v4 pool on the vendored PoolManager at the stop price, with deep
    /// full-range liquidity.
    function _v4Pool(address currency0, address currency1, uint24 fee, int24 spacing)
        internal
        returns (DominoV2Types.PoolRef memory ref)
    {
        ref = DominoV2Types.PoolRef({
            dex: DominoV2Types.DEX_V4,
            currency0: currency0,
            currency1: currency1,
            fee: fee,
            tickSpacing: spacing,
            hooks: address(0)
        });
        IV4PoolManagerMinimal.PoolKey memory key =
            IV4PoolManagerMinimal.PoolKey(currency0, currency1, fee, spacing, address(0));
        manager.initialize(key, STOP);
        int24 edge = FULL_RANGE / spacing * spacing;
        liquidity.add(key, -edge, edge, 1e21);
    }

    /// A vault owned by `owner`, with the module enabled and TOKEN_ID holding
    /// the given amounts (principal plus fees, as the removal will return them).
    function _newVault(DominoV2Types.PoolRef memory ref, uint256 amount0, uint256 amount1)
        internal
        returns (MockVault created)
    {
        created = new MockVault(owner, address(registry), ref);
        created.setPosition(TOKEN_ID, amount0, amount1);
        _fund(ref.currency0, address(created), amount0);
        _fund(ref.currency1, address(created), amount1);
        vm.prank(owner);
        created.setExitModule(address(autoExit));
    }

    function _fund(address token, address to, uint256 amount) internal {
        if (token == address(0)) vm.deal(to, to.balance + amount);
        else MockToken(token).mint(to, amount);
    }

    // --------------------------------------------------------- mandates
    function _mandate() internal view returns (DominoV2Types.ExitMandate memory) {
        return DominoV2Types.ExitMandate({
            owner: owner,
            vault: address(vault),
            tokenId: TOKEN_ID,
            triggerBelowSqrtPriceX96: STOP,
            triggerAboveSqrtPriceX96: 0,
            receiveMode: DominoV2Types.RECEIVE_BOTH,
            convertTo: address(0),
            maxSlippageBps: 100,
            validUntil: START + 30 days,
            nonce: 1
        });
    }

    function _converted(address target) internal view returns (DominoV2Types.ExitMandate memory mandate) {
        mandate = _mandate();
        mandate.receiveMode = DominoV2Types.RECEIVE_CONVERTED;
        mandate.convertTo = target;
    }

    function _digest(DominoV2Types.ExitMandate memory mandate) internal view returns (bytes32) {
        return DominoV2Types.digest(autoExit.domainSeparator(), DominoV2Types.hashExitMandate(mandate));
    }

    function _signDigest(uint256 key, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sign(DominoV2Types.ExitMandate memory mandate, uint256 key) internal returns (bytes memory) {
        return _signDigest(key, _digest(mandate));
    }

    function _register(DominoV2Types.ExitMandate memory mandate) internal returns (bytes32) {
        return autoExit.registerMandate(mandate, _sign(mandate, OWNER_KEY));
    }

    // -------------------------------------------------------- execution
    function _observation(DominoV2Types.PoolRef memory ref, uint160 price) internal returns (bytes memory) {
        return _observationAt(ref, price, uint64(block.timestamp), uint64(block.timestamp) + MAX_AGE);
    }

    function _observationAt(DominoV2Types.PoolRef memory ref, uint160 price, uint64 observedAt, uint64 validUntil)
        internal
        returns (bytes memory)
    {
        return _observationBy(PUBLISHER_KEY, ref, price, observedAt, validUntil);
    }

    function _observationBy(
        uint256 key,
        DominoV2Types.PoolRef memory ref,
        uint160 price,
        uint64 observedAt,
        uint64 validUntil
    ) internal returns (bytes memory) {
        DominoV2Types.PriceObservation memory point = DominoV2Types.PriceObservation({
            pool: ref,
            sqrtPriceX96: price,
            observedAt: observedAt,
            validUntil: validUntil,
            nonce: 1
        });
        bytes32 digest = DominoV2Types.digest(anchor.domainSeparator(), DominoV2Types.hashPriceObservation(point));
        return abi.encode(point, _signDigest(key, digest));
    }

    function _plan(bytes memory evidence) internal pure returns (IDominoAutoExit.Execution memory execution) {
        execution.anchorEvidence = evidence;
    }

    function _plan(bytes memory evidence, DominoV2Types.SwapLeg[] memory legs)
        internal
        pure
        returns (IDominoAutoExit.Execution memory execution)
    {
        execution.anchorEvidence = evidence;
        execution.legs = legs;
    }

    function _execute(bytes32 mandateHash, IDominoAutoExit.Execution memory execution)
        internal
        returns (uint256 amount0, uint256 amount1)
    {
        vm.prank(OPERATOR);
        return autoExit.execute(mandateHash, execution);
    }

    /// A Universal Router leg through the scripted router, which pulls exactly
    /// amountIn through Permit2 (or takes it as value) and pays `pay`.
    function _routerLeg(address tokenIn, address tokenOut, uint256 amountIn, uint256 pay)
        internal
        returns (DominoV2Types.SwapLeg memory)
    {
        ScriptedRouter.Script memory script;
        script.tokenIn = tokenIn;
        script.pull = tokenIn == address(0) ? 0 : amountIn;
        script.tokenOut = tokenOut;
        script.pay = pay;
        _fund(tokenOut, address(router), pay);
        return _routerLegWith(tokenIn, tokenOut, amountIn, script);
    }

    function _routerLegWith(address tokenIn, address tokenOut, uint256 amountIn, ScriptedRouter.Script memory script)
        internal
        view
        returns (DominoV2Types.SwapLeg memory)
    {
        return DominoV2Types.SwapLeg({
            kind: DominoV2Types.LEG_UNIVERSAL_ROUTER,
            router: address(router),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: uint128(amountIn),
            minAmountOut: 1,
            data: scriptedCall(script)
        });
    }

    /// A v4 pool leg along `path`; amountIn zero takes what remains.
    function _poolLeg(address tokenIn, address tokenOut, uint256 amountIn, DominoV2Types.PoolRef memory hop)
        internal
        pure
        returns (DominoV2Types.SwapLeg memory)
    {
        DominoV2Types.PoolRef[] memory path = new DominoV2Types.PoolRef[](1);
        path[0] = hop;
        return DominoV2Types.SwapLeg({
            kind: DominoV2Types.LEG_V4_POOL,
            router: address(0),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: uint128(amountIn),
            minAmountOut: 1,
            data: abi.encode(path)
        });
    }

    function _legs(DominoV2Types.SwapLeg memory leg) internal pure returns (DominoV2Types.SwapLeg[] memory legs) {
        legs = new DominoV2Types.SwapLeg[](1);
        legs[0] = leg;
    }

    // --------------------------------------------------------- asserts
    function _eq(uint256 actual, uint256 expected, string memory what) internal pure {
        if (actual != expected) revert Mismatch(what, actual, expected);
    }

    function _eq(address actual, address expected, string memory what) internal pure {
        if (actual != expected) revert Mismatch(what, uint160(actual), uint160(expected));
    }

    function _eq(bytes32 actual, bytes32 expected, string memory what) internal pure {
        if (actual != expected) revert Mismatch(what, uint256(actual), uint256(expected));
    }

    function _true(bool condition, string memory what) internal pure {
        if (!condition) revert Unexpected(what);
    }

    /// Logs from `emitter` whose first topic is `topic`.
    function _count(VmAutoExit.Log[] memory logs, address emitter, bytes32 topic) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length != 0 && logs[i].topics[0] == topic) n += 1;
        }
    }
}
