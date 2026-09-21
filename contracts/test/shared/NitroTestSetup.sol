// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface VmNitroSetup {
    function chainId(uint256 chainId) external;
    function etch(address target, bytes calldata code) external;
}

/// @notice TEST ONLY: explicitly emulate ArbSys on an ordinary local EVM.
/// @dev Install this runtime at 0x64 with vm.etch/anvil_setCode. Local tests
/// deliberately let vm.roll and vm.setBlockhash describe L2; this mock does
/// not reproduce Nitro's ancestor-chain opcode domain or qualify a live node.
contract MockNitroArbSys {
    function arbBlockNumber() external view returns (uint256) {
        return block.number;
    }

    function arbBlockHash(uint256 number) external view returns (bytes32) {
        require(number < block.number && block.number - number <= 256, "invalid L2 block");
        return blockhash(number);
    }
}

library NitroTestSetup {
    function install() internal {
        VmNitroSetup vm = VmNitroSetup(address(uint160(uint256(keccak256("hevm cheat code")))));
        vm.chainId(4663);
        vm.etch(address(0x64), type(MockNitroArbSys).runtimeCode);
    }
}
