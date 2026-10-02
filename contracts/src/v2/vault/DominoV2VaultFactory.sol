// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IDominoVault, IDominoVaultFactory} from "../interfaces/IDominoVault.sol";
import {DominoV2VaultBase} from "./DominoV2VaultBase.sol";

/// @notice Creates vaults for one DEX as EIP-1167 clones of one implementation.
/// @dev Deployed twice per chain (vaultFactory.v3, vaultFactory.v4), each bound
/// for good to the implementation built for it. A vault's address depends on
/// its owner and the owner's nonce only, so the owner can approve the root to
/// predictVault(owner, nextNonce(owner)) before createVault. Only the owner
/// creates its own vaults; initialization happens in the same call.
contract DominoV2VaultFactory is IDominoVaultFactory {
    uint8 public immutable dex;
    address public immutable implementation;
    address public immutable registry;

    mapping(address owner => uint256) public nextNonce;
    mapping(address account => bool) public isVault;

    constructor(address implementation_) {
        DominoV2VaultBase.Deployment memory wiring = DominoV2VaultBase(payable(implementation_)).wiring();
        uint8 dex_ = IDominoVault(implementation_).root().dex;
        if (wiring.factory != address(this) || (dex_ != DominoV2Types.DEX_V3 && dex_ != DominoV2Types.DEX_V4)) {
            revert InvalidInit();
        }
        dex = dex_;
        implementation = implementation_;
        registry = wiring.registry;
    }

    function predictVault(address owner, uint256 nonce) public view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), keccak256(abi.encode(owner, nonce)), keccak256(_cloneCode()))
        );
        return address(uint160(uint256(hash)));
    }

    function createVault(IDominoVault.Init calldata init, uint256 expectedNonce) external returns (address vault) {
        uint256 nonce = nextNonce[msg.sender];
        if (nonce != expectedNonce) revert UnexpectedNonce(nonce, expectedNonce);
        nextNonce[msg.sender] = nonce + 1;
        bytes memory code = _cloneCode();
        bytes32 salt = keccak256(abi.encode(msg.sender, nonce));
        assembly ("memory-safe") {
            vault := create2(0, add(code, 32), mload(code), salt)
        }
        // A failed create (only a reused salt, which the nonce rules out)
        // leaves address(0), whose initialize call below reverts.
        isVault[vault] = true;
        DominoV2VaultBase(payable(vault)).initialize(msg.sender, init);
        emit VaultCreated(msg.sender, vault, init.root.tokenId, dex, nonce);
    }

    /// EIP-1167 creation code: a 10-byte constructor and the 45-byte runtime
    /// that delegates every call to the implementation.
    function _cloneCode() private view returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"
        );
    }
}
