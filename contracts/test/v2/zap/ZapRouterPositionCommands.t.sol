// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IUniswapV3PositionManagerMinimal} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IV3PoolInitializerMinimal} from "../../../src/v2/positions/DominoV3Positions.sol";
import {DominoSwapExecutor} from "../../../src/v2/route/DominoSwapExecutor.sol";
import {UniswapBase8453} from "../positions/fixtures/UniswapBase8453.sol";
import {RobinhoodPermit2} from "../route/fixtures/RobinhoodPermit2.sol";
import {RobinhoodUniversalRouter212} from "../route/fixtures/RobinhoodUniversalRouter212.sol";
import {MockDominoRegistry, TestToken} from "../route/V2RouteTestKit.sol";
import {ZapBaseFixtures} from "./ZapBaseFixtures.sol";
import {IZap} from "./ZapTestKit.sol";

interface IUniversalRouterExecute {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// The NonfungiblePositionManager calls a Universal Router command may reach.
interface IV3PositionCommands {
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata params) external payable returns (uint256, uint256);
    function collect(CollectParams calldata params) external payable returns (uint256, uint256);
    function positions(uint256 tokenId)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128);
    function approve(address to, uint256 tokenId) external;
    function setApprovalForAll(address operator, bool approved) external;
}

/// Universal Router 2.1.2 (the Robinhood runtime) runs V3_POSITION_MANAGER_CALL
/// for its caller, a Domino zap inside a swap leg: the router checks that the
/// zap may act on the token, the position manager that the router may. A leg
/// must never reach a position that way. The v3 position manager here is
/// Base's deployed bytecode, etched (with its constructor storage) at the
/// address the Robinhood router embeds; the zap is DominoZapV3 on it.
contract ZapRouterPositionCommandsTest is ZapBaseFixtures {
    string internal constant ZAP_ARTIFACT = "DominoZapV3.sol:DominoZapV3";
    bytes32 internal constant POOL_INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
    /// Robinhood's v3 NonfungiblePositionManager (api-contracts/v2/chains/robinhood-4663.json).
    address internal constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    bytes1 internal constant PERMIT2_TRANSFER_FROM = 0x02;
    bytes1 internal constant SWEEP = 0x04;
    bytes1 internal constant V3_POSITION_MANAGER_CALL = 0x12;
    bytes1 internal constant EXECUTE_SUB_PLAN = 0x21;
    int24 internal constant LOWER = -600;
    int24 internal constant UPPER = 600;
    uint128 internal constant IN = 1e18;

    address internal router = RobinhoodUniversalRouter212.ADDRESS;
    MockDominoRegistry internal registry;
    IZap internal zap;
    TestToken internal usd;
    TestToken internal tkn;
    address internal alice = address(0xA11CE);
    address internal eve = address(0xE7E);
    DominoV2Types.PoolRef internal pool;

    function setUp() public {
        vm.warp(NOW);
        vm.etch(PERMIT2, RobinhoodPermit2.RUNTIME);
        vm.etch(router, RobinhoodUniversalRouter212.RUNTIME);
        _installBaseV3();
        vm.etch(NPM, UniswapBase8453.V3_POSITION_MANAGER.code);
        (address[] memory accounts, bytes32[] memory slots, bytes32[] memory values) =
            UniswapBase8453.constructorStorage();
        for (uint256 i; i < accounts.length; ++i) {
            if (accounts[i] == UniswapBase8453.V3_POSITION_MANAGER) vm.store(NPM, slots[i], values[i]);
        }
        registry = new MockDominoRegistry();
        registry.setFeeRecipient(address(0xFEE));
        registry.setRouter(router, 212);
        zap = IZap(
            _deploy(
                abi.encodePacked(
                    vm.getCode(ZAP_ARTIFACT),
                    abi.encode(
                        DominoSwapExecutor.RouteConfig(
                            IDominoRegistry(address(registry)),
                            PERMIT2,
                            UniswapBase8453.V3_FACTORY,
                            POOL_INIT_CODE_HASH,
                            address(0)
                        ),
                        NPM
                    )
                )
            )
        );
        (usd, tkn) = (new TestToken(), new TestToken());
        registry.setRank(address(usd), 1);
        address[3] memory funded = [address(this), alice, eve];
        for (uint256 i; i < funded.length; ++i) {
            usd.mint(funded[i], 1e30);
            tkn.mint(funded[i], 1e30);
        }
        (address c0, address c1) = _sorted(address(usd), address(tkn));
        pool = DominoV2Types.PoolRef(DominoV2Types.DEX_V3, c0, c1, 3000, 60, address(0));
        IV3PoolInitializerMinimal(NPM).createAndInitializePoolIfNecessary(c0, c1, 3000, PRICE_ONE);
        usd.approve(NPM, type(uint256).max);
        tkn.approve(NPM, type(uint256).max);
        IUniswapV3PositionManagerMinimal(NPM).mint(
            IUniswapV3PositionManagerMinimal.MintParams(
                c0, c1, 3000, -887220, 887220, 1e22, 1e22, 0, 0, address(this), block.timestamp
            )
        );
        address[2] memory users = [alice, eve];
        for (uint256 i; i < users.length; ++i) {
            vm.startPrank(users[i]);
            usd.approve(address(zap), type(uint256).max);
            tkn.approve(address(zap), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// Alice's position, minted through the zap with both tokens and no swap.
    function _alicePosition() internal returns (uint256 id, uint128 liquidity) {
        DominoV2Types.TokenAmount[] memory inputs = new DominoV2Types.TokenAmount[](2);
        (inputs[0], inputs[1]) =
            (DominoV2Types.TokenAmount(address(usd), 50e18), DominoV2Types.TokenAmount(address(tkn), 50e18));
        IDominoPositionActions.CreatePlan memory plan;
        plan.intent = _intent(DominoV2Types.ACTION_CREATE, pool, 0, LOWER, UPPER, 1, _noLegs(), ETH, alice, 0);
        (plan.inputs, plan.legs, plan.amount0Max, plan.amount1Max) =
            (inputs, _noLegs(), type(uint128).max, type(uint128).max);
        vm.prank(alice);
        IDominoPositionActions.ActionResult memory r = zap.create(plan);
        (id, liquidity) = (r.tokenId, r.liquidity);
    }

    function _liquidity(uint256 id) internal view returns (uint128 liquidity) {
        (,,,,,,, liquidity,,,,) = IV3PositionCommands(NPM).positions(id);
    }

    /// Router commands that satisfy a usd → tkn leg's effect (usd out through
    /// Permit2, tkn back by SWEEP from tkn eve left on the router), then
    /// decrease and collect `victim` to eve.
    function _drain(uint256 victim, uint128 liquidity)
        internal
        view
        returns (bytes memory commands, bytes[] memory inputs)
    {
        commands = abi.encodePacked(PERMIT2_TRANSFER_FROM, SWEEP, V3_POSITION_MANAGER_CALL, V3_POSITION_MANAGER_CALL);
        inputs = new bytes[](4);
        inputs[0] = abi.encode(address(usd), eve, uint160(IN));
        inputs[1] = abi.encode(address(tkn), address(zap), uint256(IN));
        inputs[2] = abi.encodeCall(
            IV3PositionCommands.decreaseLiquidity,
            (IV3PositionCommands.DecreaseLiquidityParams(victim, liquidity, 0, 0, block.timestamp))
        );
        inputs[3] = abi.encodeCall(
            IV3PositionCommands.collect,
            (IV3PositionCommands.CollectParams(victim, eve, type(uint128).max, type(uint128).max))
        );
    }

    /// Eve's own create in the pool, with one router leg carrying `commands`.
    function _evesPlan(bytes memory commands, bytes[] memory inputs)
        internal
        returns (IDominoPositionActions.CreatePlan memory plan)
    {
        vm.prank(eve);
        tkn.transfer(router, IN);
        DominoV2Types.SwapLeg[] memory legs = _oneLeg(
            DominoV2Types.SwapLeg(
                DominoV2Types.LEG_UNIVERSAL_ROUTER,
                router,
                address(usd),
                address(tkn),
                IN,
                IN,
                abi.encodeCall(IUniversalRouterExecute.execute, (commands, inputs, block.timestamp + 60))
            )
        );
        DominoV2Types.TokenAmount[] memory own = new DominoV2Types.TokenAmount[](2);
        (own[0], own[1]) =
            (DominoV2Types.TokenAmount(address(usd), 2 * IN), DominoV2Types.TokenAmount(address(tkn), IN));
        plan.intent = _intent(DominoV2Types.ACTION_CREATE, pool, 0, LOWER, UPPER, 1, legs, address(usd), eve, 0);
        (plan.inputs, plan.legs, plan.amount0Max, plan.amount1Max) =
            (own, legs, type(uint128).max, type(uint128).max);
    }

    function _assertIntact(uint256 id, uint128 liquidity) internal view {
        _eq(_liquidity(id), liquidity, "alice's liquidity untouched");
    }

    /// Alice approved the zap on her position (for a later increase or exit
    /// through it) and the router for all her positions (a v3 → v4 migration).
    function testARouterLegCannotDrainAPositionApprovedToTheZap() public {
        (uint256 id, uint128 liquidity) = _alicePosition();
        vm.startPrank(alice);
        IV3PositionCommands(NPM).approve(address(zap), id);
        IV3PositionCommands(NPM).setApprovalForAll(router, true);
        vm.stopPrank();
        (bytes memory commands, bytes[] memory inputs) = _drain(id, liquidity);
        IDominoPositionActions.CreatePlan memory plan = _evesPlan(commands, inputs);
        vm.prank(eve);
        vm.expectRevert(IDominoPositionActions.InvalidPlan.selector);
        zap.create(plan);
        _assertIntact(id, liquidity);
    }

    /// The other pairing: the zap is alice's operator, the router approved on the token.
    function testARouterLegCannotDrainAPositionWhoseOwnerMadeTheZapOperator() public {
        (uint256 id, uint128 liquidity) = _alicePosition();
        vm.startPrank(alice);
        IV3PositionCommands(NPM).setApprovalForAll(address(zap), true);
        IV3PositionCommands(NPM).approve(router, id);
        vm.stopPrank();
        (bytes memory commands, bytes[] memory inputs) = _drain(id, liquidity);
        IDominoPositionActions.CreatePlan memory plan = _evesPlan(commands, inputs);
        vm.prank(eve);
        vm.expectRevert(IDominoPositionActions.InvalidPlan.selector);
        zap.create(plan);
        _assertIntact(id, liquidity);
    }
}
