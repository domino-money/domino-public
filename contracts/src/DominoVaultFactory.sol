// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVault} from "./DominoVault.sol";
import {DominoVaultTypes, IPositionManagerE2, IStateViewE2} from "./DominoVaultTypes.sol";

/// @notice E2 owner-bound custody factory; no execution, upgrades or operator creation authority.
/// @dev Each caller creates only its own sequence. The predicted clone may receive
/// an individual NFT approval before deployment; global approvals are never granted here.
contract DominoVaultFactory {
    uint256 public constant CHAIN_ID = 4663;
    bytes32 public constant SEQUENCE_TYPEHASH =
        keccak256("DominoSequence(uint256 chainId,address factory,address owner,uint256 nonce)");

    address public immutable poolManager;
    address public immutable positionManager;
    address public immutable stateView;
    address public immutable serviceFeeRecipient;
    address public immutable implementation;

    mapping(address => uint256) private _nextOwnerNonce;
    mapping(address => bool) public isVault;
    mapping(bytes32 => address) public vaultForSequence;
    bool private _creating;

    error UnsupportedChain();
    error InvalidManagerConfiguration();
    error ManagerMismatch();
    error InvalidOwner();
    error UnexpectedOwnerNonce(uint256 expected, uint256 supplied);
    error OwnerNonceExhausted();
    error SequenceAlreadyCreated();
    error VaultDeploymentFailed();
    error ReentrantCreate();

    event VaultCreated(
        address indexed owner,
        bytes32 indexed sequenceId,
        address indexed vault,
        uint256 ownerNonce,
        address implementation
    );

    constructor(address poolManager_, address positionManager_, address stateView_, address serviceFeeRecipient_) {
        if (block.chainid != CHAIN_ID) revert UnsupportedChain();
        if (
            poolManager_ == address(0) || positionManager_ == address(0) || stateView_ == address(0)
                || serviceFeeRecipient_ == address(0) || poolManager_.code.length == 0
                || positionManager_.code.length == 0 || stateView_.code.length == 0
        ) revert InvalidManagerConfiguration();
        if (
            IPositionManagerE2(positionManager_).poolManager() != poolManager_
                || IStateViewE2(stateView_).poolManager() != poolManager_
        ) revert ManagerMismatch();

        poolManager = poolManager_;
        positionManager = positionManager_;
        stateView = stateView_;
        serviceFeeRecipient = serviceFeeRecipient_;
        implementation =
            address(new DominoVault(address(this), poolManager_, positionManager_, stateView_, serviceFeeRecipient_));
    }

    modifier nonReentrant() {
        if (_creating) revert ReentrantCreate();
        _creating = true;
        _;
        _creating = false;
    }

    function nextOwnerNonce(address owner) external view returns (uint256) {
        return _nextOwnerNonce[owner];
    }

    function sequenceIdFor(address owner, uint256 nonce) public view returns (bytes32) {
        if (owner == address(0)) revert InvalidOwner();
        return keccak256(abi.encode(SEQUENCE_TYPEHASH, block.chainid, address(this), owner, nonce));
    }

    function predictVault(address owner, uint256 nonce) public view returns (address) {
        bytes32 salt = sequenceIdFor(owner, nonce);
        bytes32 digest = keccak256(abi.encodePacked(hex"ff", address(this), salt, keccak256(_cloneCreationCode())));
        return address(uint160(uint256(digest)));
    }

    function createVault(DominoVaultTypes.InitParams calldata params, uint256 expectedOwnerNonce)
        external
        nonReentrant
        returns (address vault)
    {
        if (block.chainid != CHAIN_ID) revert UnsupportedChain();
        uint256 nonce = _nextOwnerNonce[msg.sender];
        if (nonce != expectedOwnerNonce) revert UnexpectedOwnerNonce(nonce, expectedOwnerNonce);
        if (nonce == type(uint256).max) revert OwnerNonceExhausted();
        bytes32 sequenceId = sequenceIdFor(msg.sender, nonce);
        if (vaultForSequence[sequenceId] != address(0)) revert SequenceAlreadyCreated();

        bytes memory code = _cloneCreationCode();
        assembly ("memory-safe") {
            vault := create2(0, add(code, 0x20), mload(code), sequenceId)
        }
        if (vault == address(0)) revert VaultDeploymentFailed();

        // The implementation rejects direct initialization and clones accept
        // only this factory. No registry entry exists until all custody and
        // subscription checks have completed. Any failure rolls CREATE2 back.
        DominoVault(payable(vault)).initialize(msg.sender, sequenceId, params);
        _nextOwnerNonce[msg.sender] = nonce + 1;
        vaultForSequence[sequenceId] = vault;
        isVault[vault] = true;
        emit VaultCreated(msg.sender, sequenceId, vault, nonce, implementation);
    }

    function _cloneCreationCode() private view returns (bytes memory) {
        // EIP-1167: 10-byte creation prefix + 45-byte delegatecall runtime.
        // Locally assembled from the standard opcodes, with no mutable target.
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3", hex"363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"
        );
    }
}
