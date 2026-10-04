// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IUniswapV3PoolMinimal, IUniswapV3PositionManagerMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IV4PoolManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {IDominoAutoExit} from "../../../src/v2/interfaces/IDominoAutoExit.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {FullMath} from "../../../src/v2/positions/uniswap/FullMath.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {MockERC1271Wallet, MockToken, MockVault} from "../autoexit/AutoExitMocks.sol";
import {ScriptedRouter, scriptedCall} from "../route/RouteAdversaries.sol";
import {IV4PoolManagerTest, V4LiquidityHelper} from "../route/V2RouteTestKit.sol";
import {
    IIntegrationAnchor,
    IIntegrationAutoExit,
    IIntegrationStage,
    IIntegrationTrader,
    IIntegrationV3Initializer,
    IntegrationChain,
    IntegrationChargeCurrency,
    IntegrationRegistryConfig
} from "../integration/IntegrationInterfaces.sol";

/// Foundry cheatcodes the adversarial auto-exit suites use; no forge-std.
interface AdvVm {
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
    function getCode(string calldata artifact) external view returns (bytes memory);
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
    function expectCall(address callee, bytes calldata data) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// Exact-input swaps on a v4 PoolManager that stop at a price limit, native
/// currency included (the integration trader settles ERC-20s only).
contract AdvV4Trader {
    address private _pending;

    receive() external payable {}

    function swap(
        address manager,
        IV4PoolManagerMinimal.PoolKey calldata key,
        bool zeroForOne,
        uint256 amountIn,
        uint160 limit
    ) external {
        _pending = manager;
        IV4PoolManagerMinimal(manager).unlock(abi.encode(key, zeroForOne, amountIn, limit));
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
            if (currency == address(0)) {
                manager.settle{value: uint256(-delta)}();
            } else {
                MockToken(currency).transfer(address(manager), uint256(-delta));
                manager.settle();
            }
        }
    }
}

/// A vault the owner signs for that no factory made (F4, "A vault the owner
/// signs for need not come from the factory"). It answers the module's three
/// reads (owner, exitModule, pool) however it is told, and its executeExit
/// pays what it chooses, reports anything, gifts other currencies, tries to
/// pull the module's balances and calls back into whatever it is pointed at.
contract HostileExitVault {
    address public owner;
    address public exitModule;
    DominoV2Types.PoolRef private _pool;

    uint256 public pay0;
    uint256 public pay1;
    uint256 public report0;
    uint256 public report1;
    uint256 public giftNative;
    address public giftToken;
    uint256 public giftAmount;
    address public pullToken;
    uint256 public pullAmount;
    bool public pullSucceeded;
    address public callTarget;
    bytes public callData;
    bool public callAttempted;
    bool public callOk;
    bytes public callResult;
    uint256 public exits;

    constructor(address owner_, DominoV2Types.PoolRef memory pool_) {
        owner = owner_;
        _pool = pool_;
    }

    receive() external payable {}

    function setOwner(address next) external {
        owner = next;
    }

    function setPool(DominoV2Types.PoolRef memory next) external {
        _pool = next;
    }

    function setExitModule(address module) external {
        require(msg.sender == owner, "owner");
        exitModule = module;
    }

    function setPayments(uint256 amount0, uint256 amount1, uint256 reported0, uint256 reported1) external {
        (pay0, pay1, report0, report1) = (amount0, amount1, reported0, reported1);
    }

    function setGifts(uint256 native, address token, uint256 amount) external {
        (giftNative, giftToken, giftAmount) = (native, token, amount);
    }

    function setPull(address token, uint256 amount) external {
        (pullToken, pullAmount) = (token, amount);
    }

    function setCall(address target, bytes calldata data) external {
        (callTarget, callData) = (target, data);
    }

    function pool() external view returns (DominoV2Types.PoolRef memory) {
        return _pool;
    }

    function executeExit(uint256, bytes calldata) external returns (uint256, uint256) {
        require(msg.sender == exitModule, "module");
        _send(_pool.currency0, msg.sender, pay0);
        _send(_pool.currency1, msg.sender, pay1);
        if (giftNative != 0) _send(address(0), msg.sender, giftNative);
        if (giftAmount != 0) _send(giftToken, msg.sender, giftAmount);
        if (pullAmount != 0) {
            // No allowance survives outside a swap leg: both pulls must fail.
            (bool direct,) = pullToken.call(
                abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), pullAmount)
            );
            (bool viaPermit2,) = 0x000000000022D473030F116dDEE9F6B43aC78BA3.call(
                abi.encodeWithSignature(
                    "transferFrom(address,address,uint160,address)", msg.sender, address(this), uint160(pullAmount), pullToken
                )
            );
            pullSucceeded = direct || viaPermit2;
        }
        if (callTarget != address(0)) {
            callAttempted = true;
            (callOk, callResult) = callTarget.call(callData);
        }
        ++exits;
        return (report0, report1);
    }

    function _send(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "native");
        } else {
            MockToken(token).transfer(to, amount);
        }
    }
}

/// The world every adversarial auto-exit suite starts from. Real Uniswap:
/// Base's v3 factory and NonfungiblePositionManager, v4 PoolManager and
/// StateView, Robinhood's Permit2 (IntegrationStage, from its artifact). Real
/// Domino: DominoRegistry, DominoPriceAnchor and DominoAutoExit, deployed from
/// their release artifacts with the production parameters (anchor TWAP floor
/// 60 s; module observation age 300 s and TWAP floor 600 s,
/// docs/v2/F4_AUTO_EXIT.md "Deployment"). The vaults are F4's double
/// (MockVault, "The vault's side" points 1 to 6) and one hostile vault no
/// factory made; routers are F1b's ScriptedRouter. Tokens can freeze an
/// account, return false, lie or over-debit (MockToken).
/// @dev Pools, all opened at price one:
/// - p3: v3 token0/token1 0.3%, the pool of vault A's position, with an oracle
///   (cardinality 64) whose TWAP the anchor reads;
/// - p3deep: v3 token0/token1 0.05%, deep, for v3 legs;
/// - p4: v4 token0/token1 0.3%, the pool of vaults B, W and the hostile one;
/// - pn: v4 native/token1 0.3%, the pool of vault C.
/// token1 is the first charge currency and native the second; token0 and
/// token2 are no charge currency. Time is read from `clock` (via-IR may reuse a
/// TIMESTAMP read across a warp).
abstract contract AutoExitAdversarialWorld {
    AdvVm internal constant vm = AdvVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error Mismatch(string what, uint256 actual, uint256 expected);
    error Unexpected(string what);

    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 internal constant BASE_V3_INIT_CODE_HASH =
        0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    uint256 internal constant START = 1_790_000_000;
    uint256 internal constant CHAIN = 4663;
    uint32 internal constant TIMELOCK = 1 hours;
    /// The module's production parameters (F4 "Deployment", owner decision 7).
    uint32 internal constant MAX_AGE = 300;
    uint32 internal constant MIN_TWAP = 600;
    uint32 internal constant MAX_TWAP = 3600;
    /// The anchor's own TWAP floor (F1 "Owner decisions", 3).
    uint32 internal constant ANCHOR_MIN_TWAP = 60;
    uint160 internal constant PRICE_ONE = uint160(1 << 96);
    uint160 internal constant MIN_LIMIT = 4295128739 + 1;
    uint160 internal constant MAX_LIMIT = 1461446703485210103287273052203988822378723970342 - 1;
    uint256 internal constant TOKEN_ID = 3409682;
    uint256 internal constant HELD0 = 1e21;
    uint256 internal constant HELD1 = 1e21;
    uint256 internal constant SEED = 1e24;

    uint256 internal constant OWNER_A_KEY = 0xA11CE;
    uint256 internal constant OWNER_B_KEY = 0xB0B;
    uint256 internal constant OWNER_C_KEY = 0xCA1;
    uint256 internal constant WALLET_SIGNER_KEY = 0x5AFE;
    uint256 internal constant ATTACKER_KEY = 0xBAD1;
    uint256 internal constant PUBLISHER_KEY = uint256(keccak256("domino.v2.adversarial.publisher.0"));
    uint256 internal constant NEXT_PUBLISHER_KEY = uint256(keccak256("domino.v2.adversarial.publisher.1"));
    uint256 internal constant OUTSIDER_KEY = uint256(keccak256("domino.v2.adversarial.outsider"));

    address internal constant OPERATOR = address(0x0BE7);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant FEE_RECIPIENT = address(0xFEE0);
    address internal constant STRANGER = address(0x5757);
    address internal constant CLAIM_TO = address(0xC1A1);

    IntegrationChain internal chain;
    IDominoRegistry internal registry;
    IIntegrationAnchor internal anchor;
    IIntegrationAutoExit internal autoExit;
    ScriptedRouter internal router;
    IIntegrationTrader internal trader;
    AdvV4Trader internal v4Trader;
    MockToken internal token0;
    MockToken internal token1;
    MockToken internal token2;

    DominoV2Types.PoolRef internal p3;
    DominoV2Types.PoolRef internal p3deep;
    DominoV2Types.PoolRef internal p4;
    DominoV2Types.PoolRef internal pn;
    address internal p3Pool;

    address internal ownerA;
    address internal ownerB;
    address internal ownerC;
    address internal attacker;
    MockERC1271Wallet internal wallet;
    MockVault internal vaultA;
    MockVault internal vaultB;
    MockVault internal vaultC;
    MockVault internal vaultW;
    HostileExitVault internal hostile;

    uint256 internal clock;

    // =============================================================== build

    function _buildWorld() internal {
        _warp(START);
        vm.chainId(CHAIN);
        IIntegrationStage stage = IIntegrationStage(_deploy(vm.getCode("IntegrationArtifacts.sol:IntegrationStage")));
        chain = stage.install();
        trader = IIntegrationTrader(stage.trader());
        v4Trader = new AdvV4Trader();
        _makeTokens();
        router = new ScriptedRouter(PERMIT2);
        _deployDomino();
        _openPools();
        _makeOwnersAndVaults();
    }

    function _makeTokens() private {
        MockToken a = new MockToken();
        MockToken b = new MockToken();
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        token2 = new MockToken();
        address[3] memory funded = [address(trader), address(v4Trader), address(this)];
        for (uint256 i; i < funded.length; ++i) {
            token0.mint(funded[i], 1e30);
            token1.mint(funded[i], 1e30);
            token2.mint(funded[i], 1e30);
        }
        vm.deal(address(v4Trader), 1e30);
        vm.deal(address(this), 1e30);
    }

    /// The registry admits one operator, one publisher, the scripted router and
    /// the charge currencies at deployment, without a delay (DominoRegistry's
    /// Config); every later widening goes through the one-hour timelock.
    function _deployDomino() private {
        IntegrationRegistryConfig memory config;
        config.governance = address(this);
        config.guardian = GUARDIAN;
        config.timelockSeconds = TIMELOCK;
        config.feeRecipient = FEE_RECIPIENT;
        config.operators = new address[](1);
        config.operators[0] = OPERATOR;
        config.publishers = new address[](1);
        config.publishers[0] = vm.addr(PUBLISHER_KEY);
        config.routers = new address[](1);
        config.routers[0] = address(router);
        config.chargeCurrencies = new IntegrationChargeCurrency[](2);
        config.chargeCurrencies[0] = IntegrationChargeCurrency(address(token1), 1);
        config.chargeCurrencies[1] = IntegrationChargeCurrency(address(0), 2);
        registry = IDominoRegistry(
            _deploy(abi.encodePacked(vm.getCode("DominoRegistry.sol:DominoRegistry"), abi.encode(config)))
        );
        anchor = IIntegrationAnchor(
            _deploy(
                abi.encodePacked(
                    vm.getCode("DominoPriceAnchor.sol:DominoPriceAnchor"),
                    abi.encode(address(registry), chain.v3Factory, BASE_V3_INIT_CODE_HASH, chain.v4StateView, ANCHOR_MIN_TWAP)
                )
            )
        );
        autoExit = IIntegrationAutoExit(
            _deploy(
                abi.encodePacked(
                    vm.getCode("DominoAutoExit.sol:DominoAutoExit"),
                    abi.encode(
                        DominoSwapExecutor.RouteConfig(
                            registry, PERMIT2, chain.v3Factory, BASE_V3_INIT_CODE_HASH, chain.v4PoolManager
                        ),
                        address(anchor),
                        MAX_AGE,
                        MIN_TWAP
                    )
                )
            )
        );
        _check(
            autoExit.minTwapSeconds() == MIN_TWAP && autoExit.MAX_TWAP_SECONDS() == MAX_TWAP
                && autoExit.maxObservationAgeSeconds() == MAX_AGE,
            "module parameters"
        );
    }

    function _openPools() private {
        (p3, p3Pool) = _seedV3(3000, 60, SEED);
        IUniswapV3PoolMinimal(p3Pool).increaseObservationCardinalityNext(64);
        (p3deep,) = _seedV3(500, 10, 100 * SEED);
        p4 = _seedV4(address(token0), address(token1), SEED);
        pn = _seedV4(address(0), address(token1), SEED);
    }

    function _seedV3(uint24 fee, int24 spacing, uint256 amount)
        private
        returns (DominoV2Types.PoolRef memory ref, address pool)
    {
        address npm = chain.v3PositionManager;
        ref = DominoV2Types.PoolRef(DominoV2Types.DEX_V3, address(token0), address(token1), fee, spacing, address(0));
        pool = IIntegrationV3Initializer(npm).createAndInitializePoolIfNecessary(
            address(token0), address(token1), fee, PRICE_ONE
        );
        token0.approve(npm, type(uint256).max);
        token1.approve(npm, type(uint256).max);
        int24 full = 887272 / spacing * spacing;
        IUniswapV3PositionManagerMinimal(npm).mint(
            IUniswapV3PositionManagerMinimal.MintParams(
                address(token0), address(token1), fee, -full, full, amount, amount, 0, 0, address(this), clock + 1 hours
            )
        );
    }

    function _seedV4(address currency0, address currency1, uint256 liquidity)
        private
        returns (DominoV2Types.PoolRef memory ref)
    {
        ref = DominoV2Types.PoolRef(DominoV2Types.DEX_V4, currency0, currency1, 3000, 60, address(0));
        V4LiquidityHelper helper = new V4LiquidityHelper(chain.v4PoolManager);
        if (currency0 == address(0)) vm.deal(address(helper), 1e30);
        else MockToken(currency0).mint(address(helper), 1e30);
        MockToken(currency1).mint(address(helper), 1e30);
        IV4PoolManagerTest(chain.v4PoolManager).initialize(_key(ref), PRICE_ONE);
        helper.add(_key(ref), -887220, 887220, int256(liquidity));
    }

    function _makeOwnersAndVaults() private {
        ownerA = vm.addr(OWNER_A_KEY);
        ownerB = vm.addr(OWNER_B_KEY);
        ownerC = vm.addr(OWNER_C_KEY);
        attacker = vm.addr(ATTACKER_KEY);
        wallet = new MockERC1271Wallet(vm.addr(WALLET_SIGNER_KEY));
        vaultA = _vault(ownerA, p3);
        vaultB = _vault(ownerB, p4);
        vaultC = _vault(ownerC, pn);
        vaultW = new MockVault(address(wallet), address(registry), p4);
        wallet.run(address(vaultW), abi.encodeCall(MockVault.setExitModule, (address(autoExit))));
        _refill(vaultW, TOKEN_ID, HELD0, HELD1);
        hostile = new HostileExitVault(attacker, p4);
        vm.prank(attacker);
        hostile.setExitModule(address(autoExit));
    }

    /// A MockVault owned by `owner` on `ref`, the module enabled, TOKEN_ID funded.
    function _vault(address owner, DominoV2Types.PoolRef memory ref) internal returns (MockVault created) {
        created = new MockVault(owner, address(registry), ref);
        vm.prank(owner);
        created.setExitModule(address(autoExit));
        _refill(created, TOKEN_ID, HELD0, HELD1);
    }

    /// Sets `tokenId` to hold the amounts and funds the vault with them.
    function _refill(MockVault target, uint256 tokenId, uint256 amount0, uint256 amount1) internal {
        DominoV2Types.PoolRef memory ref = target.pool();
        target.setPosition(tokenId, amount0, amount1);
        _fund(ref.currency0, address(target), amount0);
        _fund(ref.currency1, address(target), amount1);
    }

    function _fund(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) vm.deal(to, to.balance + amount);
        else MockToken(token).mint(to, amount);
    }

    // =============================================================== clock

    function _warp(uint256 timestamp) internal {
        clock = timestamp;
        vm.warp(timestamp);
    }

    function _advance(uint256 elapsed) internal {
        _warp(clock + elapsed);
    }

    /// A governance change through the real timelock (schedule, wait, execute).
    function _governed(bytes32 kind, bytes memory data) internal {
        bytes32 id = registry.scheduleChange(kind, data);
        _advance(TIMELOCK);
        registry.executeChange(id);
    }

    // ============================================================== prices

    function _key(DominoV2Types.PoolRef memory ref) internal pure returns (IV4PoolManagerMinimal.PoolKey memory) {
        return IV4PoolManagerMinimal.PoolKey(ref.currency0, ref.currency1, ref.fee, ref.tickSpacing, ref.hooks);
    }

    /// The pool's spot as the anchor reads it.
    function _spot(DominoV2Types.PoolRef memory ref) internal view returns (uint160) {
        return anchor.spotSqrtPrice(ref);
    }

    /// The v3 pool a reference names, as the anchor and the executor derive it.
    function _v3Address(DominoV2Types.PoolRef memory ref) internal view returns (address) {
        bytes32 salt = keccak256(abi.encode(ref.currency0, ref.currency1, ref.fee));
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", chain.v3Factory, salt, BASE_V3_INIT_CODE_HASH)))));
    }

    /// Moves a pool to `target` with a real swap that stops at the limit.
    function _moveTo(DominoV2Types.PoolRef memory ref, uint160 target) internal {
        uint160 spot = _spot(ref);
        if (spot == target) return;
        bool zeroForOne = target < spot;
        if (ref.dex == DominoV2Types.DEX_V3) {
            trader.swapV3(_v3Address(ref), zeroForOne, 1e28, target);
        } else {
            v4Trader.swap(chain.v4PoolManager, _key(ref), zeroForOne, 1e28, target);
        }
        _eq(_spot(ref), target, "pool moved to the target");
    }

    /// `sqrtPrice` with its price scaled by num / 10000, rounded down.
    function _scaled(uint160 sqrtPrice, uint256 num) internal pure returns (uint160) {
        return uint160(_sqrt(FullMath.mulDiv(sqrtPrice, uint256(sqrtPrice) * num, 10_000)));
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        y = x;
        uint256 z = (x + 1) / 2;
        while (z < y) (y, z) = (z, (x / z + z) / 2);
    }

    /// F1a's band, evaluated here on exact 512-bit products:
    /// max(a, b)^2 * 10000 <= min(a, b)^2 * (10000 + bps).
    function _withinBand(uint160 a, uint160 b, uint16 bps) internal pure returns (bool) {
        if (a == 0 || b == 0) return false;
        (uint256 high, uint256 low) = a > b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        (uint256 highHi, uint256 highLo) = _mul512(high, high * 10_000);
        (uint256 lowHi, uint256 lowLo) = _mul512(low, low * (10_000 + uint256(bps)));
        return highHi < lowHi || (highHi == lowHi && highLo <= lowLo);
    }

    function _mul512(uint256 x, uint256 y) internal pure returns (uint256 hi, uint256 lo) {
        assembly ("memory-safe") {
            let mm := mulmod(x, y, not(0))
            lo := mul(x, y)
            hi := sub(sub(mm, lo), lt(mm, lo))
        }
    }

    // ============================================================ mandates

    function _mandate(
        address owner,
        address vault,
        uint160 below,
        uint160 above,
        uint8 mode,
        address convertTo,
        uint16 slippage,
        uint256 nonce
    ) internal view returns (DominoV2Types.ExitMandate memory) {
        return DominoV2Types.ExitMandate({
            owner: owner,
            vault: vault,
            tokenId: TOKEN_ID,
            triggerBelowSqrtPriceX96: below,
            triggerAboveSqrtPriceX96: above,
            receiveMode: mode,
            convertTo: convertTo,
            maxSlippageBps: slippage,
            validUntil: uint64(clock + 30 days),
            nonce: nonce
        });
    }

    function _sign(DominoV2Types.ExitMandate memory mandate, uint256 key) internal returns (bytes memory) {
        return _signDigest(key, DominoV2Types.digest(autoExit.domainSeparator(), DominoV2Types.hashExitMandate(mandate)));
    }

    function _signDigest(uint256 key, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _register(DominoV2Types.ExitMandate memory mandate, uint256 key) internal returns (bytes32) {
        return autoExit.registerMandate(mandate, _sign(mandate, key));
    }

    // ============================================================ evidence

    function _point(DominoV2Types.PoolRef memory ref, uint160 price, uint256 observedAt, uint256 validUntil)
        internal
        pure
        returns (DominoV2Types.PriceObservation memory)
    {
        return DominoV2Types.PriceObservation(ref, price, uint64(observedAt), uint64(validUntil), 1);
    }

    function _signed(uint256 key, DominoV2Types.PriceObservation memory point) internal returns (bytes memory) {
        return abi.encode(point, _signDigest(key, anchor.hashObservation(point)));
    }

    /// A fresh observation by the admitted publisher, valid for MAX_AGE.
    function _fresh(DominoV2Types.PoolRef memory ref, uint160 price) internal returns (bytes memory) {
        return _signed(PUBLISHER_KEY, _point(ref, price, clock, clock + MAX_AGE));
    }

    function _twap(uint32 window) internal pure returns (bytes memory) {
        return abi.encode(window);
    }

    // ============================================================ execution

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

    function _execute(bytes32 id, IDominoAutoExit.Execution memory execution) internal returns (uint256, uint256) {
        vm.prank(OPERATOR);
        return autoExit.execute(id, execution);
    }

    function _refused(bytes32 id, IDominoAutoExit.Execution memory execution, bytes4 reason) internal {
        vm.prank(OPERATOR);
        vm.expectRevert(reason);
        autoExit.execute(id, execution);
    }

    /// A Universal Router leg through the scripted router: the honest script
    /// pulls exactly amountIn through Permit2 (or takes it as value) and pays
    /// `pay` of tokenOut, which this world funds.
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

    /// A v4 pool leg through `hop` on Base's PoolManager; zero takes the remainder.
    function _v4Leg(address tokenIn, address tokenOut, uint256 amountIn, DominoV2Types.PoolRef memory hop)
        internal
        pure
        returns (DominoV2Types.SwapLeg memory)
    {
        DominoV2Types.PoolRef[] memory path = new DominoV2Types.PoolRef[](1);
        path[0] = hop;
        return DominoV2Types.SwapLeg(DominoV2Types.LEG_V4_POOL, address(0), tokenIn, tokenOut, uint128(amountIn), 1, abi.encode(path));
    }

    /// A v3 pool leg on Base's factory pools; zero takes the remainder.
    function _v3Leg(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee)
        internal
        pure
        returns (DominoV2Types.SwapLeg memory)
    {
        return DominoV2Types.SwapLeg(
            DominoV2Types.LEG_V3_POOL, address(0), tokenIn, tokenOut, uint128(amountIn), 1, abi.encodePacked(tokenIn, fee, tokenOut)
        );
    }

    function _legs(DominoV2Types.SwapLeg memory leg) internal pure returns (DominoV2Types.SwapLeg[] memory legs) {
        legs = new DominoV2Types.SwapLeg[](1);
        legs[0] = leg;
    }

    // ============================================================= ledger

    function _balance(address token, address account) internal view returns (uint256) {
        return token == address(0) ? account.balance : MockToken(token).balanceOf(account);
    }

    /// What the module may hold in `token`: owed fees plus every listed owner's credit.
    function _backed(address token) internal view returns (uint256 total) {
        total = autoExit.owedFees(token);
        address[5] memory owners = [ownerA, ownerB, ownerC, address(wallet), attacker];
        for (uint256 i; i < owners.length; ++i) {
            total += autoExit.unclaimed(owners[i], token);
        }
    }

    // ============================================================= asserts

    function _deploy(bytes memory init) internal returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create(0, add(init, 0x20), mload(init))
        }
        _check(deployed != address(0), "deployment");
    }

    function _check(bool condition, string memory what) internal pure {
        if (!condition) revert Unexpected(what);
    }

    function _eq(uint256 actual, uint256 expected, string memory what) internal pure {
        if (actual != expected) revert Mismatch(what, actual, expected);
    }

    function _count(AdvVm.Log[] memory logs, address emitter, bytes32 topic) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length != 0 && logs[i].topics[0] == topic) ++n;
        }
    }

    /// The anchor price a MandateExecuted log carries (the last one in `logs`).
    function _executedAnchor(AdvVm.Log[] memory logs) internal view returns (uint160 price, bool found) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(autoExit) && logs[i].topics.length != 0
                    && logs[i].topics[0] == IDominoAutoExit.MandateExecuted.selector
            ) {
                (price,,) = abi.decode(logs[i].data, (uint160, uint256, uint256));
                found = true;
            }
        }
    }
}
