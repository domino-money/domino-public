// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";

/// @notice One owner's automated position sequence (Auto-compound or
/// Domino-compound) on one pool, Uniswap v3 or v4.
/// @dev Custody (#283, approved 1 Oct 2026): the root NFT stays in the owner's
/// wallet with an individual approval to the vault; on v4 the vault is also
/// the position's subscriber, so an owner change pauses automation at once;
/// on v3 the vault re-verifies the position on every execution. Successors
/// minted by Domino-compound are held by the vault. Owner exits never depend
/// on the operator, the publisher, the registry or the engine.
/// The operator's execution plan is defined by workstream F3 (plan version 1,
/// frozen; see IDominoVaultExecution).
interface IDominoVault {
    error Unauthorized();
    error InvalidPolicy();
    error InvalidLimits();
    error AutomationUnavailable();

    struct Policy {
        uint8 mode;
        uint16 triggerDistanceBps;
        uint16 maxOverlapBps;
        uint32 minimumIntervalSeconds;
        uint8 maxPositions;
    }

    /// maxSlippageBps excludes the pool's own fee: the swap floor is the quote
    /// at the anchor price (IDominoPriceAnchor), never the bare spot, less the
    /// pool's total fee (LP plus protocol), less this slippage
    /// (DominoSwapFloor.minimumOutput).
    /// maxPriceImpactBps is the band the anchor enforces: the spot must lie
    /// within a factor (1 + band) above or below the anchor price
    /// (IDominoPriceAnchor.anchor's maxDeviationBps). The name is V1's; it
    /// does not bound how far a swap moves the pool's price.
    struct Limits {
        uint16 maxSlippageBps;
        uint16 maxPriceImpactBps;
        uint32 maxObservationAgeSeconds;
        uint32 upsideBps;
    }

    struct Init {
        DominoV2Types.PositionRef root;
        Policy policy;
        Limits limits;
        bool startPaused;
        bool consentToUncollectedFees;
    }

    event Initialized(address indexed owner, uint8 indexed dex, uint256 indexed rootTokenId, uint8 mode);
    event PolicyChanged(Policy policy, uint64 stateNonce);
    event LimitsChanged(Limits limits, uint64 stateNonce);
    event AutomationPaused(address indexed actor, uint64 stateNonce);
    event AutomationResumed(uint64 stateNonce);
    event RootDisarmed(uint8 reason, uint64 stateNonce);
    event RootRearmed(uint64 stateNonce);
    event Compounded(
        uint256 indexed tokenId,
        uint128 liquidityAdded,
        uint256 fees0,
        uint256 fees1,
        uint256 serviceFee0,
        uint256 serviceFee1,
        uint64 stateNonce
    );
    event SuccessorCreated(uint256 indexed parentTokenId, uint256 indexed tokenId, uint64 stateNonce);
    event ReservesWithdrawn(address indexed token, uint256 amount, uint64 stateNonce);
    event ChildWithdrawn(uint256 indexed tokenId, uint64 stateNonce);
    event TokenRecovered(address indexed token, uint256 amount);
    event ExitModuleSet(address indexed module, uint64 stateNonce);
    event ExitExecuted(address indexed module, uint256 indexed tokenId, uint256 amount0, uint256 amount1, uint64 stateNonce);

    // ---------------------------------------------------------------- views
    function owner() external view returns (address);
    function factory() external view returns (address);
    function registry() external view returns (address);
    function pool() external view returns (DominoV2Types.PoolRef memory);
    function root() external view returns (DominoV2Types.PositionRef memory);
    function positions() external view returns (uint256[] memory tokenIds);
    function policy() external view returns (Policy memory);
    function limits() external view returns (Limits memory);
    function paused() external view returns (bool);
    function rootArmed() external view returns (bool);
    function stateNonce() external view returns (uint64);
    /// Fees collected but not yet reinvested, per pool token; the owner may withdraw them.
    function reserves(address token) external view returns (uint256);
    function exitModule() external view returns (address);

    // ------------------------------------------------------------ owner
    function setPolicy(Policy calldata next) external;
    function setLimits(Limits calldata next) external;
    function pause() external; // owner or an admitted operator
    function resume() external;
    function rearm(bool consentToUncollectedFees) external;
    /// To `recipient`, which the owner names (never zero).
    function withdrawReserves(address token, uint256 amount, address recipient) external;
    function withdrawChild(uint256 tokenId) external;
    /// Any token that is not accounted to the vault, including tokens outside the pair.
    function recoverToken(address token, uint256 amount) external;
    /// Ends the sequence: every child NFT and every reserve goes to the owner,
    /// the root is disarmed and the exit module is disabled.
    function exitAll() external;
    /// Enables (or, with address(0), disables) the auto-exit module for this vault.
    function setExitModule(address module) external;

    /// The enabled auto-exit module only: remove all liquidity of tokenId and
    /// deliver it per the module's verified mandate.
    function executeExit(uint256 tokenId, bytes calldata instruction) external returns (uint256 amount0, uint256 amount1);
}

/// @notice The operator's entry point, owned by workstream F3: the plan
/// encoding is versioned in its first byte, and version 1 is frozen (F3_VAULT.md).
interface IDominoVaultExecution {
    event Executed(bytes32 indexed planHash, uint8 action, uint64 stateNonce);

    function execute(bytes calldata plan) external returns (bytes32 planHash);
}

interface IDominoVaultFactory {
    error InvalidInit();
    error UnexpectedNonce(uint256 expected, uint256 supplied);

    event VaultCreated(
        address indexed owner, address indexed vault, uint256 indexed rootTokenId, uint8 dex, uint256 ownerNonce
    );

    function dex() external view returns (uint8);
    function implementation() external view returns (address);
    function registry() external view returns (address);
    function isVault(address account) external view returns (bool);
    function nextNonce(address owner) external view returns (uint256);
    function predictVault(address owner, uint256 nonce) external view returns (address);
    function createVault(IDominoVault.Init calldata init, uint256 expectedNonce) external returns (address vault);
}
