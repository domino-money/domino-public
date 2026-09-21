// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NitroTestSetup} from "../shared/NitroTestSetup.sol";
import {OfficialFixtureToken, OfficialV4Controller, PoolManager, PositionManager, IPoolManager,
    PoolKey, Currency} from "../reference/OfficialV4Fixture.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
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

interface SwapVm {
    function roll(uint256) external;
    function warp(uint256) external;
    function setBlockhash(uint256,bytes32) external;
    function prank(address) external;
}

/// Test-only initial state for charged balances left by a prior implementation.
/// Real token backing is required by the production credit functions. The
/// production vault has no seed API; the engine and official AMM remain real.
contract LegacyChargedVaultV4 is DominoVaultV4 {
    constructor(address f,address m,address p,address s,address recipient,address helper,address engine)
        DominoVaultV4(f,m,p,s,recipient,helper,engine) {}
    function seedCharged(bytes32 sourceId,address currency,uint128 amount) external {
        require(msg.sender == owner,"fixture owner"); _creditConvertedFees(sourceId,currency,amount);
    }
    function seedOriginal(uint256 tokenId,uint128 amount0,uint128 amount1) external {
        require(msg.sender == owner,"fixture owner"); _creditOriginalFees(tokenId,amount0,amount1);
    }
}

contract SwapReinvestmentTest {
    SwapVm private constant vm=SwapVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant RECIPIENT=address(0xFEE);
    address private constant PUBLISHER=address(0xA11CE);
    uint128 private constant RESERVE=1e12;
    uint128 private constant INPUT=1e9;
    uint128 private constant OLD_OUTPUT=1e8;
    uint128 private constant OLD_FLOOR=1e7;
    IPoolManager private manager;
    PositionManager private positions;
    StateView private state;
    LegacyChargedVaultV4 private vault;
    DominoRoutingHelperV4 private routing;
    DominoPriceGuardV4 private guard;
    PoolKey private key;
    uint256 private tokenId;
    uint256 private serial;

    function _setup(uint16 rate) private {
        NitroTestSetup.install();vm.roll(1000);vm.warp(1_700_000_000);
        manager=IPoolManager(address(new PoolManager(address(this))));
        positions=new PositionManager(manager,IAllowanceTransfer(address(0x1111)),100000,
            IPositionDescriptor(address(0x2222)),IWETH9(address(0x3333)));
        state=new StateView(manager);
        address a=address(new OfficialFixtureToken());address b=address(new OfficialFixtureToken());
        key=PoolKey(Currency.wrap(a<b?a:b),Currency.wrap(a<b?b:a),3000,60,IHooks(address(0)));
        OfficialV4Controller seed=new OfficialV4Controller(manager,positions);
        _mint(Currency.unwrap(key.currency0),address(seed),1e20);
        _mint(Currency.unwrap(key.currency1),address(seed),1e20);
        manager.initialize(key,uint160(1<<96));seed.seed(key,1e18);seed.refundSetup();tokenId=seed.tokenId();
        DominoVaultFactoryV4 factory=new DominoVaultFactoryV4(address(manager),address(positions),address(state),RECIPIENT);
        DominoVaultReadHelper helper=new DominoVaultReadHelper(address(positions),address(state));
        routing=new DominoRoutingHelperV4();guard=new DominoPriceGuardV4(PUBLISHER,address(state),50,address(0x6A2D));
        DominoExecutionEngineV4 engine=new DominoExecutionEngineV4(address(factory),address(helper),address(routing),address(guard));
        LegacyChargedVaultV4 implementation=new LegacyChargedVaultV4(address(factory),address(manager),address(positions),
            address(state),RECIPIENT,address(helper),address(engine));
        factory.finalizeImplementation(address(implementation));
        positions.approve(factory.predictVault(address(this),0),tokenId);
        T.InitParams memory p;p.rootTokenId=tokenId;p.expectedPoolId=keccak256(abi.encode(key));
        p.baseCurrency=Currency.unwrap(key.currency0);p.quoteCurrency=Currency.unwrap(key.currency1);p.consentToUncollectedFees=true;
        p.policy=IDominoVaultDraft.Policy(rate,1000,1000,1,rate==200?1:4,1,false);
        p.limits=T.ExecutionLimits(1,5000,100,100,1e12,120,3600);
        vault=LegacyChargedVaultV4(payable(factory.createVault(p,0)));
        T.Position memory member=vault.position(tokenId);
        _seed(member.source0,Currency.unwrap(key.currency0),RESERVE);
        _seed(member.source1,Currency.unwrap(key.currency1),RESERVE);
    }
    function _mint(address currency,address to,uint256 amount) private { OfficialFixtureToken(currency).mint(to,amount); }
    function _seed(bytes32 sourceId,address currency,uint128 amount) private {
        _mint(currency,address(vault),amount);vault.seedCharged(sourceId,currency,amount);
    }
    function _sort(E.FeeBudget[] memory budgets) private pure {
        for(uint256 i;i<budgets.length;i++)for(uint256 j=i+1;j<budgets.length;j++)
            if(budgets[i].sourceId>budgets[j].sourceId || (budgets[i].sourceId==budgets[j].sourceId && budgets[i].currency>budgets[j].currency))
                (budgets[i],budgets[j])=(budgets[j],budgets[i]);
    }
    function _plan(bool zeroForOne,uint128 increase,uint128 oldFloor) private returns(E.Plan memory p) {
        // Explicit fixture values avoid optimizer reuse of NUMBER/TIMESTAMP
        // across cheatcodes, which real EVM calls cannot change mid-transaction.
        uint64 observedBlock=uint64(1000+serial);uint64 observedTime=uint64(1_700_000_000+serial*2);
        vm.roll(uint256(observedBlock)+1);vm.warp(uint256(observedTime)+1);
        bytes32 h=keccak256(abi.encode(observedBlock));vm.setBlockhash(observedBlock,h);
        T.Position memory member=vault.position(tokenId);
        p.authority.intentId=keccak256(abi.encode("swap reinvestment",++serial));p.authority.tokenId=tokenId;
        p.authority.positionIdentity=member.identity;p.authority.checkpointId=vault.checkpoint(tokenId).commitment;
        p.authority.policyVersion=vault.policy().version;p.authority.limitsVersion=1;p.authority.stateNonce=vault.stateNonce();
        p.authority.authorityGeneration=vault.authorityGeneration();p.authority.observedAtBlock=observedBlock;
        p.authority.observedBlockHash=h;p.authority.observedAtTimestamp=observedTime;p.authority.deadline=observedTime+61;
        p.authority.liquidityIncrease=increase;p.authority.minAdded0=1;p.authority.minAdded1=1;
        p.authority.minSqrtPriceX96=uint160(1<<95);p.authority.maxSqrtPriceX96=uint160(1<<97);
        p.maxAdded0=type(uint128).max;p.maxAdded1=type(uint128).max;p.destinationTokenId=tokenId;
        (uint160 price,,,)=state.getSlot0(PoolId.wrap(vault.poolId()));
        DominoPriceGuardV4.Observation memory observation=DominoPriceGuardV4.Observation(vault.poolId(),
            p.authority.observedAtBlock,h,p.authority.observedAtTimestamp,p.authority.deadline,price);
        vm.prank(PUBLISHER);bytes32 observationId=guard.publish(observation);
        bytes32 sourceId=zeroForOne?member.source0:member.source1;
        address input=Currency.unwrap(zeroForOne?key.currency0:key.currency1);
        address output=Currency.unwrap(zeroForOne?key.currency1:key.currency0);
        p.swap=E.SwapPlan(sourceId,input,INPUT,0,INPUT,uint128(routing.minimumOutput(INPUT,price,zeroForOne,100)),
            zeroForOne?TickMath.MIN_SQRT_PRICE+1:TickMath.MAX_SQRT_PRICE-1,observationId);
        p.budgets=new E.FeeBudget[](3);
        p.budgets[0]=E.FeeBudget(member.source0,Currency.unwrap(key.currency0),0,RESERVE,0,0);
        p.budgets[1]=E.FeeBudget(member.source1,Currency.unwrap(key.currency1),0,RESERVE,0,0);
        p.budgets[2]=E.FeeBudget(sourceId,output,0,oldFloor,0,oldFloor);_sort(p.budgets);
    }
    function _currencyHash(address currency) private view returns(bytes32) {
        T.Position memory member=vault.position(tokenId);
        return keccak256(abi.encode(vault.feeBalance(member.source0,currency),vault.feeBalance(member.source1,currency),
            OfficialFixtureToken(currency).balanceOf(address(vault)),OfficialFixtureToken(currency).balanceOf(address(manager)),
            OfficialFixtureToken(currency).balanceOf(RECIPIENT),vault.accountedCurrency(currency)));
    }
    function _stateHash() private view returns(bytes32) {
        (uint160 price,int24 tick,,)=state.getSlot0(PoolId.wrap(vault.poolId()));
        return keccak256(abi.encode(positions.getPositionLiquidity(tokenId),vault.stateNonce(),vault.lastExecutionAt(),
            vault.checkpoint(tokenId),price,tick,_currencyHash(Currency.unwrap(key.currency0)),_currencyHash(Currency.unwrap(key.currency1))));
    }
    function _reject(E.Plan memory p,bytes4 selector) private {
        bytes32 beforeState=_stateHash();
        (bool ok,bytes memory result)=address(vault).call(abi.encodeCall(vault.execute,(p)));
        require(!ok && result.length>=4 && bytes4(result)==selector,"expected rejection");
        require(beforeState==_stateHash() && !vault.consumedIntent(p.authority.intentId),"atomic rollback including fees and pool");
    }
    function testProductiveChargedOnlySwapsAtBothTariffsPreserveOldFloorsInEitherSourceOrder() external {
        for(uint16 rate=200;rate<=400;rate+=200) {
            _setup(rate);T.Position memory member=vault.position(tokenId);
            for(uint256 direction;direction<2;direction++) {
                bool zero=direction==0;bytes32 sourceId=zero?member.source0:member.source1;
                address output=Currency.unwrap(zero?key.currency1:key.currency0);
                _seed(sourceId,output,OLD_OUTPUT);
                E.Plan memory p=_plan(zero,1e11,OLD_FLOOR);vault.execute(p);
                require(vault.feeBalance(sourceId,output).charged==OLD_OUTPUT-OLD_FLOOR,"new output plus old allocation consumed");
            }
            require(OfficialFixtureToken(Currency.unwrap(key.currency0)).balanceOf(RECIPIENT)==0
                && OfficialFixtureToken(Currency.unwrap(key.currency1)).balanceOf(RECIPIENT)==0,"charged lots never charged again");
        }
    }
    function testOversizedSwapAndDustOriginalCannotUseTinyAddToRetainOutput() external {
        for(uint16 rate=200;rate<=400;rate+=200) {
            _setup(rate);E.Plan memory p=_plan(true,1e10,0);
            _reject(p,DominoExecutionEngineV4.InvalidAmount.selector);
            _mint(Currency.unwrap(key.currency0),address(vault),1);vault.seedOriginal(tokenId,1,0);
            p.swap.maxOriginal=1;p.swap.maxCharged=INPUT-1;
            for(uint256 i;i<p.budgets.length;i++)if(p.budgets[i].sourceId==p.swap.sourceId && p.budgets[i].currency==p.swap.currencyIn) {
                p.budgets[i].minOriginal=1;p.budgets[i].maxOriginal=1;
            }
            _reject(p,DominoExecutionEngineV4.InvalidAmount.selector);
        }
    }
    function testProductiveOriginalSwapKeepsSingleModeFee() external {
        for(uint16 rate=200;rate<=400;rate+=200) {
            _setup(rate);E.Plan memory p=_plan(true,1e11,0);
            uint128 gross=uint128((uint256(INPUT)-1)*10000/(10000-rate)+1);
            _mint(p.swap.currencyIn,address(vault),gross);vault.seedOriginal(tokenId,gross,0);
            p.swap.maxOriginal=gross;p.swap.maxCharged=0;
            for(uint256 i;i<p.budgets.length;i++)if(p.budgets[i].sourceId==p.swap.sourceId && p.budgets[i].currency==p.swap.currencyIn) {
                p.budgets[i].minOriginal=gross;p.budgets[i].maxOriginal=gross;
            }
            vault.execute(p);
            require(OfficialFixtureToken(p.swap.currencyIn).balanceOf(RECIPIENT)==uint256(gross)*rate/10000,"one fee at selected rate");
            require(vault.feeBalance(p.swap.sourceId,Currency.unwrap(key.currency1)).charged==0,"all output consumed");
        }
    }
    function testLegacyWaitingChargedReservesRemainFundableWithoutSwap() external {
        _setup(200);E.Plan memory p=_plan(true,1e11,0);bytes32 observation=p.swap.priceObservationId;
        delete p.swap;p.swap.priceObservationId=observation;
        E.FeeBudget[] memory budgets=new E.FeeBudget[](2);T.Position memory member=vault.position(tokenId);
        budgets[0]=E.FeeBudget(member.source0,Currency.unwrap(key.currency0),0,RESERVE,0,0);
        budgets[1]=E.FeeBudget(member.source1,Currency.unwrap(key.currency1),0,RESERVE,0,0);_sort(budgets);p.budgets=budgets;
        vault.execute(p);
        require(vault.feeBalance(member.source0,Currency.unwrap(key.currency0)).charged<RESERVE
            && vault.feeBalance(member.source1,Currency.unwrap(key.currency1)).charged<RESERVE,"old charged reserves reinvested");
        require(OfficialFixtureToken(Currency.unwrap(key.currency0)).balanceOf(RECIPIENT)==0
            && OfficialFixtureToken(Currency.unwrap(key.currency1)).balanceOf(RECIPIENT)==0,"legacy remains charged once");
    }
    function testConvertedCreditOverflowFailsClosed() external {
        _setup(400);T.Position memory member=vault.position(tokenId);
        _seed(member.source0,Currency.unwrap(key.currency1),type(uint128).max-100);
        E.Plan memory p=_plan(true,1e11,0);
        _reject(p,bytes4(0x4e487b71));
    }
}
