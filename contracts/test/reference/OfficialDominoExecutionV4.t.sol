// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OfficialFixtureToken, OfficialV4Controller, OfficialV4SwapDriver, PoolManager,
    PositionManager, IPoolManager, PoolKey, Currency} from "./OfficialV4Fixture.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPositionDescriptor} from "./official-v4/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "./official-v4/v4-periphery/src/interfaces/external/IWETH9.sol";
import {StateView} from "./official-v4/v4-periphery/src/lens/StateView.sol";
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

contract OfficialDominoExecutionV4Test {
    using TransientStateLibrary for IPoolManager;
    VmExecutionV4 private constant vm = VmExecutionV4(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant RECIPIENT = address(0xFEE);
    address private constant PUBLISHER = address(0xA11CE);
    uint128 private constant OPENING = 1e18;
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
        vm.chainId(4663); vm.roll(1000); vm.warp(1_700_000_000);
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
        routing=new DominoRoutingHelperV4(); oracle=new DominoPriceGuardV4(PUBLISHER);
        engine=new DominoExecutionEngineV4(address(factory),address(reader),address(routing),address(oracle));
        DominoVaultV4 implementation=new DominoVaultV4(address(factory),address(manager),address(positions),
            address(state),RECIPIENT,address(reader),address(engine));
        factory.finalizeImplementation(address(implementation));
        address predicted=factory.predictVault(address(this),0); positions.approve(predicted,tokenId);
        T.InitParams memory p; p.rootTokenId=tokenId; p.expectedPoolId=keccak256(abi.encode(key));
        p.baseCurrency=inverse?c1:c0; p.quoteCurrency=inverse?c0:c1; p.consentToUncollectedFees=true;
        p.policy=IDominoVaultDraft.Policy(200,1000,1000,1,4,1,false);
        p.limits=T.ExecutionLimits(1,5000,100,100,1e12,120,3600);
        vault=DominoVaultV4(payable(factory.createVault(p,0)));
        require(address(vault)==predicted && vault.rootPermissionValid(),"actual v4 clone");
    }
    function _fund(address c,address recipient,uint256 amount) private {
        if(c==address(0)) vm.deal(recipient,recipient.balance+amount); else OfficialFixtureToken(c).mint(recipient,amount);
    }
    function _balance(address c,address who) private view returns(uint256) {
        return c==address(0)?who.balance:OfficialFixtureToken(c).balanceOf(who);
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
        p.action=action; p.destinationTokenId=tokenId;
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
    function _stateHash() private view returns(bytes32) {
        T.Position memory m=vault.position(tokenId);
        return keccak256(abi.encode(positions.getPositionLiquidity(tokenId),
            vault.feeBalance(m.source0,Currency.unwrap(key.currency0)),vault.feeBalance(m.source1,Currency.unwrap(key.currency1)),
            _balance(Currency.unwrap(key.currency0),address(vault)),_balance(Currency.unwrap(key.currency1),address(vault)),
            _balance(Currency.unwrap(key.currency0),RECIPIENT),_balance(Currency.unwrap(key.currency1),RECIPIENT),
            vault.accountedCurrency(Currency.unwrap(key.currency0)),vault.accountedCurrency(Currency.unwrap(key.currency1))));
    }
    function _backed() private view {
        require(manager.getNonzeroDeltaCount()==0,"no transient debt");
        require(_balance(Currency.unwrap(key.currency0),address(vault))>=vault.accountedCurrency(Currency.unwrap(key.currency0)),"backed0");
        require(_balance(Currency.unwrap(key.currency1),address(vault))>=vault.accountedCurrency(Currency.unwrap(key.currency1)),"backed1");
    }
    function _reject(E.Plan memory p) private {
        bytes32 before_=_stateHash(); uint64 nonce=vault.stateNonce();
        (bool ok,)=address(vault).call(abi.encodeCall(vault.execute,(p)));
        require(!ok && before_==_stateHash() && nonce==vault.stateNonce() && !vault.consumedIntent(p.authority.intentId),"atomic rejection");
    }
    function testOfficialNettingParityERC20AndGas() external { _parity(false); }
    function testOfficialNettingParityNativeAndGas() external { _parity(true); }
    function _parity(bool nativePair) private {
        _setup(nativePair,false); _swaps(); E.Plan memory p=_plan(0,1e12);
        uint256 snapshot=vm.snapshotState(); uint256 gasBefore=gasleft(); vault.execute(p); uint256 generalGas=gasBefore-gasleft();
        bytes32 generalState=_stateHash(); _backed(); require(vm.revertToState(snapshot),"restore");
        p.action=1; gasBefore=gasleft();vault.execute(p);uint256 netGas=gasBefore-gasleft();
        require(generalState==_stateHash(),"netting economic parity");require(netGas<generalGas,"net optimization measured");
        emit GasComparison(generalGas,netGas); _backed();
    }
    function testNettingRejectsInsufficientRealizedAndChargedPath() external {
        _setup(false,false); _reject(_plan(1,1e12)); _swaps(); E.Plan memory p=_plan(1,1e12);
        p.budgets[0].maxCharged=1;_reject(p);
    }
    function testGeneralUsesWaitingFeesWithoutNewCollectionAndPreservesDonation() external {
        _setup(false,false);_swaps();_fund(Currency.unwrap(key.currency0),address(vault),123);
        uint256 owner0=_balance(Currency.unwrap(key.currency0),address(this));
        vault.execute(_plan(0,1e12)); E.Plan memory p=_plan(0,1e12); p.collect=new E.PositionRef[](0);vault.execute(p);
        require(positions.getPositionLiquidity(tokenId)==OPENING+2e12,"waiting reserve reinvested");
        require(_balance(Currency.unwrap(key.currency0),address(this))==owner0,"no wallet pull");
        require(_balance(Currency.unwrap(key.currency0),address(vault))-vault.accountedCurrency(Currency.unwrap(key.currency0))==123,"donation not fees");_backed();
    }
    function _mint(bool inverse) private returns(uint256 id) {
        _setup(false,inverse);_swaps(); E.Plan memory p=_plan(3,1e10);p.destinationTokenId=0;
        // Price 1 is within the independent 10% trigger of the old ceiling.
        // Floor overlaps <=10%; ceiling is the first spacing-aligned tick >=1.5x.
        p.tickLower=inverse?int24(-4680):int24(-420);p.tickUpper=inverse?int24(420):int24(4680);
        vault.execute(p); id=vault.successorOf(tokenId);
        require(id!=0 && positions.ownerOf(id)==address(vault) && vault.activePositions()==2,"real child minted in custody");
        require(vault.position(id).parentTokenId==tokenId && vault.position(id).active,"membership");
        require(vault.registrationCheckpoint(id).liquidity==1e10,"child principal checkpoint");_backed();
    }
    function testOfficialSuccessorMintAndParentReplay() external {
        uint256 child=_mint(false);E.Plan memory p=_plan(3,1e10);p.destinationTokenId=0;p.tickLower=-420;p.tickUpper=4680;_reject(p);
        require(vault.successorOf(tokenId)==child,"one child per parent");
    }
    function testOfficialInverseSuccessorMint() external { _mint(true); }
    function testFundExistingSuccessorUsingEligibleParentFees() external {
        uint256 child=_mint(false); E.Plan memory p=_plan(2,1e10);p.destinationTokenId=child;vault.execute(p);
        require(positions.getPositionLiquidity(child)==2e10,"funded actual child");_backed();
    }
    function testSuccessorReorgReplayReturnsOneCanonicalChild() external {
        _setup(false,false);_swaps();E.Plan memory p=_plan(3,1e10);p.destinationTokenId=0;p.tickLower=-420;p.tickUpper=4680;
        uint256 snap=vm.snapshotState();vault.execute(p);uint256 id=vault.successorOf(tokenId);
        require(vm.revertToState(snap) && vault.successorOf(tokenId)==0 && !vault.consumedIntent(p.authority.intentId),"reorg removes action");
        vault.execute(p);require(vault.successorOf(tokenId)==id && vault.activePositions()==2,"canonical reexecution");
    }
    function testBadGeometryAndIndependentTriggerDenied() external {
        _setup(false,false);_swaps();E.Plan memory p=_plan(3,1e10);p.destinationTokenId=0;p.tickLower=-420;p.tickUpper=4620;_reject(p);
        p.tickUpper=4680;p.tickLower=-600;_reject(p);
        IDominoVaultDraft.Policy memory rules=vault.policy();rules.triggerDistanceBps=100;rules.version++;
        vault.setPolicy(rules);p=_plan(3,1e10);p.destinationTokenId=0;p.tickLower=-420;p.tickUpper=4680;_reject(p);
    }
    function _withSwap() private returns(E.Plan memory p) {
        _swaps();p=_plan(0,1e10);T.Position memory member=vault.position(tokenId);
        (uint160 price,,,)=state.getSlot0(PoolId.wrap(vault.poolId()));
        DominoPriceGuardV4.Observation memory observation=DominoPriceGuardV4.Observation(vault.poolId(),p.authority.observedAtBlock,
            p.authority.observedBlockHash,p.authority.observedAtTimestamp,uint64(block.timestamp+60),price);
        vm.prank(PUBLISHER);bytes32 id=oracle.publish(observation);
        p.swap=E.SwapPlan(member.source0,Currency.unwrap(key.currency0),1e9,2e9,0,
            uint128(routing.minimumOutput(1e9,price,true,100)),TickMath.MIN_SQRT_PRICE+1,id);
        E.FeeBudget[] memory b=new E.FeeBudget[](3);b[0]=p.budgets[0];b[1]=p.budgets[1];
        b[2]=E.FeeBudget(member.source0,Currency.unwrap(key.currency1),0,0,0,0);_sort(b);p.budgets=b;
    }
    function testOfficialSwapConservationAndChargeOnceLineage() external {
        _setup(false,false);E.Plan memory p=_withSwap();T.Position memory member=vault.position(tokenId);
        uint256 owner0=_balance(Currency.unwrap(key.currency0),address(this));
        vault.execute(p);T.FeeBalance memory converted=vault.feeBalance(member.source0,Currency.unwrap(key.currency1));
        require(converted.original==0 && converted.charged>0,"converted output original source charged-only");
        require(_balance(Currency.unwrap(key.currency0),address(this))==owner0,"no wallet authority");
        E.Plan memory next=_plan(0,1e9);E.FeeBudget[] memory b=new E.FeeBudget[](2);
        b[0]=E.FeeBudget(member.source0,Currency.unwrap(key.currency0),type(uint128).max,0,0,0);
        b[1]=E.FeeBudget(member.source0,Currency.unwrap(key.currency1),0,type(uint128).max,0,0);_sort(b);next.budgets=b;
        uint256 recipient1=_balance(Currency.unwrap(key.currency1),RECIPIENT);vault.execute(next);
        require(_balance(Currency.unwrap(key.currency1),RECIPIENT)==recipient1,"no second charge on converted output");_backed();
    }
    function testSwapMinimumPartialFillRevocationAndExpiredAtomic() external {
        _setup(false,false);E.Plan memory p=_withSwap();uint128 minimum=p.swap.minAmountOut;
        p.swap.minAmountOut=type(uint128).max;_reject(p);p.swap.minAmountOut=minimum;
        (uint160 current,,,)=state.getSlot0(PoolId.wrap(vault.poolId()));p.swap.sqrtPriceLimitX96=current-1;_reject(p);
        p.swap.sqrtPriceLimitX96=TickMath.MIN_SQRT_PRICE+1;vm.prank(PUBLISHER);oracle.revoke(p.swap.priceObservationId);_reject(p);
        p=_withSwap();vm.warp(block.timestamp+61);_reject(p);
    }
    function testOwnerCanExitChildrenAndFeesWhenEngineUnavailable() external {
        uint256 child=_mint(false);vm.etch(address(engine),hex"00");
        vault.withdrawChildPosition(child);require(positions.ownerOf(child)==address(this),"owner child exit independent engine");
        positions.approve(address(0),tokenId);require(!vault.rootPermissionValid(),"owner can revoke root");
    }
    function testCallbacksAndForeignSourcesNeverAdmitted() external {
        _setup(false,false);_swaps();E.Plan memory p=_plan(0,1e10);p.budgets[0].sourceId=keccak256("foreign sequence");_reject(p);
        (bool ok,)=address(engine).call(abi.encodeCall(engine.unlockCallback,(bytes("forged"))));require(!ok,"no arbitrary callback");
        (ok,)=address(vault).call(abi.encodeCall(vault.executionConvert,(keccak256("fake"),Currency.unwrap(key.currency0),uint128(1))));require(!ok,"no arbitrary fee credit");
    }
}
