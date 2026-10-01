// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Shared wire types, constants and EIP-712 hashing for Domino V2.
/// @dev F0 interface freeze (docs/v2/F0_INTERFACES.md). Every contract, the
/// backend and the app use these exact definitions; the type strings below are
/// exported verbatim to api-contracts/v2/eip712.json. Changing any of them is
/// an interface change and moves the pinned hashes in the tests on purpose.
library DominoV2Types {
    // ------------------------------------------------------------ versions
    uint8 internal constant DEX_V3 = 3;
    uint8 internal constant DEX_V4 = 4;

    // ---------------------------------------------------------------- fees
    /// Basis points of each on-chain tariff. The bridge deposit fee (35 bps)
    /// is charged by the bridge provider off-chain and is not listed here.
    uint16 internal constant FEE_ASSISTED_SWAP_BPS = 65;
    uint16 internal constant FEE_AUTOMATION_SIMPLE_BPS = 200;
    uint16 internal constant FEE_AUTOMATION_DOMINO_BPS = 400;
    uint16 internal constant FEE_AUTO_EXIT_BPS = 20;

    /// Fee kinds, as emitted in FeeCharged.
    uint8 internal constant FEE_KIND_ASSISTED_SWAP = 1;
    uint8 internal constant FEE_KIND_AUTOMATION = 2;
    uint8 internal constant FEE_KIND_AUTO_EXIT = 3;

    // ------------------------------------------------------------- actions
    uint8 internal constant ACTION_CREATE = 1;
    uint8 internal constant ACTION_INCREASE = 2;
    uint8 internal constant ACTION_CHANGE_RANGE = 3;
    uint8 internal constant ACTION_EXIT = 4;

    /// Swap legs: an allowlisted Universal Router call, or a direct pool path.
    uint8 internal constant LEG_UNIVERSAL_ROUTER = 1;
    uint8 internal constant LEG_V3_POOL = 2;
    uint8 internal constant LEG_V4_POOL = 3;

    /// Automation modes and their tariffs (FEE_AUTOMATION_*).
    uint8 internal constant MODE_SIMPLE = 1;
    uint8 internal constant MODE_DOMINO = 2;

    /// What an exit delivers: both pool tokens as withdrawn, or one token.
    uint8 internal constant RECEIVE_BOTH = 0;
    uint8 internal constant RECEIVE_CONVERTED = 1;

    /// Registry changes scheduled by governance; `data` is the abi-encoded argument.
    bytes32 internal constant REGISTRY_OPERATOR = keccak256("domino.registry.operator"); // (address, bool)
    bytes32 internal constant REGISTRY_PUBLISHER = keccak256("domino.registry.publisher"); // (address, bool)
    bytes32 internal constant REGISTRY_ROUTER = keccak256("domino.registry.router"); // (address, uint16 version; 0 removes)
    bytes32 internal constant REGISTRY_CHARGE_CURRENCY = keccak256("domino.registry.chargeCurrency"); // (address, uint8 rank)
    bytes32 internal constant REGISTRY_FEE_RECIPIENT = keccak256("domino.registry.feeRecipient"); // (address)
    bytes32 internal constant REGISTRY_GUARDIAN = keccak256("domino.registry.guardian"); // (address)
    bytes32 internal constant REGISTRY_TIMELOCK = keccak256("domino.registry.timelock"); // (uint32 seconds)
    bytes32 internal constant REGISTRY_RESUME_AUTOMATION = keccak256("domino.registry.resumeAutomation"); // ()

    // ---------------------------------------------------------------- types
    /// A pool on either Uniswap version. For v3, `fee` selects the pool and
    /// `tickSpacing` must be the factory's spacing for that fee; `hooks` is 0.
    /// For v4 the five PoolKey fields keep their PoolKey meaning. Native
    /// currency is address(0) on v4 only; v3 uses the wrapped token.
    struct PoolRef {
        uint8 dex;
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// A position NFT: its manager and token id.
    struct PositionRef {
        uint8 dex;
        address positionManager;
        uint256 tokenId;
    }

    /// A price attested by an admitted publisher, verified at use. No block
    /// hash binding: freshness is observedAt/validUntil on every chain.
    struct PriceObservation {
        PoolRef pool;
        uint160 sqrtPriceX96;
        uint64 observedAt;
        uint64 validUntil;
        uint64 nonce;
    }

    /// The readable, owner-signed core of a manual position action. Used as
    /// the Permit2 witness when tokens are pulled, and as a direct EIP-712
    /// signature when a relayer submits an action that pulls nothing.
    /// routesHash = keccak256(abi.encode(SwapLeg[])) of the plan's legs.
    struct PositionIntent {
        uint8 action;
        PoolRef pool;
        uint256 tokenId;
        int24 tickLower;
        int24 tickUpper;
        uint128 minLiquidity;
        uint16 feeBps;
        address feeToken;
        bytes32 routesHash;
        address recipient;
        uint256 nonce;
        uint64 deadline;
    }

    /// The owner's standing order for one exit. Zero disables a trigger; both
    /// may be set (stop-loss and take-profit). Prices are the pool's sqrt
    /// price (token1 per token0, Q64.96). One-shot: it ends when it fires.
    struct ExitMandate {
        address owner;
        address vault;
        uint256 tokenId;
        uint160 triggerBelowSqrtPriceX96;
        uint160 triggerAboveSqrtPriceX96;
        uint8 receiveMode;
        address convertTo;
        uint16 maxSlippageBps;
        uint64 validUntil;
        uint256 nonce;
    }

    // ------------------------------------------------------ ABI-only types
    /// One swap. `data` is the router calldata (LEG_UNIVERSAL_ROUTER), the v3
    /// path bytes (LEG_V3_POOL) or abi.encode(PoolRef[]) (LEG_V4_POOL). The
    /// executor checks balances, not calldata: exactly amountIn leaves, at
    /// least minAmountOut of tokenOut arrives, and nothing else moves.
    struct SwapLeg {
        uint8 kind;
        address router;
        address tokenIn;
        address tokenOut;
        uint128 amountIn;
        uint128 minAmountOut;
        bytes data;
    }

    struct TokenAmount {
        address token;
        uint128 amount;
    }

    // --------------------------------------------------------- EIP-712
    string internal constant EIP712_NAME = "Domino";
    string internal constant EIP712_VERSION = "2";

    string internal constant POOL_REF_TYPE =
        "PoolRef(uint8 dex,address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
    string internal constant PRICE_OBSERVATION_TYPE =
        "PriceObservation(PoolRef pool,uint160 sqrtPriceX96,uint64 observedAt,uint64 validUntil,uint64 nonce)";
    string internal constant POSITION_INTENT_TYPE =
        "PositionIntent(uint8 action,PoolRef pool,uint256 tokenId,int24 tickLower,int24 tickUpper,uint128 minLiquidity,uint16 feeBps,address feeToken,bytes32 routesHash,address recipient,uint256 nonce,uint64 deadline)";
    string internal constant EXIT_MANDATE_TYPE =
        "ExitMandate(address owner,address vault,uint256 tokenId,uint160 triggerBelowSqrtPriceX96,uint160 triggerAboveSqrtPriceX96,uint8 receiveMode,address convertTo,uint16 maxSlippageBps,uint64 validUntil,uint256 nonce)";

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant POOL_REF_TYPEHASH = keccak256(bytes(POOL_REF_TYPE));
    bytes32 internal constant PRICE_OBSERVATION_TYPEHASH =
        keccak256(abi.encodePacked(PRICE_OBSERVATION_TYPE, POOL_REF_TYPE));
    bytes32 internal constant POSITION_INTENT_TYPEHASH =
        keccak256(abi.encodePacked(POSITION_INTENT_TYPE, POOL_REF_TYPE));
    bytes32 internal constant EXIT_MANDATE_TYPEHASH = keccak256(bytes(EXIT_MANDATE_TYPE));

    /// Permit2 witness: the PositionIntent rides in permitWitnessTransferFrom.
    /// Referenced types are appended in alphabetical order, TokenPermissions
    /// last, exactly as Permit2's SignatureTransfer requires.
    string internal constant PERMIT2_WITNESS_TYPE_STRING = string(
        abi.encodePacked(
            "PositionIntent witness)",
            POOL_REF_TYPE,
            POSITION_INTENT_TYPE,
            "TokenPermissions(address token,uint256 amount)"
        )
    );

    function domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(EIP712_NAME)),
                keccak256(bytes(EIP712_VERSION)),
                chainId,
                verifyingContract
            )
        );
    }

    function digest(bytes32 separator, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", separator, structHash));
    }

    function hashPoolRef(PoolRef memory pool) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                POOL_REF_TYPEHASH, pool.dex, pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks
            )
        );
    }

    function hashPriceObservation(PriceObservation memory point) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PRICE_OBSERVATION_TYPEHASH,
                hashPoolRef(point.pool),
                point.sqrtPriceX96,
                point.observedAt,
                point.validUntil,
                point.nonce
            )
        );
    }

    function hashPositionIntent(PositionIntent memory intent) internal pure returns (bytes32) {
        // Two halves keep the IR stack shallow; the concatenation is the
        // standard EIP-712 encodeData of the twelve fields in order.
        bytes memory head = abi.encode(
            POSITION_INTENT_TYPEHASH,
            intent.action,
            hashPoolRef(intent.pool),
            intent.tokenId,
            intent.tickLower,
            intent.tickUpper,
            intent.minLiquidity
        );
        bytes memory tail = abi.encode(
            intent.feeBps, intent.feeToken, intent.routesHash, intent.recipient, intent.nonce, intent.deadline
        );
        return keccak256(bytes.concat(head, tail));
    }

    function hashExitMandate(ExitMandate memory mandate) internal pure returns (bytes32) {
        bytes memory head = abi.encode(
            EXIT_MANDATE_TYPEHASH,
            mandate.owner,
            mandate.vault,
            mandate.tokenId,
            mandate.triggerBelowSqrtPriceX96,
            mandate.triggerAboveSqrtPriceX96
        );
        bytes memory tail = abi.encode(
            mandate.receiveMode, mandate.convertTo, mandate.maxSlippageBps, mandate.validUntil, mandate.nonce
        );
        return keccak256(bytes.concat(head, tail));
    }

    function routesHash(SwapLeg[] memory legs) internal pure returns (bytes32) {
        return keccak256(abi.encode(legs));
    }
}
