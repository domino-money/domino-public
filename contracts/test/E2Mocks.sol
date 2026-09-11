// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultTypes as T, IERC721ReceiverE2} from "../src/DominoVaultTypes.sol";

/// @dev Synthetic local interfaces/mocks. No token or manager admission evidence.
interface VmE2 {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
    function deal(address account, uint256 amount) external;
    function chainId(uint256 chain) external;
    function roll(uint256 blockNumber) external;
    function warp(uint256 timestamp) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function store(address account, bytes32 slot, bytes32 value) external;
    function load(address account, bytes32 slot) external view returns (bytes32);
    function cool(address account) external;
}

interface SubscriberE2 {
    function notifySubscribe(uint256 tokenId, bytes calldata data) external;
    function notifyUnsubscribe(uint256 tokenId) external;
    function notifyModifyLiquidity(uint256 tokenId, int256 liquidityChange, int256 feesAccrued) external;
    function notifyBurn(uint256 tokenId, address owner, uint256 info, uint256 liquidity, int256 feesAccrued) external;
}

contract MockPoolManager {
    bool public isUnlocked;
    function setUnlocked(bool value) external { isUnlocked = value; }
}

contract MockPositionManager {
    error ManagerUnlocked();
    error UnsubscribeGasTooLow();
    error TransferRejected();
    struct NFT { T.PoolKey key; int24 lower; int24 upper; uint128 liquidity; }
    address public immutable poolManager;
    mapping(uint256 => NFT) private _positions;
    mapping(uint256 => address) private _owners;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(uint256 => address) public subscriber;
    bool public suppressUnsubscribeCallback;
    bool public rejectSafeTransfers;
    bool public rejectTransfers;
    uint256 public unsubscribeGasLimit = 100000;
    address public transferReentryTarget;
    bytes public transferReentryData;
    bytes public transferReentryResult;
    bool public transferReentryAttempted;
    bool public transferReentrySucceeded;
    address public subscribeReentryTarget;
    bytes public subscribeReentryData;
    bytes public subscribeReentryResult;
    bool public subscribeReentryAttempted;
    bool public subscribeReentrySucceeded;
    bool public requireSubscribeReentrySuccess;

    constructor(address manager) { poolManager = manager; }

    function mint(address owner, uint256 id, T.PoolKey memory key, int24 lower, int24 upper, uint128 liquidity)
        external
    {
        require(owner != address(0) && _owners[id] == address(0), "mock invalid mint");
        _owners[id] = owner;
        _positions[id] = NFT(key, lower, upper, liquidity);
    }

    function ownerOf(uint256 id) public view returns (address owner) {
        owner = _owners[id];
        require(owner != address(0), "mock missing NFT");
    }

    function approve(address target, uint256 id) external {
        address owner = ownerOf(id);
        require(msg.sender == owner || isApprovedForAll[owner][msg.sender], "mock approval caller");
        getApproved[id] = target;
    }

    function setApprovalForAll(address target, bool allowed) external { isApprovedForAll[msg.sender][target] = allowed; }

    function _authorized(uint256 id) private view {
        address owner = ownerOf(id);
        require(msg.sender == owner || getApproved[id] == msg.sender || isApprovedForAll[owner][msg.sender],
            "mock NFT caller");
    }

    function getPoolAndPositionInfo(uint256 id) public view returns (T.PoolKey memory key, uint256 info) {
        NFT storage nft = _positions[id];
        key = nft.key;
        if (_owners[id] == address(0)) return (key, 0);
        uint256 poolBits = uint256(keccak256(abi.encode(key))) & ~((uint256(1) << 56) - 1);
        info = poolBits | (uint256(uint24(nft.lower)) << 8) | (uint256(uint24(nft.upper)) << 32);
        if (subscriber[id] != address(0)) info |= 1;
    }

    function getPositionLiquidity(uint256 id) external view returns (uint128) { return _positions[id].liquidity; }
    function setLiquidity(uint256 id, uint128 liquidity) external { _positions[id].liquidity = liquidity; }
    function setSuppressUnsubscribeCallback(bool value) external { suppressUnsubscribeCallback = value; }
    function setRejectSafeTransfers(bool value) external { rejectSafeTransfers = value; }
    function setRejectTransfers(bool value) external { rejectTransfers = value; }
    function setUnsubscribeGasLimit(uint256 value) external { unsubscribeGasLimit = value; }
    function configureTransferReentry(address target, bytes calldata data) external {
        transferReentryTarget = target; transferReentryData = data;
        transferReentryAttempted = false; transferReentrySucceeded = false;
        delete transferReentryResult;
    }
    function _locked() private view {
        if (MockPoolManager(poolManager).isUnlocked()) revert ManagerUnlocked();
    }
    function configureSubscribeReentry(address target, bytes calldata data, bool required) external {
        subscribeReentryTarget = target; subscribeReentryData = data;
        requireSubscribeReentrySuccess = required; subscribeReentryAttempted = false;
        subscribeReentrySucceeded = false; delete subscribeReentryResult;
    }

    function subscribe(uint256 id, address target, bytes calldata data) external {
        _authorized(id);
        _locked();
        require(target.code.length != 0 && subscriber[id] == address(0), "mock invalid subscriber");
        subscriber[id] = target;
        if (subscribeReentryTarget != address(0) && !subscribeReentryAttempted) {
            subscribeReentryAttempted = true;
            (subscribeReentrySucceeded, subscribeReentryResult) = subscribeReentryTarget.call(subscribeReentryData);
            require(!requireSubscribeReentrySuccess || subscribeReentrySucceeded, "mock subscribe reentry failed");
        }
        SubscriberE2(target).notifySubscribe(id, data);
    }

    function unsubscribe(uint256 id) external {
        _authorized(id);
        _locked();
        require(subscriber[id] != address(0), "mock not subscribed");
        _unsubscribe(id);
    }

    function _unsubscribe(uint256 id) private {
        address target = subscriber[id];
        delete subscriber[id];
        if (target != address(0) && !suppressUnsubscribeCallback) {
            // Mirrors the pre-call cap guard and failure-tolerant notification;
            // actual deployed-manager cap/code still require qualification.
            if (gasleft() < unsubscribeGasLimit) revert UnsubscribeGasTooLow();
            try SubscriberE2(target).notifyUnsubscribe{gas: unsubscribeGasLimit}(id) {} catch {}
        }
    }

    function transferFrom(address from, address to, uint256 id) public {
        _authorized(id);
        _locked();
        if (rejectTransfers) revert TransferRejected();
        require(ownerOf(id) == from && to != address(0), "mock invalid transfer");
        delete getApproved[id];
        if (subscriber[id] != address(0)) _unsubscribe(id);
        _owners[id] = to;
        if (transferReentryTarget != address(0) && !transferReentryAttempted) {
            transferReentryAttempted = true;
            (transferReentrySucceeded, transferReentryResult) = transferReentryTarget.call(transferReentryData);
        }
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(!rejectSafeTransfers, "mock safe transfer failed");
        transferFrom(from, to, id);
        if (to.code.length != 0) {
            require(IERC721ReceiverE2(to).onERC721Received(msg.sender, from, id, "") ==
                IERC721ReceiverE2.onERC721Received.selector, "mock NFT receiver");
        }
    }

    function notifyModify(uint256 id, int256 liquidityChange, int256 feesAccrued) external {
        _authorized(id);
        _locked();
        // Synthetic external modify entry: model the unlock interval for the
        // notification, without pretending to execute real v4 liquidity math.
        MockPoolManager(poolManager).setUnlocked(true);
        if (subscriber[id] != address(0)) {
            SubscriberE2(subscriber[id]).notifyModifyLiquidity(id, liquidityChange, feesAccrued);
        }
        MockPoolManager(poolManager).setUnlocked(false);
    }

    function burn(uint256 id, int256 feesAccrued) external {
        _authorized(id);
        _locked();
        MockPoolManager(poolManager).setUnlocked(true);
        address owner = ownerOf(id);
        (, uint256 info) = getPoolAndPositionInfo(id);
        address target = subscriber[id];
        delete subscriber[id];
        delete getApproved[id];
        delete _owners[id];
        if (target != address(0)) {
            SubscriberE2(target).notifyBurn(id, owner, info, _positions[id].liquidity, feesAccrued);
        }
        delete _positions[id];
        MockPoolManager(poolManager).setUnlocked(false);
    }
}

contract MockStateView {
    struct PositionState { bool supplied; uint128 liquidity; uint256 last0; uint256 last1; }
    address public immutable poolManager;
    MockPositionManager public immutable positionManager;
    mapping(uint256 => PositionState) private _positionState;
    mapping(bytes32 => uint256[2]) private _growth;

    constructor(address manager, MockPositionManager positions) { poolManager = manager; positionManager = positions; }

    function setPositionState(uint256 id, uint128 liquidity, uint256 last0, uint256 last1) external {
        _positionState[id] = PositionState(true, liquidity, last0, last1);
    }

    function setFeeGrowthInside(bytes32 poolId, int24 lower, int24 upper, uint256 inside0, uint256 inside1) external {
        _growth[keccak256(abi.encode(poolId, lower, upper))] = [inside0, inside1];
    }

    function getPositionInfo(bytes32 poolId, address manager, int24 lower, int24 upper, bytes32 salt)
        external view returns (uint128 liquidity, uint256 last0, uint256 last1)
    {
        require(manager == address(positionManager), "mock core manager mismatch");
        uint256 id = uint256(salt);
        (T.PoolKey memory key, uint256 info) = positionManager.getPoolAndPositionInfo(id);
        require(poolId == keccak256(abi.encode(key)) && int24(uint24(info >> 8)) == lower &&
            int24(uint24(info >> 32)) == upper, "mock core identity mismatch");
        PositionState memory state = _positionState[id];
        if (state.supplied) return (state.liquidity, state.last0, state.last1);
        return (positionManager.getPositionLiquidity(id), 0, 0);
    }

    function getFeeGrowthInside(bytes32 poolId, int24 lower, int24 upper)
        external view returns (uint256 inside0, uint256 inside1)
    {
        uint256[2] memory growth = _growth[keccak256(abi.encode(poolId, lower, upper))];
        return (growth[0], growth[1]);
    }
}

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    uint8 public failureMode; // 1 returns false, 2 reverts.
    uint16 public transferFeeBps;
    address public reentryTarget;
    bytes public reentryData;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bool public requireReentrySuccess;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function configureTransfer(uint8 failure, uint16 fee) external { failureMode = failure; transferFeeBps = fee; }
    function configureReentry(address target, bytes calldata data, bool required) external {
        reentryTarget = target; reentryData = data; requireReentrySuccess = required;
        reentryAttempted = false; reentrySucceeded = false;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failureMode == 1) return false;
        require(failureMode != 2, "mock ERC20 failed");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - amount * transferFeeBps / 10000;
        if (reentryTarget != address(0) && !reentryAttempted) {
            reentryAttempted = true;
            (reentrySucceeded,) = reentryTarget.call(reentryData);
            require(!requireReentrySuccess || reentrySucceeded, "mock reentry failed");
        }
        return true;
    }
}

contract E2OwnerReceiver is IERC721ReceiverE2 {
    bool public rejectNative;
    bool public rejectNFT;
    address public reentryTarget;
    bytes public reentryData;
    bytes public reentryResult;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    function setReject(bool native_, bool nft_) external { rejectNative = native_; rejectNFT = nft_; }
    function configureReentry(address target, bytes calldata data) external {
        reentryTarget = target; reentryData = data; reentryAttempted = false; reentrySucceeded = false;
        delete reentryResult;
    }
    function invoke(address target, bytes calldata data) external payable returns (bytes memory result) {
        (bool ok, bytes memory returned) = target.call{value: msg.value}(data);
        if (!ok) assembly ("memory-safe") { revert(add(returned, 32), mload(returned)) }
        return returned;
    }
    function _reenter() private {
        if (reentryTarget != address(0) && !reentryAttempted) {
            reentryAttempted = true;
            (reentrySucceeded, reentryResult) = reentryTarget.call(reentryData);
        }
    }
    receive() external payable { require(!rejectNative, "mock owner rejects native"); _reenter(); }
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        require(!rejectNFT, "mock owner rejects NFT"); _reenter();
        return IERC721ReceiverE2.onERC721Received.selector;
    }
}

contract E2ForeignSubscriber is SubscriberE2 {
    bool public rejectNotifications;
    function setReject(bool reject_) external { rejectNotifications = reject_; }
    function notifySubscribe(uint256, bytes calldata) external view { require(!rejectNotifications, "mock notify"); }
    function notifyUnsubscribe(uint256) external view { require(!rejectNotifications, "mock notify"); }
    function notifyModifyLiquidity(uint256, int256, int256) external view { require(!rejectNotifications, "mock notify"); }
    function notifyBurn(uint256, address, uint256, uint256, int256) external view { require(!rejectNotifications, "mock notify"); }
}

/// @dev An immutable owner can hold an NFT without implementing its receiver.
contract E2OwnerWithoutNFTReceiver {
    function invoke(address target, bytes calldata data) external returns (bytes memory result) {
        (bool ok, bytes memory returned) = target.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(returned, 32), mload(returned)) }
        return returned;
    }
}
