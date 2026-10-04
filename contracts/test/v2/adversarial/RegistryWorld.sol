// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoPriceAnchor} from "../../../src/v2/interfaces/IDominoPriceAnchor.sol";
import {IDominoRegistry} from "../../../src/v2/interfaces/IDominoRegistry.sol";

// Shared by the adversarial registry suites. Only interfaces, structs, one
// small double and an abstract base: the registry and the anchor are deployed
// from their artifacts (vm.getCode), so no suite compiles them again through
// IR (docs/v2/INTEGRATION_TESTS.md, "Why the suites import only interfaces").
// Build them once with
//   cd contracts && node ../scripts/test-contracts.mjs build \
//     src/v2/registry/DominoRegistry.sol src/v2/anchor/DominoPriceAnchor.sol

/// The cheatcodes these suites use (the repository has no forge-std).
interface AdvVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 timestamp) external;
    function etch(address target, bytes calldata code) external;
    function getCode(string calldata artifact) external view returns (bytes memory);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
}

/// DominoRegistry beyond the frozen interface: its constants and the views
/// monitoring reads (docs/v2/F1_REGISTRY_ANCHOR.md, "Monitoring").
interface IRegistryProbe is IDominoRegistry {
    function MIN_UNIVERSAL_ROUTER_VERSION() external view returns (uint16);
    function MIN_TIMELOCK_SECONDS() external view returns (uint32);
    function MAX_TIMELOCK_SECONDS() external view returns (uint32);
    function haltedAt() external view returns (uint64);
    function removedAt(bytes32 kind, address subject) external view returns (uint64);
    function pendingChange(bytes32 id)
        external
        view
        returns (bytes32 kind, bytes memory data, uint64 scheduledAt, uint64 executableAt);
}

/// DominoPriceAnchor beyond the frozen interface.
interface IAnchorProbe is IDominoPriceAnchor {
    function hashObservation(DominoV2Types.PriceObservation calldata point) external view returns (bytes32);
    function spotSqrtPrice(DominoV2Types.PoolRef calldata pool) external view returns (uint160);
}

/// DominoRegistry.ChargeCurrency and DominoRegistry.Config, field for field
/// (the constructor's only argument).
struct AdvChargeCurrency {
    address token;
    uint8 rank;
}

struct AdvRegistryConfig {
    address governance;
    address guardian;
    uint32 timelockSeconds;
    address feeRecipient;
    address[] operators;
    address[] publishers;
    address[] routers;
    AdvChargeCurrency[] chargeCurrencies;
}

/// StateView.getSlot0 as deployed, with one settable spot for every pool id:
/// enough for the anchor's v4 spot read.
contract AdvStateView {
    uint160 public price = uint160(1 << 96);

    function set(uint160 value) external {
        price = value;
    }

    function getSlot0(bytes32) external view returns (uint160, int24, uint24, uint24) {
        return (price, int24(0), uint24(0), uint24(3000));
    }
}

/// Deployment, signing and assertion helpers shared by the registry suites.
abstract contract RegistryWorld {
    AdvVm internal constant vm = AdvVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 internal constant OPERATOR_KIND = DominoV2Types.REGISTRY_OPERATOR;
    bytes32 internal constant PUBLISHER_KIND = DominoV2Types.REGISTRY_PUBLISHER;
    bytes32 internal constant ROUTER_KIND = DominoV2Types.REGISTRY_ROUTER;
    bytes32 internal constant CURRENCY_KIND = DominoV2Types.REGISTRY_CHARGE_CURRENCY;
    bytes32 internal constant RECIPIENT_KIND = DominoV2Types.REGISTRY_FEE_RECIPIENT;
    bytes32 internal constant GUARDIAN_KIND = DominoV2Types.REGISTRY_GUARDIAN;
    bytes32 internal constant TIMELOCK_KIND = DominoV2Types.REGISTRY_TIMELOCK;
    bytes32 internal constant RESUME_KIND = DominoV2Types.REGISTRY_RESUME_AUTOMATION;

    // IDominoRegistry's and IDominoPriceAnchor's errors (the anchor's own
    // Unauthorized has the same signature).
    bytes4 internal constant UNAUTHORIZED = bytes4(keccak256("Unauthorized()"));
    bytes4 internal constant INVALID = bytes4(keccak256("InvalidChange()"));
    bytes4 internal constant NOT_READY = bytes4(keccak256("ChangeNotReady()"));
    bytes4 internal constant INVALID_OBSERVATION = bytes4(keccak256("InvalidObservation()"));
    bytes4 internal constant OBSERVATION_REVOKED = bytes4(keccak256("ObservationRevoked()"));

    /// The deployment's timelock on all three chains (owner decision of 2 Oct
    /// 2026; F1_REGISTRY_ANCHOR.md, "Deployment parameters").
    uint32 internal constant DEPLOYED_TIMELOCK = 1 days;
    /// The longest observation window any consumer accepts: the vault's
    /// ceiling and the auto-exit module's value (F3_VAULT.md, F4_AUTO_EXIT.md).
    uint32 internal constant CONSUMER_MAX_AGE = 300;
    uint256 internal constant START = 1_790_870_000;
    uint160 internal constant PRICE = uint160(1 << 96);

    error Mismatch(string what, uint256 actual, uint256 expected);
    error Expected(string what);

    // ============================================================ deploying

    function _create(bytes memory init) internal returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create(0, add(init, 0x20), mload(init))
        }
        if (deployed == address(0)) revert Expected("deployment");
    }

    function _deployRegistry(AdvRegistryConfig memory config) internal returns (IRegistryProbe) {
        return IRegistryProbe(
            _create(abi.encodePacked(vm.getCode("DominoRegistry.sol:DominoRegistry"), abi.encode(config)))
        );
    }

    /// A v4-only anchor (no v3 factory) reading spots from `stateView`, with
    /// the deployment's 60-second TWAP floor.
    function _deployAnchor(address registry, address stateView) internal returns (IAnchorProbe) {
        return IAnchorProbe(
            _create(
                abi.encodePacked(
                    vm.getCode("DominoPriceAnchor.sol:DominoPriceAnchor"),
                    abi.encode(registry, address(0), bytes32(0), stateView, uint32(60))
                )
            )
        );
    }

    /// Gives `account` code, as a deployed router or token has; the registry
    /// checks only that there is some.
    function _giveCode(address account) internal {
        vm.etch(account, hex"00");
    }

    // ============================================================= evidence

    /// The pool every observation in these suites names (v4, no hook).
    function _pool() internal pure returns (DominoV2Types.PoolRef memory) {
        return DominoV2Types.PoolRef(DominoV2Types.DEX_V4, address(0xA0), address(0xB0), 3000, 60, address(0));
    }

    function _point(uint64 observedAt, uint64 validUntil, uint64 nonce)
        internal
        pure
        returns (DominoV2Types.PriceObservation memory)
    {
        return DominoV2Types.PriceObservation(_pool(), PRICE, observedAt, validUntil, nonce);
    }

    /// The EIP-712 digest of `point` on `anchor`, computed here rather than asked of the anchor.
    function _digest(IAnchorProbe anchor, DominoV2Types.PriceObservation memory point)
        internal
        view
        returns (bytes32)
    {
        return DominoV2Types.digest(anchor.domainSeparator(), DominoV2Types.hashPriceObservation(point));
    }

    function _signed(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // =========================================================== assertions

    function _eq(uint256 actual, uint256 expected, string memory what) internal pure {
        if (actual != expected) revert Mismatch(what, actual, expected);
    }

    function _check(bool value, string memory what) internal pure {
        if (!value) revert Expected(what);
    }

    /// The call must revert with exactly `selector` as its first four bytes.
    function _refused(address caller, address target, bytes memory data, bytes4 selector, string memory what)
        internal
    {
        vm.prank(caller);
        (bool ok, bytes memory out) = target.call(data);
        if (ok || out.length < 4 || bytes4(out) != selector) revert Expected(what);
    }
}
