// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OfficialFixtureToken, OfficialV4Controller, OfficialV4SwapDriver, PoolManager,
    PositionManager, IPoolManager, PoolKey, Currency} from "./OfficialV4Fixture.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
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
        routing=new DominoRoutingHelperV4(); oracle=new DominoPriceGuardV4(PUBLISHER,address(state),GUARD_DEVIATION_BPS,GUARDIAN);
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
    function _stateHash() private view returns(bytes32) {
        T.Position memory m=vault.position(tokenId);
        return keccak256(abi.encode(positions.getPositionLiquidity(tokenId),
            vault.feeBalance(m.source0,Currency.unwrap(key.currency0)),vault.feeBalance(m.source1,Currency.unwrap(key.currency1)),
            _balance(Currency.unwrap(key.currency0),address(vault)),_balance(Currency.unwrap(key.currency1),address(vault)),
            _balance(Currency.unwrap(key.currency0),RECIPIENT),_balance(Currency.unwrap(key.currency1),RECIPIENT),
            vault.accountedCurrency(Currency.unwrap(key.currency0)),vault.accountedCurrency(Currency.unwrap(key.currency1))));
    }
    function _owed(uint256 id,uint128 liquidity) private view returns(uint128 a,uint128 b) {
        T.Position memory m=vault.position(id);(uint160 price,,,)=state.getSlot0(PoolId.wrap(vault.poolId()));
        uint160 lower=TickMath.getSqrtPriceAtTick(m.tickLower);uint160 upper=TickMath.getSqrtPriceAtTick(m.tickUpper);
        if(price<upper)a=uint128(SqrtPriceMath.getAmount0Delta(price<lower?lower:price,upper,liquidity,true));
        if(price>lower)b=uint128(SqrtPriceMath.getAmount1Delta(lower,price>upper?upper:price,liquidity,true));
    }
    function _oldAllocations(E.Plan memory p) private view {
        (uint128 a,uint128 b)=_owed(p.destinationTokenId,p.authority.liquidityIncrease);
        for(uint256 i;i<p.budgets.length;++i) {
            E.FeeBudget memory budget=p.budgets[i];uint128 net=budget.currency==Currency.unwrap(key.currency0)?a:b;
            budget.minOriginal=uint128(net==0?0:(uint256(net)-1)*10000/9800+1);
            budget.maxOriginal=budget.minOriginal;
        }
    }
    function _backed() private view {
        require(manager.getNonzeroDeltaCount()==0,"no transient debt");
        require(_balance(Currency.unwrap(key.currency0),address(vault))>=vault.accountedCurrency(Currency.unwrap(key.currency0)),"backed0");
        require(_balance(Currency.unwrap(key.currency1),address(vault))>=vault.accountedCurrency(Currency.unwrap(key.currency1)),"backed1");
    }
    /// Rejected, and rejected by the guard named - a plan refused late by the
    /// engine is not the same as one refused early by validate.
    function _rejectWith(E.Plan memory p, bytes4 expected, string memory what) private {
        bytes32 before_=_stateHash(); uint64 nonce=vault.stateNonce();
        (bool ok, bytes memory out)=address(vault).call(abi.encodeCall(vault.execute,(p)));
        require(!ok && out.length>=4 && bytes4(out)==expected, what);
        require(before_==_stateHash() && nonce==vault.stateNonce()
            && !vault.consumedIntent(p.authority.intentId), what);
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
        vault.execute(_plan(0,1e12)); E.Plan memory p=_plan(0,1e12); p.collect=new E.PositionRef[](0);_oldAllocations(p);vault.execute(p);
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
        uint256 child=_mint(false); _swaps(); E.Plan memory p=_plan(2,1e10);p.destinationTokenId=child;vault.execute(p);
        require(positions.getPositionLiquidity(child)==2e10,"funded actual child");_backed();
    }
    function testSuccessorReorgReplayReturnsOneCanonicalChild() external {
        _setup(false,false);_swaps();E.Plan memory p=_plan(3,1e10);p.destinationTokenId=0;p.tickLower=-420;p.tickUpper=4680;
        uint256 snap=vm.snapshotState();vault.execute(p);uint256 id=vault.successorOf(tokenId);
        require(vm.revertToState(snap) && vault.successorOf(tokenId)==0 && !vault.consumedIntent(p.authority.intentId),"reorg removes action");
        vault.execute(p);require(vault.successorOf(tokenId)==id && vault.activePositions()==2,"canonical reexecution");
    }
    /// The per-execution scratch is transient (EIP-1153), so it is discarded at
    /// the end of the TRANSACTION, not the end of the call. A forge test body is
    /// one transaction, so this pins what that lifetime actually costs: after a
    /// success and after a rejection, every flag is back to zero and the next
    /// guarded call is admitted. If any clear were dropped, the second execute
    /// would revert ReentrantCall or InvalidExecution instead.
    function testTransientScratchClearsBetweenCallsInOneTransaction() external {
        _setup(false,false); _swaps();
        vault.execute(_plan(0,1e12));
        E.Plan memory bad=_plan(1,1e12); bad.budgets[0].maxCharged=1; _reject(bad);
        _swaps(); vault.execute(_plan(0,1e12));
        require(vault.activePositions()==1,"two executions and a rejection in one transaction");
        // An owner action in the same transaction as an execution: the guard
        // and the modify flag are provably clear, since dropping either clear
        // fails this test. The compound flag's own clear is NOT pinned here -
        // its only same-transaction consequence is that _payExact tightens the
        // recipient receipt, which needs a recipient whose balance does not
        // move exactly, and this suite has none.
        vault.rearmRoot(true);
        require(vault.rootArmed(),"owner rearm admitted after an execution");
        _backed();
    }

    /**
     * The ceiling binds every action and an absent one fails closed.
     *
     * Before it existed the plan could state only a floor, so for a committed
     * liquidity the composition of the add was free anywhere inside
     * maxPriceImpactBps - a global owner knob whose job is liveness.
     */
    function testAddCeilingBindsEveryActionAndFailsClosed() external {
        _setup(false,false); _swaps();
        // A plan that never learned about the field is refused in validate,
        // before anything executes - InvalidExecution, not the engine's
        // InvalidAmount, which is what makes the failure early and legible.
        E.Plan memory p=_plan(0,1e12); p.maxAdded0=0; p.maxAdded1=0;
        _rejectWith(p, DominoRoutingHelperV4.InvalidExecution.selector, "absent ceiling refused in validate");
        // A ceiling below the plan's own floor is unsatisfiable; refused there too.
        p=_plan(0,1e12); p.maxAdded0=0;
        _rejectWith(p, DominoRoutingHelperV4.InvalidExecution.selector, "ceiling below its own floor");
        // Past validate, each action's own site must trip.
        p=_plan(0,1e12); p.maxAdded0=1; _reject(p);
        p=_plan(1,1e12); p.maxAdded1=1; _reject(p);
        E.Plan memory mint=_plan(3,1e10); mint.destinationTokenId=0;
        mint.tickLower=-420; mint.tickUpper=4680; mint.maxAdded0=1; _reject(mint);
        // Wide, and the committed liquidity is what it always was.
        vault.execute(_plan(0,1e12));
        require(positions.getPositionLiquidity(tokenId)==OPENING+1e12,"committed liquidity unchanged");
        _backed();
    }

    /**
     * The finding itself, measured: one plan, three worlds.
     *
     * A third party moves the price - not the operator - and the composition
     * of the add moves with it under calldata that never changes. Measured on
     * this fixture with the band an owner may legitimately choose: the same
     * plan costs 29,555,984,009 of currency1 at the unmoved price,
     * 49,495,984,009 after an outside buy and 10,005,699,277 after an outside
     * sell. Every other check admits all three, which the second world proves
     * by executing the identical plan with only the ceiling widened.
     *
     * COST cannot rot unnoticed: the add is asserted to succeed at exactly
     * COST and to fail at COST - 1, so a fixture change that moves the real
     * cost fails here instead of quietly weakening the test.
     */
    function testAddCeilingRefusesInBandCompositionShift() external {
        _setup(false,false); _swaps();
        // maxPriceImpactBps is a liveness knob an owner may set as wide as
        // 9999. At the fixture's 100 the composition barely moves; at 1000 it
        // moves by two thirds, and nothing but a ceiling can refuse that.
        vault.setExecutionLimits(T.ExecutionLimits(2,5000,1000,1000,1e12,120,3600));
        uint128 cost=29555984009;
        E.Plan memory p=_plan(0,1e12);
        p.maxAdded0=type(uint128).max; p.maxAdded1=cost-1;
        _reject(p);

        p.maxAdded1=cost;
        uint256 root=vm.snapshotState();
        trader.swap(key,false,SHIFT);
        _reject(p);                               // refused by the ceiling alone
        require(vm.revertToState(root),"restore");

        root=vm.snapshotState();
        trader.swap(key,false,SHIFT);
        E.Plan memory wide=p; wide.maxAdded1=type(uint128).max;
        vault.execute(wide);                      // and admitted by everything else
        require(positions.getPositionLiquidity(tokenId)==OPENING+1e12,"the shift is inside the band");
        _backed();
        require(vm.revertToState(root),"restore");

        vault.execute(p);
        require(positions.getPositionLiquidity(tokenId)==OPENING+1e12,"exactly the honest cost is admitted");
        _backed();
    }

    function testBadGeometryAndIndependentTriggerDenied() external {
        _setup(false,false);_swaps();E.Plan memory p=_plan(3,1e10);p.destinationTokenId=0;p.tickLower=-420;p.tickUpper=4620;_reject(p);
        p.tickUpper=4680;p.tickLower=-600;_reject(p);
        IDominoVaultDraft.Policy memory rules=vault.policy();rules.triggerDistanceBps=100;rules.version++;
        vault.setPolicy(rules);p=_plan(3,1e10);p.destinationTokenId=0;p.tickLower=-420;p.tickUpper=4680;_reject(p);
    }
    /// @dev Publish this plan's observation at the pool's current price.
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
    function testOfficialSwapConservationAndChargeOnceLineage() external {
        _setup(false,false);E.Plan memory p=_withSwap();T.Position memory member=vault.position(tokenId);
        uint256 owner0=_balance(Currency.unwrap(key.currency0),address(this));
        vault.execute(p);T.FeeBalance memory converted=vault.feeBalance(member.source0,Currency.unwrap(key.currency1));
        require(converted.original==0 && converted.charged>0,"converted output original source charged-only");
        require(_balance(Currency.unwrap(key.currency0),address(this))==owner0,"no wallet authority");
        E.Plan memory next=_plan(0,1e9);E.FeeBudget[] memory b=new E.FeeBudget[](2);
        b[0]=E.FeeBudget(member.source0,Currency.unwrap(key.currency0),type(uint128).max,0,0,0);
        b[1]=E.FeeBudget(member.source0,Currency.unwrap(key.currency1),0,type(uint128).max,0,0);_sort(b);next.budgets=b;
        (uint128 owed0,uint128 owed1)=_owed(tokenId,1e9);
        for(uint256 i;i<next.budgets.length;i++) {
            if(next.budgets[i].currency==Currency.unwrap(key.currency0)) {
                next.budgets[i].minOriginal=uint128((uint256(owed0)-1)*10000/9800+1);
                next.budgets[i].maxOriginal=next.budgets[i].minOriginal;
            } else { next.budgets[i].minCharged=owed1;next.budgets[i].maxCharged=owed1; }
        }
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
    /// Both doors the name promises. The fee door is the one that matters and
    /// the one this test used to skip: withdrawFeeReserves deliberately carries
    /// no deployment-pin check (DominoVaultV4.sol:475-479), so an owner whose
    /// engine has been replaced or destroyed can still reach the reserve. That
    /// property was pinned for V3 and unpinned for V4 until now.
    function testOwnerCanExitChildrenAndFeesWhenEngineUnavailable() external {
        uint256 child=_mint(false);
        T.Position memory member=vault.position(tokenId);
        address c0=Currency.unwrap(key.currency0);
        T.FeeBalance memory reserve=vault.feeBalance(member.source0,c0);
        require(reserve.original!=0 || reserve.charged!=0,"the fixture leaves a reserve to exit");

        vm.etch(address(engine),hex"00");
        require(!vault.rootPermissionValid(),"the deployment pin is broken");
        vault.withdrawChildPosition(child);require(positions.ownerOf(child)==address(this),"owner child exit independent engine");

        uint256 before_=_balance(c0,address(this));
        vault.withdrawFeeReserves(member.source0,c0,reserve.original,reserve.charged);
        require(_balance(c0,address(this))==before_+uint256(reserve.original)+reserve.charged,"the reserve reached the owner");
        T.FeeBalance memory left=vault.feeBalance(member.source0,c0);
        require(left.original==0 && left.charged==0,"and the ledger is empty");

        positions.approve(address(0),tokenId);require(!vault.rootPermissionValid(),"owner can revoke root");
    }
    function testCallbacksAndForeignSourcesNeverAdmitted() external {
        _setup(false,false);_swaps();E.Plan memory p=_plan(0,1e10);p.budgets[0].sourceId=keccak256("foreign sequence");_reject(p);
        (bool ok,)=address(engine).call(abi.encodeCall(engine.unlockCallback,(bytes("forged"))));require(!ok,"no arbitrary callback");
        (ok,)=address(vault).call(abi.encodeCall(vault.executionConvert,(keccak256("fake"),Currency.unwrap(key.currency0),uint128(1))));require(!ok,"no arbitrary fee credit");
    }
    function testRootTransferAndUnexpectedNftRecoveryRemainOwnerOnly() external {
        _setup(false,false);
        OfficialV4Controller extra=new OfficialV4Controller(manager,positions);
        _fund(Currency.unwrap(key.currency0),address(extra),1e18);
        _fund(Currency.unwrap(key.currency1),address(extra),1e18);
        extra.seed(key,1e12); uint256 id=extra.tokenId();
        positions.transferFrom(address(this),address(vault),id);
        vm.prank(address(0xBAD));(bool ok,)=address(vault).call(abi.encodeCall(vault.recoverUnmanagedPosition,(id)));
        require(!ok,"foreign recovery denied");
        vm.etch(address(reader),hex"00");vault.recoverUnmanagedPosition(id);
        require(positions.ownerOf(id)==address(this),"unmanaged owner exit independent helper");
        positions.transferFrom(address(this),address(0xBEEF),tokenId);
        require(!vault.rootPermissionValid() && positions.ownerOf(tokenId)==address(0xBEEF),"root wallet transfer independent protocol");
    }
    function testCapIncludesRootAndUnconsumedFloorReverts() external {
        _setup(false,false);_swaps();E.Plan memory p=_plan(0,1e10);
        p.budgets[0].minOriginal=type(uint128).max;_reject(p);
        IDominoVaultDraft.Policy memory policy=vault.policy();policy.maxPositions=1;policy.version++;
        vault.setPolicy(policy);p=_plan(3,1e10);p.destinationTokenId=0;p.tickLower=-420;p.tickUpper=4680;_reject(p);
        require(vault.activePositions()==1,"root occupies cap");
    }
    function testCumulativeFloorAndPriceImpactCeilingAreExact() external {
        routing=new DominoRoutingHelperV4();T.CompoundAmounts memory input;input.originalBefore=100;
        T.CompoundAmounts memory first=routing.compoundAmounts(input,25,100,0,200,0,0);
        require(first.grossOriginalConsumed==25 && first.serviceFee==0,"first half floor");
        input.originalBefore=75;
        T.CompoundAmounts memory second=routing.compoundAmounts(input,24,75,0,200,25,25);
        require(second.grossOriginalConsumed==25 && second.serviceFee==1,"aggregate 50 charges one");
        uint160 referencePrice=uint160(1<<96);
        // Strict upper bound: a fractional basis point over a zero impact
        // tolerance is not admitted by a floor-to-integer comparison.
        (bool ok,)=address(routing).call(abi.encodeCall(routing.checkSwapPrices,(referencePrice,referencePrice+1,referencePrice,uint16(0))));
        require(!ok,"no sub-basis-point overrun");
    }

    function testCollectionCapCannotConsumeOldUnallocatedFees() external {
        _setup(false,false);_swaps();vault.execute(_plan(0,1e12));
        // Same source has plenty of waiting fees, but no new fees were earned.
        // A future collection cap is not consent to debit that old balance.
        E.Plan memory p=_plan(0,1e12);_reject(p);
        _oldAllocations(p);vault.execute(p);_backed();
    }

}
