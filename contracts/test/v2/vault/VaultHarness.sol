// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {IDominoVaultLedger} from "../../../src/v2/interfaces/IDominoVaultLedger.sol";
import {DominoV2VaultBase} from "../../../src/v2/vault/DominoV2VaultBase.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {DominoV2VaultFactory} from "../../../src/v2/vault/DominoV2VaultFactory.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {MockAnchor, MockRegistry, MockToken, MockV3Factory, MockV3PositionManager} from "./VaultMocks.sol";
import {CallbackProbe, MockSwapSteps, MockSwapVenue, StepConfig} from "./VaultSteps.sol";

interface VaultVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
    function expectCall(address callee, bytes calldata data) external;
    function expectCall(address callee, bytes calldata data, uint64 count) external;
    function warp(uint256 timestamp) external;
    function deal(address account, uint256 balance) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function deployCode(string calldata artifact, bytes calldata args) external returns (address);
    function getNonce(address account) external view returns (uint64);
    function computeCreateAddress(address deployer, uint256 nonce) external pure returns (address);
    function etch(address target, bytes calldata code) external;
    function store(address target, bytes32 slot, bytes32 value) external;
    function getCode(string calldata artifact) external view returns (bytes memory);
    function mockCallRevert(address callee, bytes calldata data, bytes calldata revertData) external;
    function cool(address target) external;
    function assume(bool condition) external pure;
    function load(address target, bytes32 slot) external view returns (bytes32);
}

/// The shared world of the V2 vault suites: tokens, registry, anchor, the swap
/// port double and one DEX's manager, implementation and factory. A concrete
/// suite picks the DEX by inheriting HarnessV3 (this file) or HarnessV4
/// (VaultHarnessV4.sol). Vault and factory are deployed from their artifacts,
/// so editing a suite never recompiles them.
abstract contract VaultHarness {
    VaultVm internal constant vm = VaultVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant OWNER = address(0xA11CE);
    address internal constant OPERATOR = address(0x0CAFE);
    address internal constant STRANGER = address(0xBAD);
    address internal constant RECIPIENT = address(0xFEE);
    address internal constant EXIT_MODULE = address(0xE1E1);
    int24 internal constant LOWER = -6000;
    int24 internal constant UPPER = 6000;
    uint128 internal constant ROOT_LIQUIDITY = 1_000_000;
    uint160 internal constant PRICE_ONE = uint160(1 << 96);

    /// The pool's LP fee in pips; set before creating the root.
    uint24 internal poolFee = 3000;

    MockToken internal token0;
    MockToken internal token1;
    MockRegistry internal registry;
    MockAnchor internal anchor;
    StepConfig internal config;
    CallbackProbe internal probe;
    MockSwapVenue internal venue;
    MockSwapSteps internal swaps;

    address internal implementation;
    DominoV2VaultFactory internal factory;
    address internal manager;
    /// The swap module the implementation was built with.
    address internal swapModule;
    DominoV2VaultBase internal vault;
    uint256 internal rootId;

    function setUp() public virtual {
        MockToken a = new MockToken();
        MockToken b = new MockToken();
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        registry = new MockRegistry();
        registry.setOperator(OPERATOR, true);
        registry.setFeeRecipient(RECIPIENT);
        anchor = new MockAnchor();
        config = new StepConfig();
        probe = new CallbackProbe();
        venue = new MockSwapVenue();
        swaps = new MockSwapSteps(config, venue, anchor, probe);
        token0.mint(address(venue), 1e30);
        token1.mint(address(venue), 1e30);
        _deployDex();
    }

    // ============================================================ DEX hooks

    function _dex() internal pure virtual returns (uint8);
    function _deployDex() internal virtual;
    function _currency0() internal view virtual returns (address);
    function _mintPosition(address owner, int24 lower, int24 upper, uint128 liquidity)
        internal
        virtual
        returns (uint256 tokenId);
    function _approveNft(address owner, uint256 tokenId, address spender) internal virtual;
    /// Fees the pool earned for the position, held by its manager.
    function _accrue(uint256 tokenId, uint256 fee0, uint256 fee1) internal virtual;
    function _liquidityOf(uint256 tokenId) internal view virtual returns (uint128);
    function _ownerOfNft(uint256 tokenId) internal view virtual returns (address);
    /// The owner changes the root by itself, as through the Uniswap app.
    function _ownerChangesRoot() internal virtual;
    function _transferNft(address from, address to, uint256 tokenId) internal virtual;

    // ============================================================== helpers

    function _wiring(address factory_, address steps) internal view returns (DominoV2VaultStorage.Deployment memory) {
        return DominoV2VaultStorage.Deployment(factory_, address(registry), address(anchor), manager, steps, EXIT_MODULE);
    }

    function _artifact() internal pure virtual returns (string memory);

    /// Deploys the implementation (which creates its executor) and its factory,
    /// the factory at the address the implementation was built for.
    function _deployVault(address steps) internal {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        implementation = vm.deployCode(_artifact(), abi.encode(_wiring(predicted, steps)));
        factory = DominoV2VaultFactory(
            vm.deployCode("DominoV2VaultFactory.sol:DominoV2VaultFactory", abi.encode(implementation))
        );
        require(address(factory) == predicted, "factory prediction");
        swapModule = steps;
    }

    function _policy(uint8 mode, uint8 maxPositions) internal pure returns (IDominoVault.Policy memory) {
        return IDominoVault.Policy({
            mode: mode,
            triggerDistanceBps: 500,
            maxOverlapBps: 2000,
            minimumIntervalSeconds: 600,
            maxPositions: maxPositions
        });
    }

    function _limits() internal pure returns (IDominoVault.Limits memory) {
        return IDominoVault.Limits({
            maxSlippageBps: 100,
            maxPriceImpactBps: 200,
            maxObservationAgeSeconds: 300,
            upsideBps: 5000
        });
    }

    function _init(uint256 tokenId, uint8 mode, uint8 maxPositions) internal view returns (IDominoVault.Init memory) {
        return IDominoVault.Init({
            root: DominoV2Types.PositionRef(_dex(), manager, tokenId),
            policy: _policy(mode, maxPositions),
            limits: _limits(),
            startPaused: false,
            consentToUncollectedFees: true
        });
    }

    /// The owner approves its root to the predicted vault and creates it.
    function _createVault(uint8 mode, uint8 maxPositions) internal returns (DominoV2VaultBase created) {
        rootId = _mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY);
        created = _createVaultFor(rootId, mode, maxPositions);
        vault = created;
    }

    function _createVaultFor(uint256 tokenId, uint8 mode, uint8 maxPositions)
        internal
        returns (DominoV2VaultBase created)
    {
        uint256 nonce = factory.nextNonce(OWNER);
        _approveNft(OWNER, tokenId, factory.predictVault(OWNER, nonce));
        vm.prank(OWNER);
        created = DominoV2VaultBase(payable(factory.createVault(_init(tokenId, mode, maxPositions), nonce)));
    }

    function _simple() internal returns (DominoV2VaultBase) {
        return _createVault(DominoV2Types.MODE_SIMPLE, 1);
    }

    function _domino(uint8 maxPositions) internal returns (DominoV2VaultBase) {
        return _createVault(DominoV2Types.MODE_DOMINO, maxPositions);
    }

    function _budget(uint256 tokenId) internal pure returns (Plan.Budget memory) {
        return Plan.Budget(tokenId, type(uint128).max, type(uint128).max);
    }

    function _one(uint256 value) internal pure returns (uint256[] memory list) {
        list = new uint256[](1);
        list[0] = value;
    }

    function _two(uint256 a, uint256 b) internal pure returns (uint256[] memory list) {
        list = new uint256[](2);
        (list[0], list[1]) = (a, b);
    }

    /// Compound the root from its own fees, no swap.
    function _plan() internal view returns (Plan.PlanV1 memory p) {
        p.action = Plan.ACTION_COMPOUND;
        p.stateNonce = vault.stateNonce();
        p.deadline = uint64(block.timestamp + 600);
        p.target = rootId;
        p.amount0Max = type(uint128).max;
        p.amount1Max = type(uint128).max;
        p.minLiquidity = 1;
        p.collect = _one(rootId);
        p.budgets = new Plan.Budget[](1);
        p.budgets[0] = _budget(rootId);
        p.anchorEvidence = hex"a0";
    }

    function _withSwap(Plan.PlanV1 memory p, uint256 source, bool zeroForOne, uint128 amountIn, uint128 minOut)
        internal
        view
        returns (Plan.PlanV1 memory)
    {
        p.swap.source = source;
        p.swap.zeroForOne = zeroForOne;
        p.swap.amountIn = amountIn;
        p.swap.minAmountOut = minOut;
        p.swap.legs = new DominoV2Types.SwapLeg[](1);
        p.swap.legs[0] = DominoV2Types.SwapLeg({
            kind: DominoV2Types.LEG_UNIVERSAL_ROUTER,
            router: address(0x1234),
            tokenIn: zeroForOne ? address(token0) : address(token1),
            tokenOut: zeroForOne ? address(token1) : address(token0),
            amountIn: amountIn,
            minAmountOut: minOut,
            data: hex"00"
        });
        return p;
    }

    /// F4's IDominoAutoExitExtension.ExitInstruction, version 1, for the module.
    function _exitInstruction(uint128 amount0Min, uint128 amount1Min) internal pure returns (bytes memory) {
        return abi.encode(uint8(1), keccak256("mandate"), EXIT_MODULE, amount0Min, amount1Min);
    }

    function _execute(Plan.PlanV1 memory p) internal returns (bytes32) {
        vm.prank(OPERATOR);
        return vault.execute(Plan.encode(p));
    }

    function _lot(uint256 tokenId, address token) internal view returns (uint128 uncharged, uint128 charged) {
        IDominoVaultLedger.Lot memory entry = vault.lot(tokenId, token);
        return (entry.uncharged, entry.charged);
    }

    function _balance(address token, address account) internal view returns (uint256) {
        return token == address(0) ? account.balance : MockToken(token).balanceOf(account);
    }

    function _eq(uint256 actual, uint256 expected, string memory what) internal pure {
        if (actual != expected) revert Mismatch(what, actual, expected);
    }

    function _true(bool value, string memory what) internal pure {
        if (!value) revert Expected(what);
    }

    error Mismatch(string what, uint256 actual, uint256 expected);
    error Expected(string what);
}

abstract contract HarnessV3 is VaultHarness {
    MockV3Factory internal v3Factory;
    MockV3PositionManager internal npm;

    function _dex() internal pure override returns (uint8) {
        return DominoV2Types.DEX_V3;
    }

    function _artifact() internal pure override returns (string memory) {
        return "DominoV2VaultV3.sol:DominoV2VaultV3";
    }

    function _deployDex() internal override {
        v3Factory = new MockV3Factory();
        npm = new MockV3PositionManager(address(v3Factory));
        manager = address(npm);
        _deployVault(address(swaps));
    }

    function _currency0() internal view override returns (address) {
        return address(token0);
    }

    function _mintPosition(address owner, int24 lower, int24 upper, uint128 liquidity)
        internal
        override
        returns (uint256 tokenId)
    {
        tokenId = npm.mintFor(owner, address(token0), address(token1), poolFee, lower, upper, liquidity);
        token0.mint(address(npm), uint256(liquidity) * npm.unit0());
        token1.mint(address(npm), uint256(liquidity) * npm.unit1());
    }

    function _approveNft(address owner, uint256 tokenId, address spender) internal override {
        vm.prank(owner);
        npm.approve(spender, tokenId);
    }

    function _accrue(uint256 tokenId, uint256 fee0, uint256 fee1) internal override {
        token0.mint(address(npm), fee0);
        token1.mint(address(npm), fee1);
        npm.accrue(tokenId, fee0, fee1);
    }

    function _liquidityOf(uint256 tokenId) internal view override returns (uint128 liquidity) {
        (,,,,,,, liquidity,,,,) = npm.positions(tokenId);
    }

    function _ownerOfNft(uint256 tokenId) internal view override returns (address) {
        return npm.ownerOf(tokenId);
    }

    /// The owner removes a little liquidity: principal waits in tokensOwed.
    function _ownerChangesRoot() internal override {
        vm.prank(OWNER);
        npm.decreaseLiquidity(MockV3PositionManager.DecreaseLiquidityParams(rootId, 1, 0, 0, block.timestamp));
    }

    function _transferNft(address from, address to, uint256 tokenId) internal override {
        vm.prank(from);
        npm.transferFrom(from, to, tokenId);
    }
}
