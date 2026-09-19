// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultTypes as T, IERC20E2, IPositionManagerE2, IStateViewE2} from "./DominoVaultTypes.sol";

interface ISetupManager {
    struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
    function initialize(T.PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24);
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(T.PoolKey calldata key, SwapParams calldata params, bytes calldata hookData) external returns (int256);
    function exttload(bytes32 slot) external view returns (bytes32);
    function sync(address currency) external;
    function settleFor(address recipient) external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}
interface ISetupPositions is IPositionManagerE2 { function nextTokenId() external view returns (uint256); }

/// @notice Owner-funded, single-pool setup. Each successful stage has a durable
/// on-chain receipt; cancelling after a swap refunds its output without swapping
/// or charging again. This contract never authorizes an automation operator.
contract DominoSetup {
    struct Operation {
        address owner;
        T.PoolKey key;
        uint128 balance0;
        uint128 balance1;
        bool swapped;
        bool closed;
        uint256 tokenId;
    }
    struct MintPlan {
        bytes32 operationId;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 maxAmount0;
        uint128 maxAmount1;
        uint160 minSqrtPriceX96;
        uint160 maxSqrtPriceX96;
        uint160 initialSqrtPriceX96;
        uint64 deadline;
    }
    struct SwapPlan {
        bytes32 operationId;
        bool zeroForOne;
        uint128 grossInput;
        uint128 minOutput;
        uint160 sqrtPriceLimitX96;
        uint64 deadline;
    }

    ISetupManager public immutable manager;
    ISetupPositions public immutable positions;
    IStateViewE2 public immutable stateView;
    address public immutable feeRecipient;
    uint16 public immutable assistedFeeBps;
    uint64 public immutable tariffVersion;
    mapping(bytes32 => Operation) private _operations;
    mapping(address => uint64) public ownerNonce;
    bool private _entered;
    bytes32 private _callback;
    error InvalidSetup();
    event SetupFunded(bytes32 indexed operationId, address indexed owner, bytes32 indexed poolId, uint128 amount0, uint128 amount1);
    event SetupSwapped(bytes32 indexed operationId, address indexed owner, bool zeroForOne, uint128 grossInput, uint128 serviceFee, uint128 netInput, uint128 output, uint64 tariffVersion);
    event SetupMinted(bytes32 indexed operationId, address indexed owner, uint256 indexed tokenId, uint128 liquidity, uint128 amount0, uint128 amount1);
    event SetupClosed(bytes32 indexed operationId, address indexed owner, uint128 refund0, uint128 refund1);

    constructor(address manager_, address positions_, address view_, address recipient_, uint16 feeBps_, uint64 version_) {
        if (manager_.code.length == 0 || positions_.code.length == 0 || view_.code.length == 0
            || recipient_ == address(0) || recipient_ == address(this) || feeBps_ > 65 || version_ == 0
            || IPositionManagerE2(positions_).poolManager() != manager_
            || IStateViewE2(view_).poolManager() != manager_) revert InvalidSetup();
        manager = ISetupManager(manager_); positions = ISetupPositions(positions_); stateView = IStateViewE2(view_);
        feeRecipient = recipient_; assistedFeeBps = feeBps_; tariffVersion = version_;
    }
    receive() external payable { if (msg.sender != address(manager)) revert InvalidSetup(); }
    modifier locked() { if (_entered) revert InvalidSetup(); _entered = true; _; _entered = false; }

    function operation(bytes32 id) external view returns (Operation memory) { return _operations[id]; }
    function nextOperationId(address owner) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), owner, ownerNonce[owner]));
    }

    function open(bytes32 id, T.PoolKey calldata key, uint128 amount0, uint128 amount1) external payable locked {
        if (id != nextOperationId(msg.sender) || _operations[id].owner != address(0) || key.currency0 >= key.currency1
            || key.hooks != address(0) || key.fee > 1_000_000 || key.tickSpacing <= 0 || key.tickSpacing > 32767
            || (amount0 == 0 && amount1 == 0)
            // Both currencies must be native or a real token, as the read
            // helper already requires of a pool. Without this a code-less
            // address is only caught later, by a balance read, after funds
            // have moved. Pool existence is deliberately not required: mint
            // may initialize the pool itself.
            || (key.currency0 != address(0) && key.currency0.code.length == 0)
            || key.currency1.code.length == 0
            || msg.value != (key.currency0 == address(0) ? amount0 : 0)) revert InvalidSetup();
        _pull(key.currency0, amount0); _pull(key.currency1, amount1);
        ownerNonce[msg.sender]++;
        _operations[id] = Operation(msg.sender, key, amount0, amount1, false, false, 0);
        emit SetupFunded(id, msg.sender, keccak256(abi.encode(key)), amount0, amount1);
    }

    function swap(SwapPlan calldata plan) external locked returns (uint128 output) {
        Operation storage op = _owned(plan.operationId);
        _deadline(plan.deadline);
        if (op.swapped || plan.grossInput == 0 || plan.minOutput == 0
            || plan.grossInput > (plan.zeroForOne ? op.balance0 : op.balance1)) revert InvalidSetup();
        uint128 beforeOutput = plan.zeroForOne ? op.balance1 : op.balance0;
        _unlock(abi.encode(uint8(1), abi.encode(plan)));
        // Outside the unlock: the swap has settled and the manager is locked,
        // so this transfer cannot reach it mid-operation. The amount is the
        // one _swap withheld from the gross input.
        _send(plan.zeroForOne ? op.key.currency0 : op.key.currency1, feeRecipient,
              uint128(uint256(plan.grossInput) * assistedFeeBps / 10_000));
        return (plan.zeroForOne ? op.balance1 : op.balance0) - beforeOutput;
    }

    function mint(MintPlan calldata plan) external locked {
        Operation storage op = _owned(plan.operationId);
        _deadline(plan.deadline);
        if (plan.liquidity == 0 || plan.liquidity > uint128(type(int128).max)
            || plan.tickLower < -887272 || plan.tickUpper > 887272 || plan.tickLower >= plan.tickUpper
            || plan.tickLower % op.key.tickSpacing != 0 || plan.tickUpper % op.key.tickSpacing != 0
            || plan.maxAmount0 > op.balance0 || plan.maxAmount1 > op.balance1
            || plan.minSqrtPriceX96 == 0 || plan.minSqrtPriceX96 > plan.maxSqrtPriceX96) revert InvalidSetup();
        bytes32 poolId = keccak256(abi.encode(op.key));
        (uint160 current,,,) = stateView.getSlot0(poolId);
        if (plan.initialSqrtPriceX96 != 0) {
            if (current != 0 || plan.initialSqrtPriceX96 < plan.minSqrtPriceX96
                || plan.initialSqrtPriceX96 > plan.maxSqrtPriceX96) revert InvalidSetup();
            manager.initialize(op.key, plan.initialSqrtPriceX96);
        }
        _price(poolId, plan.minSqrtPriceX96, plan.maxSqrtPriceX96);
        _unlock(abi.encode(uint8(2), abi.encode(plan)));
        _price(poolId, plan.minSqrtPriceX96, plan.maxSqrtPriceX96);
        _close(plan.operationId, op);
    }

    /// @notice Always available to the owner, including after deadline or with
    /// every Domino service stopped. No fee on a direct exit.
    function cancel(bytes32 id) external locked { Operation storage op = _owned(id); _close(id, op); }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager) || !_entered || _callback == bytes32(0) || keccak256(data) != _callback) revert InvalidSetup();
        delete _callback;
        (uint8 kind, bytes memory encoded) = abi.decode(data, (uint8, bytes));
        if (kind == 1) _swap(abi.decode(encoded, (SwapPlan)));
        else if (kind == 2) _mint(abi.decode(encoded, (MintPlan)));
        else revert InvalidSetup();
        return "";
    }

    function _swap(SwapPlan memory plan) private {
        Operation storage op = _operations[plan.operationId];
        address input = plan.zeroForOne ? op.key.currency0 : op.key.currency1;
        address output = plan.zeroForOne ? op.key.currency1 : op.key.currency0;
        uint128 fee = uint128(uint256(plan.grossInput) * assistedFeeBps / 10_000);
        uint128 net = plan.grossInput - fee;
        if (_delta(address(this), input) != 0 || _delta(address(this), output) != 0) revert InvalidSetup();
        manager.swap(op.key, ISetupManager.SwapParams(plan.zeroForOne, -int256(uint256(net)), plan.sqrtPriceLimitX96), "");
        int256 out = _delta(address(this), output);
        // A price-limited partial fill is atomically reverted, never charged as
        // the requested gross input. The owner can review a new smaller quote.
        if (_delta(address(this), input) != -int256(uint256(net)) || out < int256(uint256(plan.minOutput))
            || out > int256(uint256(type(uint128).max))) revert InvalidSetup();
        _settle(input, address(this), net);
        uint256 beforeOutput = _balance(output);
        manager.take(output, address(this), uint256(out));
        if (_balance(output) != beforeOutput + uint256(out)) revert InvalidSetup();
        // The fee is paid by swap() once the manager is locked again: handing
        // control to feeRecipient inside the unlock would let it call the
        // manager in the middle of this operation.
        if (plan.zeroForOne) { op.balance0 -= plan.grossInput; op.balance1 += uint128(uint256(out)); }
        else { op.balance1 -= plan.grossInput; op.balance0 += uint128(uint256(out)); }
        op.swapped = true;
        emit SetupSwapped(plan.operationId, op.owner, plan.zeroForOne, plan.grossInput, fee, net, uint128(uint256(out)), tariffVersion);
    }

    function _mint(MintPlan memory plan) private {
        Operation storage op = _operations[plan.operationId];
        if (_delta(address(positions), op.key.currency0) != 0 || _delta(address(positions), op.key.currency1) != 0) revert InvalidSetup();
        uint256 id = positions.nextTokenId();
        bytes[] memory params = new bytes[](1);
        params[0] = abi.encode(op.key, plan.tickLower, plan.tickUpper, uint256(plan.liquidity),
            plan.maxAmount0, plan.maxAmount1, op.owner, bytes(""));
        positions.modifyLiquiditiesWithoutUnlock(hex"02", params);
        uint128 paid0 = _payMint(op.key.currency0, plan.maxAmount0);
        uint128 paid1 = _payMint(op.key.currency1, plan.maxAmount1);
        if ((paid0 == 0 && paid1 == 0) || positions.ownerOf(id) != op.owner
            || positions.getPositionLiquidity(id) != plan.liquidity || positions.nextTokenId() != id + 1) revert InvalidSetup();
        op.balance0 -= paid0; op.balance1 -= paid1; op.tokenId = id;
        emit SetupMinted(plan.operationId, op.owner, id, plan.liquidity, paid0, paid1);
    }
    function _payMint(address currency, uint128 maximum) private returns (uint128) {
        int256 delta = _delta(address(positions), currency);
        if (delta > 0 || delta < -int256(uint256(maximum))) revert InvalidSetup();
        uint128 amount = uint128(uint256(-delta));
        _settle(currency, address(positions), amount);
        return amount;
    }
    function _settle(address currency, address recipient, uint128 amount) private {
        if (amount == 0) return;
        manager.sync(currency);
        uint256 paid;
        if (currency == address(0)) paid = manager.settleFor{value: amount}(recipient);
        else { _send(currency, address(manager), amount); paid = manager.settleFor(recipient); }
        if (paid != amount) revert InvalidSetup();
    }
    function _owned(bytes32 id) private view returns (Operation storage op) {
        op = _operations[id];
        if (op.owner != msg.sender || op.closed) revert InvalidSetup();
    }
    function _close(bytes32 id, Operation storage op) private {
        uint128 amount0 = op.balance0; uint128 amount1 = op.balance1;
        op.closed = true; op.balance0 = 0; op.balance1 = 0;
        _send(op.key.currency0, op.owner, amount0); _send(op.key.currency1, op.owner, amount1);
        emit SetupClosed(id, op.owner, amount0, amount1);
    }
    function _unlock(bytes memory data) private {
        _callback = keccak256(data); manager.unlock(data);
        if (_callback != bytes32(0)) revert InvalidSetup();
    }
    function _price(bytes32 id, uint160 minimum, uint160 maximum) private view {
        (uint160 value,,,) = stateView.getSlot0(id);
        if (value < minimum || value > maximum) revert InvalidSetup();
    }
    function _deadline(uint64 deadline) private view {
        if (deadline < block.timestamp || deadline > block.timestamp + 1200) revert InvalidSetup();
    }
    function _delta(address account, address currency) private view returns (int256) {
        return int256(uint256(manager.exttload(keccak256(abi.encode(account, currency)))));
    }
    function _balance(address currency) private view returns (uint256) {
        return currency == address(0) ? address(this).balance : IERC20E2(currency).balanceOf(address(this));
    }
    function _pull(address currency, uint128 amount) private {
        if (currency == address(0) || amount == 0) return;
        uint256 beforeValue = _balance(currency);
        uint256 ownerBefore = IERC20E2(currency).balanceOf(msg.sender);
        (bool success, bytes memory result) = currency.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), amount));
        if (!success || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))
            || _balance(currency) != beforeValue + amount || IERC20E2(currency).balanceOf(msg.sender) != ownerBefore - amount) revert InvalidSetup();
    }
    function _send(address currency, address to, uint128 amount) private {
        if (amount == 0) return;
        uint256 beforeValue = _balance(currency);
        uint256 beforeRecipient = currency == address(0) ? 0 : IERC20E2(currency).balanceOf(to);
        bool success; bytes memory result;
        if (currency == address(0)) (success,) = to.call{value: amount}("");
        else (success, result) = currency.call(abi.encodeCall(IERC20E2.transfer, (to, amount)));
        if (!success || (currency != address(0) && result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))
            || _balance(currency) != beforeValue - amount
            || (currency != address(0) && IERC20E2(currency).balanceOf(to) != beforeRecipient + amount)) revert InvalidSetup();
    }
}
