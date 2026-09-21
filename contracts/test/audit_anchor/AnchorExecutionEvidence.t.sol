// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NitroTestSetup} from "../shared/NitroTestSetup.sol";

import {OfficialFixtureToken, OfficialV4Controller, OfficialV4SwapDriver, PoolManager,
    PositionManager, IPoolManager, PoolKey, Currency} from "../reference/OfficialV4Fixture.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPositionDescriptor} from "../reference/official-v4/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "../reference/official-v4/v4-periphery/src/interfaces/external/IWETH9.sol";
import {StateView} from "../reference/official-v4/v4-periphery/src/lens/StateView.sol";
import {DominoVaultV4} from "../../src/DominoVaultV4.sol";
import {DominoVaultFactoryV4} from "../../src/DominoVaultFactoryV4.sol";
import {DominoVaultReadHelper} from "../../src/DominoVaultReadHelper.sol";
import {DominoExecutionEngineV4} from "../../src/DominoExecutionEngineV4.sol";
import {DominoRoutingHelperV4} from "../../src/DominoRoutingHelperV4.sol";
import {DominoPriceGuardV4} from "../../src/DominoPriceGuardV4.sol";
import {DominoExecutionTypes as E} from "../../src/DominoExecutionTypes.sol";
import {DominoVaultTypes as T} from "../../src/DominoVaultTypes.sol";
import {IDominoVaultDraft} from "../../src/IDominoVaultDraft.sol";

interface VmExecutionV4 {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function deal(address,uint256) external;
    function chainId(uint256) external;
    function roll(uint256) external;
    function warp(uint256) external;
    function setBlockhash(uint256,bytes32) external;
    function snapshotState() external returns(uint256);
    function revertToState(uint256) external returns(bool);
    function recordLogs() external;
    function getRecordedLogs() external returns(Log[] memory);
    function prank(address) external;
    function etch(address,bytes calldata) external;
}

contract AnchorExecutionEvidenceTest {
    using TransientStateLibrary for IPoolManager;
    VmExecutionV4 private constant vm = VmExecutionV4(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant RECIPIENT = address(0xFEE);
    address private constant PUBLISHER = address(0xA11CE);
    address private constant GUARDIAN = address(0x6A2D);
    // The published price must sit within this band of the pool's own
    // reading; wide enough for the fixture's moves, far from unbounded.
    uint256 constant GUARD_DEVIATION_BPS=2000;
    uint128 private constant OPENING = 1e18;
    // Sized so the price moves the add's composition while staying inside
    // maxPriceImpactBps; the test asserts both halves of that.
    uint128 private constant SHIFT = 2e16;
    IPoolManager private manager;
    PositionManager private positions;
    StateView private state;
    OfficialV4SwapDriver private trader;
    DominoVaultV4 private vault;
    DominoVaultFactoryV4 private factory;
    DominoExecutionEngineV4 private engine;
    DominoVaultReadHelper private reader;
    DominoRoutingHelperV4 private routing;
    DominoPriceGuardV4 private oracle;
    PoolKey private key;
    uint256 private tokenId;
    uint256 private counter;
    event GasComparison(uint256 generalGas,uint256 netGas);
    receive() external payable {}

    function _setup(bool nativePair, bool inverse) private {
        NitroTestSetup.install(); vm.roll(1000); vm.warp(1_700_000_000);
        manager = IPoolManager(address(new PoolManager(address(this))));
        positions = new PositionManager(manager,IAllowanceTransfer(address(0x1111)),100000,
            IPositionDescriptor(address(0x2222)),IWETH9(address(0x3333)));
        state = new StateView(manager);
        OfficialV4Controller seed = new OfficialV4Controller(manager,positions);
        trader = new OfficialV4SwapDriver(manager);
        address a=address(new OfficialFixtureToken()); address b=address(new OfficialFixtureToken());
        address c0=nativePair?address(0):(a<b?a:b); address c1=nativePair?a:(a<b?b:a);
        key=PoolKey(Currency.wrap(c0),Currency.wrap(c1),3000,60,IHooks(address(0)));
        _fund(c0,address(seed),1e20); _fund(c1,address(seed),1e20);
        _fund(c0,address(trader),1e20); _fund(c1,address(trader),1e20);
        manager.initialize(key,uint160(1<<96)); seed.seed(key,OPENING); seed.refundSetup(); tokenId=seed.tokenId();
        factory=new DominoVaultFactoryV4(address(manager),address(positions),address(state),RECIPIENT);
        reader=new DominoVaultReadHelper(address(positions),address(state));
        routing=new DominoRoutingHelperV4(); oracle=new DominoPriceGuardV4(PUBLISHER,address(state),GUARD_DEVIATION_BPS,GUARDIAN);
        engine=new DominoExecutionEngineV4(address(factory),address(reader),address(routing),address(oracle));
        DominoVaultV4 implementation=new DominoVaultV4(address(factory),address(manager),address(positions),
            address(state),RECIPIENT,address(reader),address(engine));
        factory.finalizeImplementation(address(implementation));
        address predicted=factory.predictVault(address(this),0); positions.approve(predicted,tokenId);
        T.InitParams memory p; p.rootTokenId=tokenId; p.expectedPoolId=keccak256(abi.encode(key));
        p.baseCurrency=inverse?c1:c0; p.quoteCurrency=inverse?c0:c1; p.consentToUncollectedFees=true;
        p.policy=IDominoVaultDraft.Policy(400,1000,1000,1,4,1,false);
        p.limits=T.ExecutionLimits(1,5000,100,100,1e12,120,3600);
        vault=DominoVaultV4(payable(factory.createVault(p,0)));
        require(address(vault)==predicted && vault.rootPermissionValid(),"actual v4 clone");
    }

    function _fund(address c,address recipient,uint256 amount) private {
        if(c==address(0)) vm.deal(recipient,recipient.balance+amount); else OfficialFixtureToken(c).mint(recipient,amount);
    }

    function _swaps() private { for(uint256 i;i<3;++i){trader.swap(key,true,1e15);trader.swap(key,false,1e15);} }

    function _plan(uint8 action,uint128 liquidity) private returns(E.Plan memory p) {
        vm.roll(block.number+1); vm.warp(block.timestamp+2);
        bytes32 h=keccak256(abi.encode(block.number-1)); vm.setBlockhash(block.number-1,h);
        T.Position memory member=vault.position(tokenId);
        p.authority.intentId=keccak256(abi.encode("v4",++counter)); p.authority.tokenId=tokenId;
        p.authority.positionIdentity=member.identity; p.authority.checkpointId=vault.checkpoint(tokenId).commitment;
        p.authority.policyVersion=vault.policy().version; p.authority.limitsVersion=vault.executionLimits().version;
        p.authority.stateNonce=vault.stateNonce(); p.authority.authorityGeneration=vault.authorityGeneration();
        p.authority.observedAtBlock=uint64(block.number-1); p.authority.observedBlockHash=h;
        p.authority.observedAtTimestamp=uint64(block.timestamp-1); p.authority.deadline=uint64(block.timestamp+60);
        p.authority.liquidityIncrease=liquidity; p.authority.minAdded0=1; p.authority.minAdded1=1;
        p.authority.minSqrtPriceX96=uint160(1<<95); p.authority.maxSqrtPriceX96=uint160(1<<97);
        // Wide by default so the existing cases measure what they always did;
        // the ceiling's own behaviour is pinned by the two tests below.
        p.maxAdded0=type(uint128).max; p.maxAdded1=type(uint128).max;
        p.action=action; p.destinationTokenId=tokenId;
        // Every action carries a published observation now, swap or not.
        p.swap.priceObservationId=_observe(p);
        p.collect=new E.PositionRef[](1);p.collect[0]=E.PositionRef(tokenId,member.identity,p.authority.checkpointId);
        p.budgets=new E.FeeBudget[](2);
        p.budgets[0]=E.FeeBudget(member.source0,Currency.unwrap(key.currency0),type(uint128).max,0,0,0);
        p.budgets[1]=E.FeeBudget(member.source1,Currency.unwrap(key.currency1),type(uint128).max,0,0,0);
        _sort(p.budgets);
    }

    function _sort(E.FeeBudget[] memory b) private pure {
        for(uint256 i;i<b.length;i++)for(uint256 j=i+1;j<b.length;j++)
            if(b[i].sourceId>b[j].sourceId || (b[i].sourceId==b[j].sourceId && b[i].currency>b[j].currency))
                (b[i],b[j])=(b[j],b[i]);
    }

    function _observe(E.Plan memory p) private returns(bytes32) {
        (uint160 price,,,)=state.getSlot0(PoolId.wrap(vault.poolId()));
        DominoPriceGuardV4.Observation memory observation=DominoPriceGuardV4.Observation(vault.poolId(),
            p.authority.observedAtBlock,p.authority.observedBlockHash,p.authority.observedAtTimestamp,
            uint64(block.timestamp+60),price);
        vm.prank(PUBLISHER);return oracle.publish(observation);
    }

    function _withSwap() private returns(E.Plan memory p) {
        _swaps();p=_plan(0,1e10);T.Position memory member=vault.position(tokenId);
        (uint160 price,,,)=state.getSlot0(PoolId.wrap(vault.poolId()));
        p.swap=E.SwapPlan(member.source0,Currency.unwrap(key.currency0),1e9,2e9,0,
            uint128(routing.minimumOutput(1e9,price,true,100)),TickMath.MIN_SQRT_PRICE+1,p.swap.priceObservationId);
        E.FeeBudget[] memory b=new E.FeeBudget[](3);b[0]=p.budgets[0];b[1]=p.budgets[1];
        b[2]=E.FeeBudget(member.source0,Currency.unwrap(key.currency1),0,0,0,0);_sort(b);p.budgets=b;
    }

    event AuditOutput(uint128 honest, uint128 moved, uint256 spotRatioBps);

    // This is the official local-pool fixture, not a replay of a Robinhood fork.
    // Its role is to test the report's inference that an unchanged anchor means
    // zero swap shortfall, rather than to claim a dollar-denominated bound.
    function testPostObservationManipulationStillLowersSuccessfulSwapOutput() external {
        _setup(false,false);
        E.Plan memory p = _withSwap();
        (uint160 original,,,)=state.getSlot0(PoolId.wrap(vault.poolId()));
        uint256 snapshot = vm.snapshotState();
        uint128 honest = _executeOutput(p);
        require(vm.revertToState(snapshot), "restore honest execution");
        trader.swap(key,true,25e14);
        (uint160 moved,,,)=state.getSlot0(PoolId.wrap(vault.poolId()));
        uint256 ratio = routing.ratioBps(moved,original,false);
        require(ratio >= 9940 && ratio <= 9960,"roughly 0.5 percent move");
        // The anchor remains the pre-manipulation observation. The engine and
        // its before/after checks run unmodified against the actual swap.
        uint128 manipulated = _executeOutput(p);
        require(manipulated < honest,"an unchanged anchor does not imply zero shortfall");
        require(honest-manipulated > p.swap.amountIn*4/1000,"more than 0.4 percent lost versus honest swap");
        emit AuditOutput(honest,manipulated,ratio);
    }

    function _executeOutput(E.Plan memory p) private returns(uint128 output) {
        vm.recordLogs();
        vault.execute(p);
        VmExecutionV4.Log[] memory logs=vm.getRecordedLogs();
        bytes32 expected=keccak256("FeesConverted(address,bytes32,bytes32,address,address,uint128,uint128,(uint128,uint128,uint128,uint128,uint128,uint128,uint128,uint128,uint128),uint128,uint128)");
        for(uint256 i;i<logs.length;i++) {
            if(logs[i].emitter==address(engine) && logs[i].topics[0]==expected) {
                (,,,output,,,)=abi.decode(logs[i].data,(address,address,uint128,uint128,T.CompoundAmounts,uint128,uint128));
                return output;
            }
        }
        revert("missing actual swap output event");
    }
}
