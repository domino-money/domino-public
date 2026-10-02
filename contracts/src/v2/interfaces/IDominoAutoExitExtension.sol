// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The auto-exit module's surface beyond the frozen IDominoAutoExit
/// (#283, S3; workstream F4). Additive: records, nonce cancellation, deferred
/// deliveries, the module's parameters and its own revert reasons. Swap legs,
/// fees and the shared lock raise F1b's errors (DominoSwapExecutor,
/// DominoFeeLedger, DominoActionLock), documented in docs/v2/F1_FEES_ROUTE.md.
/// @dev Semantics in docs/v2/F4_AUTO_EXIT.md. A mandate's id is its EIP-712
/// struct hash (DominoV2Types.hashExitMandate); the signature covers the
/// domain (chain id and this module's address) on top of it.
interface IDominoAutoExitExtension {
    error MandateAlreadyRegistered();
    error InvalidSignature();
    error NonceAlreadyUsed();
    error AutomationHalted();
    error ExitModuleNotEnabled();
    error VaultOwnerChanged();
    error InvalidAnchor();
    error TwapWindowTooShort();
    error InvalidExecution();
    error BelowMinimum();
    error NothingToClaim();
    error InvalidRecipient();
    /// A push moved more than asked (it would spend what is owed to others),
    /// or a claim did not move exactly the credit.
    error DeliveryMismatch(address token);

    /// A registered mandate as stored. status: 0 unknown, 1 active, 2 revoked, 3 executed.
    struct MandateRecord {
        address owner;
        uint64 validUntil;
        uint16 maxSlippageBps;
        uint8 receiveMode;
        uint8 status;
        address vault;
        address convertTo;
        uint160 triggerBelowSqrtPriceX96;
        uint160 triggerAboveSqrtPriceX96;
        uint256 tokenId;
    }

    /// What the module passes to IDominoVault.executeExit, abi-encoded:
    /// abi.encode(version, mandateHash, recipient, amount0Min, amount1Min).
    /// The vault removes all liquidity of the token id with these minimums,
    /// sends everything withdrawn (principal and the position's fees) to
    /// `recipient`, which is the module itself, and returns its unconsumed
    /// reserves to the owner without fee.
    struct ExitInstruction {
        uint8 version;
        bytes32 mandateHash;
        address recipient;
        uint128 amount0Min;
        uint128 amount1Min;
    }

    event NonceCancelled(address indexed owner, uint256 indexed nonce);
    /// The owner could not receive `amount` of `token` (a native receiver
    /// without receive(), a frozen account); it waits for claim().
    event DeliveryDeferred(address indexed owner, address indexed token, uint256 amount, uint256 totalUnclaimed);
    event Claimed(address indexed owner, address indexed token, address indexed recipient, uint256 amount);

    /// The ceiling on a mandate's maxSlippageBps, which excludes the pool's fee.
    function MAX_SLIPPAGE_BPS() external view returns (uint16);
    /// The most pool fee (pips) the conversion floor deducts; a higher fee counts as this.
    function MAX_POOL_FEE_PIPS() external view returns (uint24);
    /// The ExitInstruction version this module sends.
    function INSTRUCTION_VERSION() external view returns (uint8);
    function priceAnchor() external view returns (address);
    /// The longest validity window (validUntil - observedAt) of a signed observation.
    function maxObservationAgeSeconds() external view returns (uint32);
    /// The shortest v3 TWAP window accepted as an exit's anchor.
    function minTwapSeconds() external view returns (uint32);

    function mandateOf(bytes32 mandateHash) external view returns (MandateRecord memory record);
    /// True once the owner's nonce registered a mandate or was cancelled.
    function nonceUsed(address owner, uint256 nonce) external view returns (bool used);
    function unclaimed(address owner, address token) external view returns (uint256 amount);

    /// Voids a signed mandate that was never registered: its nonce can no longer register.
    function cancelNonce(uint256 nonce) external;
    /// Sends the caller's deferred delivery of `token` to `recipient`.
    function claim(address token, address recipient) external returns (uint256 amount);
}
