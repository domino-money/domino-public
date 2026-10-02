// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoPriceAnchor} from "../../../src/v2/interfaces/IDominoPriceAnchor.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {FullMath} from "../../../src/v2/positions/uniswap/FullMath.sol";

/// @dev Test doubles for the auto-exit suites. The registry, the anchor and the
/// vault implement the frozen F0 interfaces with the semantics their NatSpec
/// states; knobs make each one adversarial where a test needs it.

/// An ERC-20 with the failure modes a delivery must survive, chosen per
/// recipient, and the allowance surface Permit2 pulls through.
contract MockToken {
    uint8 public constant NORMAL = 0;
    uint8 public constant REVERTS = 1; // reverts with no data
    uint8 public constant RETURNS_FALSE = 2; // moves nothing and returns false
    uint8 public constant LIES = 3; // moves the amount and returns false
    uint8 public constant OVERDEBITS = 4; // debits the sender one unit more

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    /// How a transfer to this recipient behaves.
    mapping(address => uint8) public towards;
    /// Successful transfers return no data (USDT-style).
    bool public noReturnData;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setTowards(address recipient, uint8 behaviour) external {
        towards[recipient] = behaviour;
    }

    function setNoReturnData(bool value) external {
        noReturnData = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) private returns (bool) {
        uint8 behaviour = towards[to];
        if (behaviour == REVERTS) {
            assembly {
                revert(0, 0)
            }
        }
        if (behaviour == RETURNS_FALSE) return false;
        balanceOf[from] -= behaviour == OVERDEBITS ? amount + 1 : amount;
        balanceOf[to] += amount;
        if (behaviour == LIES) return false;
        if (noReturnData) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }
}

/// The registry's frozen surface. Governance changes are immediate here (the
/// timelock is not what these suites test); the guardian narrows trust at once.
contract MockRegistry is IDominoRegistry {
    error NotModelled();

    address public governance;
    address public pendingGovernance;
    address public guardian;
    uint32 public timelockSeconds;
    mapping(address => bool) public isOperator;
    mapping(address => bool) public isPublisher;
    mapping(address => uint16) public routerVersion;
    mapping(address => uint8) public chargeCurrencyRank;
    address public feeRecipient;
    uint64 public observationEpoch;
    bool public automationHalted;

    constructor(address guardian_) {
        governance = msg.sender;
        guardian = guardian_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert Unauthorized();
        _;
    }

    function setOperator(address account, bool allowed) external onlyGovernance {
        isOperator[account] = allowed;
        emit OperatorSet(account, allowed);
    }

    function setPublisher(address account, bool allowed) external onlyGovernance {
        isPublisher[account] = allowed;
        emit PublisherSet(account, allowed);
    }

    function setRouter(address router, uint16 version) external onlyGovernance {
        routerVersion[router] = version;
        emit RouterSet(router, version);
    }

    function setChargeCurrency(address token, uint8 rank) external onlyGovernance {
        chargeCurrencyRank[token] = rank;
        emit ChargeCurrencySet(token, rank);
    }

    function setFeeRecipient(address recipient) external onlyGovernance {
        feeRecipient = recipient;
        emit FeeRecipientSet(recipient);
    }

    function resumeAutomation() external onlyGovernance {
        automationHalted = false;
        emit AutomationHaltSet(false);
    }

    function transferGovernance(address pending) external onlyGovernance {
        pendingGovernance = pending;
        emit GovernanceTransferStarted(governance, pending);
    }

    function acceptGovernance() external {
        if (msg.sender != pendingGovernance) revert Unauthorized();
        emit GovernanceTransferred(governance, msg.sender);
        governance = msg.sender;
        pendingGovernance = address(0);
    }

    function scheduleChange(bytes32, bytes calldata) external pure returns (bytes32) {
        revert NotModelled();
    }

    function executeChange(bytes32) external pure {
        revert NotModelled();
    }

    function cancelChange(bytes32) external pure {
        revert NotModelled();
    }

    function removeOperator(address operator) external onlyGuardian {
        isOperator[operator] = false;
        emit OperatorSet(operator, false);
    }

    function removePublisher(address publisher) external onlyGuardian {
        isPublisher[publisher] = false;
        emit PublisherSet(publisher, false);
    }

    function removeRouter(address router) external onlyGuardian {
        routerVersion[router] = 0;
        emit RouterSet(router, 0);
    }

    function raiseObservationEpoch(uint64 epoch) external onlyGuardian {
        if (epoch <= observationEpoch) revert InvalidChange();
        observationEpoch = epoch;
        emit ObservationEpochRaised(epoch);
    }

    function haltAutomation() external onlyGuardian {
        automationHalted = true;
        emit AutomationHaltSet(true);
    }
}

/// The anchor as IDominoPriceAnchor describes it and F1a implements it
/// (docs/v2/F1_REGISTRY_ANCHOR.md, PR #290): the spot first, then a
/// publisher-signed observation (this contract's EIP-712 domain) or a v3 TWAP
/// whose window lies within [MIN_TWAP_SECONDS, maxAgeSeconds], then the band,
/// symmetric on the price. Knobs: down, or a zero price (which F1a never
/// returns, so the module's own refusal can be tested).
contract MockPriceAnchor is IDominoPriceAnchor {
    error AnchorDown();
    error PoolUnavailable();
    error Unauthorized();

    uint8 public constant HONEST = 0;
    uint8 public constant DOWN = 1;
    uint8 public constant ZERO_PRICE = 2;
    uint32 public constant MIN_TWAP_SECONDS = 60;
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    address public immutable registry;
    uint8 public mode;
    mapping(bytes32 => uint160) public spotOf;
    mapping(bytes32 => uint160) public twapOf;
    mapping(bytes32 => bool) public isRevoked;

    constructor(address registry_) {
        registry = registry_;
    }

    function setMode(uint8 value) external {
        mode = value;
    }

    function setSpot(DominoV2Types.PoolRef memory pool, uint160 sqrtPriceX96) external {
        spotOf[DominoV2Types.hashPoolRef(pool)] = sqrtPriceX96;
    }

    function setTwap(DominoV2Types.PoolRef memory pool, uint160 sqrtPriceX96) external {
        twapOf[DominoV2Types.hashPoolRef(pool)] = sqrtPriceX96;
    }

    function domainSeparator() public view returns (bytes32) {
        return DominoV2Types.domainSeparator(block.chainid, address(this));
    }

    /// The digest a publisher signs, and the key revocation takes.
    function hashObservation(DominoV2Types.PriceObservation memory point) public view returns (bytes32) {
        return DominoV2Types.digest(domainSeparator(), DominoV2Types.hashPriceObservation(point));
    }

    function verifyObservation(
        DominoV2Types.PriceObservation calldata point,
        bytes calldata signature,
        uint32 maxAgeSeconds
    ) external view returns (uint160) {
        return _verify(point, signature, maxAgeSeconds);
    }

    function twapSqrtPrice(DominoV2Types.PoolRef calldata pool, uint32 secondsAgo) public view returns (uint160 price) {
        if (pool.dex != DominoV2Types.DEX_V3 || secondsAgo == 0) revert TwapUnavailable();
        price = twapOf[DominoV2Types.hashPoolRef(pool)];
        if (price == 0) revert TwapUnavailable();
    }

    function anchor(
        DominoV2Types.PoolRef calldata pool,
        bytes calldata evidence,
        uint32 maxAgeSeconds,
        uint16 maxDeviationBps
    ) external view returns (uint160 anchorSqrtPriceX96, uint160 spotSqrtPriceX96) {
        if (mode == DOWN) revert AnchorDown();
        spotSqrtPriceX96 = spotOf[DominoV2Types.hashPoolRef(pool)];
        if (spotSqrtPriceX96 == 0) revert PoolUnavailable();
        if (evidence.length == 32) {
            uint256 secondsAgo = uint256(bytes32(evidence));
            if (secondsAgo < MIN_TWAP_SECONDS || secondsAgo > maxAgeSeconds) revert TwapUnavailable();
            anchorSqrtPriceX96 = twapSqrtPrice(pool, uint32(secondsAgo));
        } else {
            (DominoV2Types.PriceObservation memory point, bytes memory signature) =
                abi.decode(evidence, (DominoV2Types.PriceObservation, bytes));
            if (DominoV2Types.hashPoolRef(point.pool) != DominoV2Types.hashPoolRef(pool)) revert InvalidObservation();
            anchorSqrtPriceX96 = _verify(point, signature, maxAgeSeconds);
        }
        if (!_withinBand(anchorSqrtPriceX96, spotSqrtPriceX96, maxDeviationBps)) revert SpotOutsideBand();
        if (mode == ZERO_PRICE) anchorSqrtPriceX96 = 0;
    }

    function revokeObservation(bytes32 observationHash) external {
        if (!IDominoRegistry(registry).isPublisher(msg.sender) && msg.sender != IDominoRegistry(registry).guardian()) {
            revert Unauthorized();
        }
        if (isRevoked[observationHash]) revert ObservationRevoked();
        isRevoked[observationHash] = true;
        emit ObservationRevokedBy(observationHash, msg.sender);
    }

    /// F1a's order: price range and a future date, the window, the signer,
    /// then revocation and the registry epoch.
    function _verify(DominoV2Types.PriceObservation memory point, bytes memory signature, uint32 maxAgeSeconds)
        private
        view
        returns (uint160)
    {
        if (
            point.sqrtPriceX96 < MIN_SQRT_PRICE || point.sqrtPriceX96 > MAX_SQRT_PRICE
                || point.observedAt > block.timestamp
        ) revert InvalidObservation();
        if (block.timestamp > point.validUntil || point.validUntil - point.observedAt > maxAgeSeconds) {
            revert ObservationExpired();
        }
        bytes32 digest = hashObservation(point);
        if (signature.length != 65) revert InvalidObservation();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) revert InvalidObservation();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || !IDominoRegistry(registry).isPublisher(signer)) revert InvalidObservation();
        if (isRevoked[digest] || point.observedAt < IDominoRegistry(registry).observationEpoch()) {
            revert ObservationRevoked();
        }
        return point.sqrtPriceX96;
    }

    /// max(a, b)^2 * 10000 <= min(a, b)^2 * (10000 + d), on the price; a zero
    /// price is outside every band (F1a's AnchorMath.withinBand, at Q96 precision).
    function _withinBand(uint160 a, uint160 b, uint16 maxDeviationBps) private pure returns (bool) {
        (uint160 high, uint160 low) = a > b ? (a, b) : (b, a);
        if (low == 0) return false;
        return FullMath.mulDiv(high, high, 1 << 96) * 10_000
            <= FullMath.mulDiv(low, low, 1 << 96) * (10_000 + uint256(maxDeviationBps));
    }
}

/// A vault as the auto-exit sees it. executeExit follows the F4 contract
/// (docs/v2/F4_AUTO_EXIT.md): only the enabled module, instruction v1, the
/// removal minimums, everything withdrawn to the recipient, reserves to the
/// owner without fee. Knobs: withhold part of the withdrawal while reporting
/// it all, and call back into a target during the exit.
contract MockVault is IDominoVault {
    error NotModelled();
    error UnknownPosition();
    error InvalidInstruction();
    error PriceSlippageCheck();

    struct Held {
        bool exists;
        uint256 amount0;
        uint256 amount1;
    }

    address public owner;
    address public immutable registry;
    address public exitModule;
    uint64 public stateNonce;
    DominoV2Types.PoolRef private _pool;
    mapping(uint256 => Held) public held;
    uint256[] private _tokenIds;
    mapping(address => uint256) public reserves;

    uint256 public withhold0;
    uint256 public withhold1;
    address public reentryTarget;
    bytes public reentryData;
    bool public reentryAttempted;
    bool public reentryOk;
    bytes public reentryResult;
    bytes public lastInstruction;
    uint256 public lastTokenId;
    uint256 public exits;

    constructor(address owner_, address registry_, DominoV2Types.PoolRef memory pool_) {
        owner = owner_;
        registry = registry_;
        _pool = pool_;
    }

    receive() external payable {}

    // ------------------------------------------------------- test knobs
    function setOwner(address next) external {
        owner = next;
    }

    function setPool(DominoV2Types.PoolRef memory next) external {
        _pool = next;
    }

    function setPosition(uint256 tokenId, uint256 amount0, uint256 amount1) external {
        if (!held[tokenId].exists) _tokenIds.push(tokenId);
        held[tokenId] = Held({exists: true, amount0: amount0, amount1: amount1});
    }

    function setReserve(address token, uint256 amount) external {
        reserves[token] = amount;
    }

    function setWithhold(uint256 amount0, uint256 amount1) external {
        withhold0 = amount0;
        withhold1 = amount1;
    }

    function setReentry(address target, bytes calldata data) external {
        reentryTarget = target;
        reentryData = data;
    }

    // ------------------------------------------------------------ views
    function factory() external pure returns (address) {
        return address(0);
    }

    function pool() external view returns (DominoV2Types.PoolRef memory) {
        return _pool;
    }

    function root() external view returns (DominoV2Types.PositionRef memory ref) {
        ref.dex = _pool.dex;
        if (_tokenIds.length != 0) ref.tokenId = _tokenIds[0];
    }

    function positions() external view returns (uint256[] memory tokenIds) {
        return _tokenIds;
    }

    function policy() external pure returns (Policy memory) {}

    function limits() external pure returns (Limits memory) {}

    function paused() external pure returns (bool) {
        return false;
    }

    function rootArmed() external pure returns (bool) {
        return true;
    }

    // ------------------------------------------------------------ owner
    function setExitModule(address module) external {
        if (msg.sender != owner) revert Unauthorized();
        exitModule = module;
        emit ExitModuleSet(module, ++stateNonce);
    }

    function setPolicy(Policy calldata) external pure {
        revert NotModelled();
    }

    function setLimits(Limits calldata) external pure {
        revert NotModelled();
    }

    function pause() external pure {
        revert NotModelled();
    }

    function resume() external pure {
        revert NotModelled();
    }

    function rearm(bool) external pure {
        revert NotModelled();
    }

    function withdrawReserves(address, uint256) external pure {
        revert NotModelled();
    }

    function withdrawChild(uint256) external pure {
        revert NotModelled();
    }

    function recoverToken(address, uint256) external pure {
        revert NotModelled();
    }

    function exitAll() external pure {
        revert NotModelled();
    }

    // ------------------------------------------------------------- exit
    function executeExit(uint256 tokenId, bytes calldata instruction)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        if (msg.sender != exitModule || exitModule == address(0)) revert Unauthorized();
        (uint8 version,, address recipient, uint128 min0, uint128 min1) =
            abi.decode(instruction, (uint8, bytes32, address, uint128, uint128));
        if (version != 1 || recipient != msg.sender) revert InvalidInstruction();
        Held storage position = held[tokenId];
        if (!position.exists) revert UnknownPosition();
        amount0 = position.amount0;
        amount1 = position.amount1;
        if (amount0 < min0 || amount1 < min1) revert PriceSlippageCheck();
        position.amount0 = 0;
        position.amount1 = 0;
        _pay(_pool.currency0, owner, reserves[_pool.currency0]);
        _pay(_pool.currency1, owner, reserves[_pool.currency1]);
        reserves[_pool.currency0] = 0;
        reserves[_pool.currency1] = 0;
        _pay(_pool.currency0, recipient, amount0 - withhold0);
        _pay(_pool.currency1, recipient, amount1 - withhold1);
        if (reentryTarget != address(0)) {
            reentryAttempted = true;
            (reentryOk, reentryResult) = reentryTarget.call(reentryData);
        }
        lastInstruction = instruction;
        lastTokenId = tokenId;
        exits += 1;
        emit ExitExecuted(msg.sender, tokenId, amount0, amount1, ++stateNonce);
    }

    function _pay(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "native");
        } else {
            (bool ok,) = token.call(abi.encodeCall(MockToken.transfer, (to, amount)));
            require(ok, "token");
        }
    }
}

/// An EIP-1271 wallet owner, honest or adversarial.
contract MockERC1271Wallet {
    uint8 public constant VERIFY = 0;
    uint8 public constant REVERT_WITH_MAGIC = 1;
    uint8 public constant SHORT_MAGIC = 2;

    address public immutable signer;
    uint8 public mode;

    constructor(address signer_) {
        signer = signer_;
    }

    function setMode(uint8 value) external {
        mode = value;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (mode == REVERT_WITH_MAGIC) {
            assembly {
                mstore(0, shl(224, 0x1626ba7e))
                revert(0, 32)
            }
        }
        if (mode == SHORT_MAGIC) {
            assembly {
                mstore(0, shl(224, 0x1626ba7e))
                return(0, 4)
            }
        }
        if (signature.length != 65) return 0xffffffff;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        return ecrecover(digest, uint8(signature[64]), r, s) == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    /// The wallet acting as owner: any call.
    function run(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }
}

/// Code for an account that refuses native currency (an EIP-7702 delegate
/// without receive(), a contract wallet that rejects it).
contract NativeRefuser {
    receive() external payable {
        revert();
    }
}

/// A receiver that burns every unit of gas it is given.
contract GasBurner {
    receive() external payable {
        while (true) {}
    }
}

/// A receiver that tries to send native currency back to the sender.
contract NativeBouncer {
    bool public bounced;
    bool public bounceOk;

    receive() external payable {
        if (bounced) return;
        bounced = true;
        (bounceOk,) = msg.sender.call{value: msg.value}("");
    }
}
