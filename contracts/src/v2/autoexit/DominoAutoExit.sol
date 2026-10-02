// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {DominoFeeLedger} from "../fees/DominoFeeLedger.sol";
import {DominoFeeRules} from "../fees/DominoFeeRules.sol";
import {IDominoAutoExit} from "../interfaces/IDominoAutoExit.sol";
import {IDominoAutoExitExtension} from "../interfaces/IDominoAutoExitExtension.sol";
import {IDominoFeeSettlement} from "../interfaces/IDominoFees.sol";
import {IDominoPriceAnchor} from "../interfaces/IDominoPriceAnchor.sol";
import {IDominoVault} from "../interfaces/IDominoVault.sol";
import {DominoSwapExecutor} from "../route/DominoSwapExecutor.sol";
import {DominoSwapFloor} from "../route/DominoSwapFloor.sol";
import {DominoTokenOps} from "../route/DominoTokenOps.sol";

/// @notice Domino V2 auto-exit (#283, S3): executes an owner's signed, one-shot
/// ExitMandate on a vault that enabled this module, once the anchor price
/// crosses one of the mandate's triggers.
/// @dev docs/v2/F4_AUTO_EXIT.md. An execution:
/// 1. an operator the registry admits, while automation is not halted;
/// 2. an active, unexpired mandate on a vault whose exit module is this
///    contract and whose owner is still the mandate's owner;
/// 3. the anchor (IDominoPriceAnchor) within the mandate's slippage of the
///    spot, at or beyond a trigger;
/// 4. the vault removes all liquidity and sends what it withdrew here; the
///    module measures it (balances, never the vault's word);
/// 5. the fee (DominoFeeLedger), the conversion through F1b's executor
///    (router, v3 or v4 legs, each accepted by its effect), the fee-aware
///    floor against the anchor (DominoSwapFloor), and delivery to the owner;
///    a delivery the owner cannot receive waits for claim().
/// The mandate is marked executed before the vault is called: one shot.
/// Every entry point shares DominoActionLock's lock.
contract DominoAutoExit is IDominoAutoExit, IDominoAutoExitExtension, DominoFeeLedger, DominoSwapExecutor {
    error InvalidConfiguration();

    uint8 private constant STATUS_ACTIVE = 1;
    uint8 private constant STATUS_REVOKED = 2;
    uint8 private constant STATUS_EXECUTED = 3;
    uint16 public constant MAX_SLIPPAGE_BPS = 1000;
    uint24 public constant MAX_POOL_FEE_PIPS = 100_000;
    uint8 public constant INSTRUCTION_VERSION = 1;
    /// Gas for a native-currency push to the owner; a receiver that needs
    /// more gets a deferred delivery.
    uint256 private constant NATIVE_SEND_GAS = 100_000;
    uint256 private constant HALF_CURVE_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 private constant ERC165_ID = 0x01ffc9a7;
    /// keccak256("domino.v2.autoExit.exiting") - 1
    bytes32 private constant EXITING_SLOT = 0x2690af348b7704e17b00460430de7c86c0441e6260a202a4d93d79cb89aae954;

    address public immutable priceAnchor;
    uint32 public immutable maxObservationAgeSeconds;
    uint32 public immutable minTwapSeconds;

    mapping(bytes32 mandateHash => MandateRecord) private _mandates;
    mapping(address owner => mapping(uint256 nonce => bool)) public nonceUsed;
    mapping(address owner => mapping(address token => uint256)) public unclaimed;

    /// One execution's working state.
    struct Exit {
        bytes32 mandateHash;
        address owner;
        address vault;
        uint256 tokenId;
        uint8 receiveMode;
        DominoV2Types.PoolRef pool;
        address convertTo;
        uint256 received0;
        uint256 received1;
        uint160 anchorSqrtPriceX96;
        uint16 maxSlippageBps;
    }

    /// A conversion's working values, in memory for the stack.
    struct Conversion {
        address source;
        uint256 sourceAmount;
        uint256 targetAmount;
        bool listed;
        bool toToken1;
    }

    constructor(
        RouteConfig memory route,
        address priceAnchor_,
        uint32 maxObservationAgeSeconds_,
        uint32 minTwapSeconds_
    ) DominoFeeLedger(route.registry) DominoSwapExecutor(route) {
        if (priceAnchor_ == address(0) || maxObservationAgeSeconds_ == 0 || minTwapSeconds_ == 0) {
            revert InvalidConfiguration();
        }
        priceAnchor = priceAnchor_;
        maxObservationAgeSeconds = maxObservationAgeSeconds_;
        minTwapSeconds = minTwapSeconds_;
    }

    /// Native currency arrives only inside an execution: from the vault, the
    /// PoolManager or a router.
    receive() external payable {
        if (!_exiting()) revert Unauthorized();
    }

    // ---------------------------------------------------------------- views
    function registry() external view returns (address) {
        return address(ROUTE_REGISTRY);
    }

    function domainSeparator() public view returns (bytes32) {
        return DominoV2Types.domainSeparator(block.chainid, address(this));
    }

    function mandateStatus(bytes32 mandateHash) external view returns (uint8 status) {
        return _mandates[mandateHash].status;
    }

    function mandateOf(bytes32 mandateHash) external view returns (MandateRecord memory record) {
        return _mandates[mandateHash];
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == ERC165_ID || interfaceId == type(IDominoAutoExit).interfaceId
            || interfaceId == type(IDominoAutoExitExtension).interfaceId
            || interfaceId == type(IDominoFeeSettlement).interfaceId;
    }

    // ------------------------------------------------------------- mandates
    function registerMandate(DominoV2Types.ExitMandate calldata mandate, bytes calldata signature)
        external
        nonReentrant
        returns (bytes32 mandateHash)
    {
        mandateHash = DominoV2Types.hashExitMandate(mandate);
        if (_mandates[mandateHash].status != 0) revert MandateAlreadyRegistered();
        _checkTerms(mandate);
        if (nonceUsed[mandate.owner][mandate.nonce]) revert NonceAlreadyUsed();
        if (!_validSignature(mandate.owner, DominoV2Types.digest(domainSeparator(), mandateHash), signature)) {
            revert InvalidSignature();
        }
        if (IDominoVault(mandate.vault).owner() != mandate.owner) revert Unauthorized();
        nonceUsed[mandate.owner][mandate.nonce] = true;
        _mandates[mandateHash] = MandateRecord({
            owner: mandate.owner,
            validUntil: mandate.validUntil,
            maxSlippageBps: mandate.maxSlippageBps,
            receiveMode: mandate.receiveMode,
            status: STATUS_ACTIVE,
            vault: mandate.vault,
            convertTo: mandate.convertTo,
            triggerBelowSqrtPriceX96: mandate.triggerBelowSqrtPriceX96,
            triggerAboveSqrtPriceX96: mandate.triggerAboveSqrtPriceX96,
            tokenId: mandate.tokenId
        });
        emit MandateRegistered(mandateHash, mandate.owner, mandate.vault, mandate.tokenId, mandate.validUntil);
    }

    function revokeMandate(bytes32 mandateHash) external nonReentrant {
        MandateRecord storage record = _mandates[mandateHash];
        if (record.status != STATUS_ACTIVE) revert MandateNotActive();
        if (msg.sender != record.owner) revert Unauthorized();
        record.status = STATUS_REVOKED;
        emit MandateRevoked(mandateHash);
    }

    function cancelNonce(uint256 nonce) external nonReentrant {
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed();
        nonceUsed[msg.sender][nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    // ------------------------------------------------------------ execution
    function execute(bytes32 mandateHash, Execution calldata execution)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        _setExiting(true);
        Exit memory exit = _authorize(mandateHash, execution.anchorEvidence);
        _withdraw(exit, execution);
        (amount0, amount1) = exit.receiveMode == DominoV2Types.RECEIVE_BOTH
            ? _settleBoth(exit, execution.legs)
            : _settleConverted(exit, execution.legs);
        emit MandateExecuted(mandateHash, exit.anchorSqrtPriceX96, exit.owner, amount0, amount1);
        _setExiting(false);
    }

    function claim(address token, address recipient) external nonReentrant returns (uint256 amount) {
        if (recipient == address(0)) revert InvalidRecipient();
        amount = unclaimed[msg.sender][token];
        if (amount == 0) revert NothingToClaim();
        unclaimed[msg.sender][token] = 0;
        if (_push(token, recipient, amount, gasleft()) != amount) revert DeliveryMismatch(token);
        emit Claimed(msg.sender, token, recipient, amount);
    }

    // ------------------------------------------------------------ internals
    function _checkTerms(DominoV2Types.ExitMandate calldata mandate) private view {
        uint160 below = mandate.triggerBelowSqrtPriceX96;
        uint160 above = mandate.triggerAboveSqrtPriceX96;
        if (
            mandate.owner == address(0) || mandate.vault == address(0) || mandate.validUntil < block.timestamp
                || (above == 0 ? below == 0 : below >= above) || mandate.maxSlippageBps == 0
                || mandate.maxSlippageBps > MAX_SLIPPAGE_BPS
        ) revert InvalidMandate();
        if (mandate.receiveMode == DominoV2Types.RECEIVE_BOTH) {
            if (mandate.convertTo != address(0)) revert InvalidMandate();
        } else if (mandate.receiveMode == DominoV2Types.RECEIVE_CONVERTED) {
            DominoV2Types.PoolRef memory pool = IDominoVault(mandate.vault).pool();
            if (mandate.convertTo != pool.currency0 && mandate.convertTo != pool.currency1) revert InvalidMandate();
        } else {
            revert InvalidMandate();
        }
    }

    /// ECDSA first (an EOA, or an EIP-7702 account whose delegate lacks
    /// EIP-1271), then EIP-1271 on the owner's code.
    function _validSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (signature.length == 65) {
            bytes32 r = bytes32(signature[0:32]);
            bytes32 s = bytes32(signature[32:64]);
            if (uint256(s) <= HALF_CURVE_ORDER && ecrecover(digest, uint8(signature[64]), r, s) == signer) return true;
        }
        (bool ok, bytes memory result) = signer.staticcall(abi.encodeWithSelector(ERC1271_MAGIC, digest, signature));
        return ok && result.length >= 32 && abi.decode(result, (bytes32)) == bytes32(ERC1271_MAGIC);
    }

    /// Every check before the vault is called, then the mandate is spent:
    /// one shot. Returns what the rest of the execution works with.
    function _authorize(bytes32 mandateHash, bytes calldata anchorEvidence) private returns (Exit memory exit) {
        if (!ROUTE_REGISTRY.isOperator(msg.sender)) revert Unauthorized();
        if (ROUTE_REGISTRY.automationHalted()) revert AutomationHalted();
        MandateRecord storage record = _mandates[mandateHash];
        if (record.status != STATUS_ACTIVE || block.timestamp > record.validUntil) revert MandateNotActive();
        IDominoVault vault = IDominoVault(record.vault);
        if (vault.exitModule() != address(this)) revert ExitModuleNotEnabled();
        if (vault.owner() != record.owner) revert VaultOwnerChanged();
        DominoV2Types.PoolRef memory pool = vault.pool();
        // Two distinct tokens, and the conversion target among them: the
        // module never mixes one token's amounts with another's.
        if (
            pool.currency0 >= pool.currency1
                || (
                    record.receiveMode != DominoV2Types.RECEIVE_BOTH && record.convertTo != pool.currency0
                        && record.convertTo != pool.currency1
                )
        ) revert InvalidMandate();
        uint160 price = _anchorPrice(pool, anchorEvidence, record.maxSlippageBps);
        // A zero trigger never fires: the anchor price is never zero.
        uint160 above = record.triggerAboveSqrtPriceX96;
        if (price > record.triggerBelowSqrtPriceX96 && (above == 0 || price < above)) revert TriggerNotReached();
        record.status = STATUS_EXECUTED;
        exit = Exit({
            mandateHash: mandateHash,
            owner: record.owner,
            vault: address(vault),
            tokenId: record.tokenId,
            receiveMode: record.receiveMode,
            pool: pool,
            convertTo: record.convertTo,
            received0: 0,
            received1: 0,
            anchorSqrtPriceX96: price,
            maxSlippageBps: record.maxSlippageBps
        });
    }

    /// The anchor's price for the vault's pool. The band against the spot is
    /// the mandate's slippage. A v3 TWAP must span minTwapSeconds; the module
    /// has bounded its window, so it passes the window as the age bound.
    function _anchorPrice(DominoV2Types.PoolRef memory pool, bytes calldata evidence, uint16 band)
        private
        view
        returns (uint160 price)
    {
        uint32 maxAge = maxObservationAgeSeconds;
        if (evidence.length == 32) {
            uint32 window = abi.decode(evidence, (uint32));
            if (window < minTwapSeconds) revert TwapWindowTooShort();
            maxAge = window;
        }
        (price,) = IDominoPriceAnchor(priceAnchor).anchor(pool, evidence, maxAge, band);
        if (price == 0) revert InvalidAnchor();
    }

    function _withdraw(Exit memory exit, Execution calldata execution) private {
        uint256 before0 = DominoTokenOps.selfBalance(exit.pool.currency0);
        uint256 before1 = DominoTokenOps.selfBalance(exit.pool.currency1);
        IDominoVault(exit.vault).executeExit(
            exit.tokenId,
            abi.encode(
                ExitInstruction({
                    version: INSTRUCTION_VERSION,
                    mandateHash: exit.mandateHash,
                    recipient: address(this),
                    amount0Min: execution.amount0MinRemoved,
                    amount1Min: execution.amount1MinRemoved
                })
            )
        );
        exit.received0 = DominoTokenOps.selfBalance(exit.pool.currency0) - before0;
        exit.received1 = DominoTokenOps.selfBalance(exit.pool.currency1) - before1;
        if (exit.received0 < execution.amount0MinRemoved || exit.received1 < execution.amount1MinRemoved) {
            revert BelowMinimum();
        }
    }

    function _settleBoth(Exit memory exit, DominoV2Types.SwapLeg[] calldata legs)
        private
        returns (uint256 amount0, uint256 amount1)
    {
        if (legs.length != 0) revert InvalidExecution();
        (uint256 fee0, uint256 fee1) = _bothFees(exit);
        _charge(exit, exit.pool.currency0, fee0);
        _charge(exit, exit.pool.currency1, fee1);
        amount0 = exit.received0 - fee0;
        amount1 = exit.received1 - fee1;
        _deliver(exit.owner, exit.pool.currency0, amount0);
        _deliver(exit.owner, exit.pool.currency1, amount1);
    }

    /// FEE_AUTO_EXIT_BPS of the position valued at the anchor, in the
    /// best-ranked charge currency the owner receives, as far as it goes, and
    /// the rest in the other token. Without one: of each token withdrawn.
    function _bothFees(Exit memory exit) private view returns (uint256 fee0, uint256 fee1) {
        uint8 rank0 = exit.received0 == 0 ? 0 : ROUTE_REGISTRY.chargeCurrencyRank(exit.pool.currency0);
        uint8 rank1 = exit.received1 == 0 ? 0 : ROUTE_REGISTRY.chargeCurrencyRank(exit.pool.currency1);
        if (rank0 == 0 && rank1 == 0) return (_fee(exit.received0), _fee(exit.received1));
        if (rank0 != 0 && (rank1 == 0 || rank0 <= rank1)) {
            (fee0, fee1) = _ledFee(exit.received0, exit.received1, exit.anchorSqrtPriceX96, false);
        } else {
            (fee1, fee0) = _ledFee(exit.received1, exit.received0, exit.anchorSqrtPriceX96, true);
        }
    }

    /// The fee led by one token: FEE_AUTO_EXIT_BPS of both amounts valued in
    /// the leading token at the anchor, taken from it as far as it goes, the
    /// rest from the other token at the same price.
    function _ledFee(uint256 lead, uint256 other, uint160 price, bool leadIsToken1)
        private
        pure
        returns (uint256 leadFee, uint256 otherFee)
    {
        uint256 due = _fee(lead + DominoSwapFloor.quote(other, price, leadIsToken1));
        leadFee = due < lead ? due : lead;
        otherFee = DominoSwapFloor.quote(due - leadFee, price, !leadIsToken1);
    }

    function _settleConverted(Exit memory exit, DominoV2Types.SwapLeg[] calldata legs)
        private
        returns (uint256 amount0, uint256 amount1)
    {
        bool toToken1 = exit.convertTo == exit.pool.currency1;
        Conversion memory conversion = Conversion({
            source: toToken1 ? exit.pool.currency0 : exit.pool.currency1,
            sourceAmount: toToken1 ? exit.received0 : exit.received1,
            targetAmount: toToken1 ? exit.received1 : exit.received0,
            listed: ROUTE_REGISTRY.chargeCurrencyRank(exit.convertTo) != 0,
            toToken1: toToken1
        });
        if (!conversion.listed) {
            // Not a charge currency: the fee is in the position's own tokens,
            // taken from each token withdrawn before the conversion.
            uint256 sourceFee = _fee(conversion.sourceAmount);
            uint256 targetFee = _fee(conversion.targetAmount);
            _charge(exit, conversion.source, sourceFee);
            _charge(exit, exit.convertTo, targetFee);
            conversion.sourceAmount -= sourceFee;
            conversion.targetAmount -= targetFee;
        }
        uint256 net = conversion.targetAmount + _convert(exit, conversion, legs);
        if (conversion.listed) {
            uint256 fee = _fee(net);
            _charge(exit, exit.convertTo, fee);
            net -= fee;
        }
        _deliver(exit.owner, exit.convertTo, net);
        (amount0, amount1) = toToken1 ? (uint256(0), net) : (net, uint256(0));
    }

    /// Converts all of the source through F1b's executor and holds the output
    /// to the fee-aware floor against the anchor. A leg's amountIn is exact;
    /// zero on a pool leg means everything that remains (a router leg's
    /// calldata fixes its own amount). Whatever is not converted refuses the
    /// execution.
    function _convert(Exit memory exit, Conversion memory conversion, DominoV2Types.SwapLeg[] calldata legs)
        private
        returns (uint256 converted)
    {
        uint256 amount = conversion.sourceAmount;
        if (amount == 0) return 0;
        DominoV2Types.SwapLeg[] memory plan = legs;
        uint256 remaining = amount;
        for (uint256 i; i < plan.length; ++i) {
            DominoV2Types.SwapLeg memory leg = plan[i];
            if (leg.tokenIn != conversion.source || leg.tokenOut != exit.convertTo) revert InvalidExecution();
            if (leg.amountIn == 0) {
                if (leg.kind == DominoV2Types.LEG_UNIVERSAL_ROUTER) revert InvalidExecution();
                leg.amountIn = uint128(remaining);
            }
            if (leg.amountIn > remaining) revert InvalidExecution();
            remaining -= leg.amountIn;
        }
        if (remaining != 0) revert InvalidExecution();
        address[] memory tracked = new address[](3);
        tracked[0] = exit.pool.currency0;
        tracked[1] = exit.pool.currency1;
        uint256[] memory out = _executeLegs(plan, tracked);
        for (uint256 i; i < out.length; ++i) {
            converted += out[i];
        }
        uint256 floor = DominoSwapFloor.minimumOutput(
            amount, exit.anchorSqrtPriceX96, conversion.toToken1, _poolFee(exit.pool, conversion.toToken1), exit.maxSlippageBps
        );
        if (converted < floor) revert BelowMinimum();
    }

    /// The vault's pool fee for the conversion's direction, as DominoSwapFloor
    /// reads it: a v4 pool's protocol plus LP fee from the PoolManager, a v3
    /// pool's fee tier. Above MAX_POOL_FEE_PIPS it counts as that ceiling, so
    /// a hook that raises a dynamic fee cannot lower the floor further.
    function _poolFee(DominoV2Types.PoolRef memory pool, bool zeroForOne) private view returns (uint24 fee) {
        if (pool.dex == DominoV2Types.DEX_V4) (, fee) = DominoSwapFloor.v4SpotAndFee(V4_POOL_MANAGER, pool, zeroForOne);
        else fee = pool.fee;
        if (fee > MAX_POOL_FEE_PIPS) fee = MAX_POOL_FEE_PIPS;
    }

    function _charge(Exit memory exit, address token, uint256 amount) private {
        _chargeFee(DominoV2Types.FEE_KIND_AUTO_EXIT, token, exit.owner, amount, exit.mandateHash);
    }

    /// Pushes `amount` to the owner; what does not leave becomes a credit.
    function _deliver(address owner, address token, uint256 amount) private {
        if (amount == 0) return;
        uint256 debited = _push(token, owner, amount, token == address(0) ? NATIVE_SEND_GAS : gasleft());
        if (debited < amount) {
            uint256 total = unclaimed[owner][token] + (amount - debited);
            unclaimed[owner][token] = total;
            emit DeliveryDeferred(owner, token, amount - debited, total);
        }
    }

    /// A transfer measured on this contract's balance, whatever the token
    /// reports. Moving more than `amount` would spend balances owed to others.
    function _push(address token, address to, uint256 amount, uint256 gasLimit) private returns (uint256 debited) {
        uint256 balance = DominoTokenOps.selfBalance(token);
        DominoTokenOps.tryTransfer(token, to, amount, gasLimit);
        uint256 remaining = DominoTokenOps.selfBalance(token);
        if (remaining < balance) debited = balance - remaining;
        if (debited > amount) revert DeliveryMismatch(token);
    }

    function _fee(uint256 amount) private pure returns (uint256) {
        return DominoFeeRules.feeOf(amount, DominoV2Types.FEE_AUTO_EXIT_BPS);
    }

    function _setExiting(bool value) private {
        assembly ("memory-safe") {
            tstore(EXITING_SLOT, value)
        }
    }

    function _exiting() private view returns (bool value) {
        assembly ("memory-safe") {
            value := tload(EXITING_SLOT)
        }
    }
}
