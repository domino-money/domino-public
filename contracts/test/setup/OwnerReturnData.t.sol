// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {DominoSetup} from "../../src/DominoSetup.sol";
import {DominoVaultTypes as T} from "../../src/DominoVaultTypes.sol";
import {SetupToken} from "./DominoSetup.t.sol";
import {PoolManager, PositionManager, IPoolManager} from "../reference/OfficialV4Fixture.sol";
import {StateView} from "../reference/official-v4/v4-periphery/src/lens/StateView.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IPositionDescriptor} from "../reference/official-v4/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "../reference/official-v4/v4-periphery/src/interfaces/external/IWETH9.sol";
interface ReturnVm { function deal(address,uint256) external; }
contract OwnerReturningBytes {
    fallback() external payable { assembly ("memory-safe") { mstore(0,0) return(0,32) } }
    function open(DominoSetup setup,T.PoolKey calldata key,uint128 amount) external returns(bytes32 id) {
        SetupToken(key.currency1).approve(address(setup),amount);
        id=setup.nextOperationId(address(this));setup.open{value:amount}(id,key,amount,amount);
    }
    function cancel(DominoSetup setup,bytes32 id) external { setup.cancel(id); }
    function mint(DominoSetup setup,bytes32 id) external {
        setup.mint(DominoSetup.MintPlan(id,-600,600,1e18,1e20,1e20,uint160(1<<95),uint160(1<<97),uint160(1<<96),uint64(block.timestamp+120)));
    }
}
contract OwnerReturnDataTest {
    ReturnVm constant vm=ReturnVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function _fixture() private returns(DominoSetup setup,PositionManager positions,OwnerReturningBytes owner,T.PoolKey memory key) {
        IPoolManager manager=IPoolManager(address(new PoolManager(address(this))));
        positions=new PositionManager(manager,IAllowanceTransfer(address(0x11)),100000,IPositionDescriptor(address(0x22)),IWETH9(address(0x33)));
        setup=new DominoSetup(address(manager),address(positions),address(new StateView(manager)),address(0xFEE),65,1);
        owner=new OwnerReturningBytes();SetupToken token=new SetupToken();key=T.PoolKey(address(0),address(token),3000,60,address(0));
        vm.deal(address(owner),1e20);token.mint(address(owner),1e20);
    }
    function testCancelRefundAcceptsNativeReceiverReturningFalseBytes() external {
        (DominoSetup setup,,OwnerReturningBytes owner,T.PoolKey memory key)=_fixture();
        bytes32 id=owner.open(setup,key,1e20);owner.cancel(setup,id);
        require(address(owner).balance==1e20 && SetupToken(key.currency1).balanceOf(address(owner))==1e20,"full owner refund");
        require(setup.operation(id).closed,"closed exactly once");
    }
    function testMintRefundAcceptsNativeReceiverReturningFalseBytes() external {
        (DominoSetup setup,PositionManager positions,OwnerReturningBytes owner,T.PoolKey memory key)=_fixture();
        bytes32 id=owner.open(setup,key,1e20);owner.mint(setup,id);
        require(positions.ownerOf(1)==address(owner) && positions.getPositionLiquidity(1)==1e18,"owner root NFT");
        require(address(owner).balance>0 && address(setup).balance==0,"mint remainder refunded");
        require(setup.operation(id).closed,"closed exactly once");
    }
}
