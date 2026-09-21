// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NitroTestSetup} from "../shared/NitroTestSetup.sol";

import {OfficialV4Controller, OfficialV4SwapDriver, PoolManager,
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

import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";

interface VmTaxRoutes {
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

/// @notice Synthetic, route-selective 3% burn. This is not a model of QUOTRON,
/// any deployed token, a swap hook charge, or a claim of token admission.
contract SelectiveTaxToken {
    mapping(address => uint256) public balanceOf;
    mapping(bytes32 => uint256) public routeGross;
    address public taxFrom;
    address public taxTo;
    uint256 public taxFromCall;
    uint256 public matchingCalls;
    uint256 public taxBurned;
    uint256 public positiveTransfers;
    event Transfer(address indexed from, address indexed to, uint256 amount);

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    /// @dev Skip preceding transfers on the same route to isolate a swap output
    /// after GENERAL collected the same currency. Zero disables the tax.
    function configure(address from, address to, uint256 firstTaxedCall) external {
        taxFrom=from; taxTo=to; taxFromCall=firstTaxedCall; matchingCalls=0;
    }

    function transfer(address to, uint256 amount) external returns(bool) {
        uint256 burned;
        if(amount != 0) {
            ++positiveTransfers;
            routeGross[keccak256(abi.encode(msg.sender,to))] += amount;
            if(msg.sender == taxFrom && to == taxTo) {
                ++matchingCalls;
                if(taxFromCall != 0 && matchingCalls >= taxFromCall) burned=amount*300/10000;
            }
        }
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount-burned;
        taxBurned += burned;
        emit Transfer(msg.sender,to,amount-burned);
        if(burned != 0) emit Transfer(msg.sender,address(0),burned);
        return true;
    }
}

/// @dev Controlled fee-growth fixture for a zero-residual rounding case. The
/// main route tests accrue real fees with swaps; only that dust case donates.
contract TaxRouteFeeDonor is IUnlockCallback {
    IPoolManager private immutable manager;
    constructor(IPoolManager manager_) { manager=manager_; }
    function donate(PoolKey memory key,uint256 amount0,uint256 amount1) external {
        manager.unlock(abi.encode(key,amount0,amount1));
    }
    function unlockCallback(bytes calldata data) external returns(bytes memory) {
        require(msg.sender == address(manager),"manager only");
        (PoolKey memory key,uint256 amount0,uint256 amount1)=abi.decode(data,(PoolKey,uint256,uint256));
        manager.donate(key,amount0,amount1,bytes(""));
        _settle(key.currency0,amount0); _settle(key.currency1,amount1);
        return "";
    }
    function _settle(Currency currency,uint256 amount) private {
        if(amount == 0) return;
        manager.sync(currency);
        SelectiveTaxToken(Currency.unwrap(currency)).transfer(address(manager),amount);
        require(manager.settle() == amount,"exact donation");
    }
}

/// @notice Runs the actual Domino bytecode against official V4 core/periphery.
/// Selective taxation isolates physical transfers from core's internal netting.
/// Nominal core credit must be reconciled before any residual is booked.
contract OfficialFeeOnTransferRoutesTest {
    using TransientStateLibrary for IPoolManager;
    VmTaxRoutes private constant vm = VmTaxRoutes(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant RECIPIENT = address(0xFEE);
    address private constant PUBLISHER = address(0xA11CE);
    address private constant GUARDIAN = address(0x6A2D);
    // The published price must sit within this band of the pool's own
    // reading; wide enough for the fixture's moves, far from unbounded.
    uint256 constant GUARD_DEVIATION_BPS=2000;
    uint128 private constant OPENING = 1 << 64;
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
    event log_named_uint(string key, uint256 value);
    receive() external payable {}

    function _setup() private {
        NitroTestSetup.install(); vm.roll(1000); vm.warp(1_700_000_000);
        manager = IPoolManager(address(new PoolManager(address(this))));
        positions = new PositionManager(manager,IAllowanceTransfer(address(0x1111)),100000,
            IPositionDescriptor(address(0x2222)),IWETH9(address(0x3333)));
        state = new StateView(manager);
        OfficialV4Controller seed = new OfficialV4Controller(manager,positions);
        trader = new OfficialV4SwapDriver(manager);
        address a=address(new SelectiveTaxToken()); address b=address(new SelectiveTaxToken());
        address c0=a<b?a:b; address c1=a<b?b:a;
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
        p.baseCurrency=c0; p.quoteCurrency=c1; p.consentToUncollectedFees=true;
        p.policy=IDominoVaultDraft.Policy(400,1000,1000,1,4,1,false);
        p.limits=T.ExecutionLimits(1,5000,100,100,1e12,120,3600);
        vault=DominoVaultV4(payable(factory.createVault(p,0)));
        require(address(vault)==predicted && vault.rootPermissionValid(),"actual v4 clone");
    }
    function _fund(address c,address recipient,uint256 amount) private {
        if(c==address(0)) vm.deal(recipient,recipient.balance+amount); else SelectiveTaxToken(c).mint(recipient,amount);
    }
    function _balance(address c,address who) private view returns(uint256) {
        return c==address(0)?who.balance:SelectiveTaxToken(c).balanceOf(who);
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
        // Loose ceilings must still reject transfer losses independently.
        // Another test exercises independently calculated exact ceilings.
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
        (uint160 sqrtPrice,int24 tick,uint24 protocolFee,uint24 lpFee)=state.getSlot0(PoolId.wrap(vault.poolId()));
        return keccak256(abi.encode(positions.getPositionLiquidity(tokenId),
            vault.feeBalance(m.source0,Currency.unwrap(key.currency0)),vault.feeBalance(m.source1,Currency.unwrap(key.currency1)),
            _currencyState(Currency.unwrap(key.currency0)),_currencyState(Currency.unwrap(key.currency1)),
            sqrtPrice,tick,protocolFee,lpFee,vault.checkpoint(tokenId).commitment));
    }
    function _currencyState(address c) private view returns(bytes32) {
        SelectiveTaxToken t=SelectiveTaxToken(c);
        return keccak256(abi.encode(t.balanceOf(address(vault)),t.balanceOf(address(manager)),
            t.balanceOf(RECIPIENT),vault.accountedCurrency(c),t.taxBurned(),t.matchingCalls(),t.positiveTransfers()));
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
            budget.minOriginal=uint128(net==0?0:(uint256(net)-1)*10000/9600+1);
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

    function _token0() private view returns(SelectiveTaxToken) {
        return SelectiveTaxToken(Currency.unwrap(key.currency0));
    }
    function _token1() private view returns(SelectiveTaxToken) {
        return SelectiveTaxToken(Currency.unwrap(key.currency1));
    }
    function _route(SelectiveTaxToken token,address from,address to) private view returns(uint256) {
        return token.routeGross(keccak256(abi.encode(from,to)));
    }
    function _budget(VmTaxRoutes.Log[] memory logs,address currency) private view returns(T.CompoundAmounts memory value) {
        bytes32 signature=keccak256("BudgetApplied(address,bytes32,bytes32,address,uint256,(uint128,uint128,uint128,uint128,uint128,uint128,uint128,uint128,uint128))");
        for(uint256 i;i<logs.length;++i) {
            if(logs[i].emitter != address(engine) || logs[i].topics.length != 4 || logs[i].topics[0] != signature) continue;
            (address c,uint256 destination,T.CompoundAmounts memory amounts)=abi.decode(logs[i].data,(address,uint256,T.CompoundAmounts));
            if(c == currency) { require(destination == tokenId,"root destination"); return amounts; }
        }
        revert("missing BudgetApplied");
    }

    function testGeneralCollectTaxFromPoolManagerToVaultRevertsAtomically() external {
        _setup(); _swaps(); E.Plan memory p=_plan(0,1e12);
        _token0().configure(address(manager),address(vault),1);
        _rejectWith(p,DominoExecutionEngineV4.InvalidAmount.selector,"GENERAL taxed collect");
        _token0().configure(address(manager),address(vault),0);
        vault.execute(p); _backed();
        require(_route(_token0(),address(manager),address(vault)) > 0,"collect crosses addresses");
    }

    function testGeneralFundingTaxFromVaultToPoolManagerRevertsAtomically() external {
        _setup(); _swaps(); E.Plan memory p=_plan(0,1e12);
        _token0().configure(address(vault),address(manager),1);
        _rejectWith(p,DominoVaultV4.TransferFailed.selector,"GENERAL taxed settlement");
        _token0().configure(address(vault),address(manager),0);
        vault.execute(p); _backed();
        require(_route(_token0(),address(vault),address(manager)) > 0,"funding crosses addresses");
    }

    function testSwapInputTaxFromVaultToPoolManagerRevertsAtomically() external {
        _setup(); E.Plan memory p=_withSwap();
        _token0().configure(address(vault),address(manager),1);
        _rejectWith(p,DominoVaultV4.TransferFailed.selector,"taxed swap input");
        _token0().configure(address(vault),address(manager),0);
        vault.execute(p); _backed();
        require(_route(_token0(),address(vault),address(manager)) >= p.swap.amountIn,"real input settlement");
    }

    function testSwapOutputTaxFromPoolManagerToVaultRevertsAtomically() external {
        _setup(); E.Plan memory p=_withSwap();
        // First matching transfer collects currency1; second is swap output.
        _token1().configure(address(manager),address(vault),2);
        _rejectWith(p,DominoExecutionEngineV4.InvalidAmount.selector,"taxed swap output");
        _token1().configure(address(manager),address(vault),0);
        vault.execute(p); _backed();
        require(_token1().matchingCalls() >= 2,"collect and output both cross addresses");
    }

    function testServiceFeeTaxFromVaultToRecipientRevertsBothRecipesAtomically() external {
        _setup(); _swaps(); E.Plan memory p=_plan(0,1e12);
        _token0().configure(address(vault),RECIPIENT,1);
        _rejectWith(p,DominoVaultV4.TransferFailed.selector,"GENERAL taxed service fee");
        p.action=1;
        _rejectWith(p,DominoVaultV4.TransferFailed.selector,"NET taxed service fee");
        _token0().configure(address(vault),RECIPIENT,0);
        vault.execute(p); _backed();
        require(_route(_token0(),address(vault),RECIPIENT) > 0,"service fee crosses addresses");
    }

    function testNetResidualTaxRevertsEvenWithLooseBoundsAndExemptFeeRecipient() external {
        _setup(); _swaps(); E.Plan memory p=_plan(1,1e12);
        (uint128 actual0,uint128 actual1)=_owed(tokenId,p.authority.liquidityIncrease);
        // Wide plan ceilings cannot turn a short residual into productive cost.
        _token0().configure(address(manager),address(vault),1);
        _rejectWith(p,DominoExecutionEngineV4.InvalidAmount.selector,"NET taxed residual");
        _token0().configure(address(manager),address(vault),0);
        vm.recordLogs(); vault.execute(p);
        VmTaxRoutes.Log[] memory logs=vm.getRecordedLogs();
        T.CompoundAmounts memory a=_budget(logs,Currency.unwrap(key.currency0));
        T.CompoundAmounts memory b=_budget(logs,Currency.unwrap(key.currency1));
        require(a.liquidityAdded == actual0 && b.liquidityAdded == actual1,"independent liquidity cost");
        require(a.serviceFee == a.grossOriginalConsumed*400/10000,"fee only on true consumed amount");
        require(_token0().balanceOf(RECIPIENT) == a.serviceFee,"exact fee payout");
        require(_route(_token0(),address(manager),address(vault)) == uint256(a.realized)-actual0,"exact nominal residual");
        require(_route(_token0(),address(vault),address(manager)) == 0,"internal netting has no add transfer");
        _backed();
    }

    function testNetResidualTaxFailsWhenPlanCeilingsUseIndependentActualCost() external {
        _setup(); _swaps(); E.Plan memory p=_plan(1,1e12);
        (p.maxAdded0,p.maxAdded1)=_owed(tokenId,p.authority.liquidityIncrease);
        _token0().configure(address(manager),address(vault),1);
        _rejectWith(p,DominoExecutionEngineV4.InvalidAmount.selector,"independent maxAdded rejects residual tax");
        _token0().configure(address(manager),address(vault),0);
        vault.execute(p); _backed();
    }

    function testNetWithoutResidualDoesNotInvokeTransferTaxForInternallyNettedAmounts() external {
        _setup(); uint128 increase=100;
        (uint128 owed0,uint128 owed1)=_owed(tokenId,increase);
        TaxRouteFeeDonor donor=new TaxRouteFeeDonor(manager);
        _token0().mint(address(donor),owed0); _token1().mint(address(donor),owed1);
        donor.donate(key,owed0,owed1);
        // OPENING is 2^64 so these core fee-growth increments are exact.
        // Tiny amounts make the approved 4% service fee round to zero; this is
        // not evidence that a meaningful fee-bearing NET avoids all transfers.
        E.Plan memory p=_plan(1,increase);
        _token0().configure(address(manager),address(vault),1);
        _token1().configure(address(manager),address(vault),1);
        uint256 transfers0=_token0().positiveTransfers(); uint256 transfers1=_token1().positiveTransfers();
        vm.recordLogs(); vault.execute(p);
        VmTaxRoutes.Log[] memory logs=vm.getRecordedLogs();
        T.CompoundAmounts memory a=_budget(logs,Currency.unwrap(key.currency0));
        T.CompoundAmounts memory b=_budget(logs,Currency.unwrap(key.currency1));
        require(a.realized == owed0 && b.realized == owed1,"all realized fees internally consumed");
        require(a.liquidityAdded == owed0 && b.liquidityAdded == owed1,"correct netted cost");
        require(a.serviceFee == 0 && b.serviceFee == 0,"rounding-only no payout case");
        require(_token0().positiveTransfers() == transfers0 && _token1().positiveTransfers() == transfers1,"no positive transfer in NET");
        require(_token0().matchingCalls() == 0 && _token1().matchingCalls() == 0,"tax route never invoked");
        require(_token0().taxBurned() == 0 && _token1().taxBurned() == 0,"no tax on internal accounting");
        require(positions.getPositionLiquidity(tokenId) == OPENING+increase,"liquidity increased without transfer");
        _backed();
        emit log_named_uint("zero-residual currency0 realized and cost",owed0);
        emit log_named_uint("zero-residual currency1 realized and cost",owed1);
    }

}
