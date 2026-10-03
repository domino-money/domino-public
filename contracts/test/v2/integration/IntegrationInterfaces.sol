// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IV4PoolManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {IDominoAutoExit} from "../../../src/v2/interfaces/IDominoAutoExit.sol";
import {IDominoAutoExitExtension} from "../../../src/v2/interfaces/IDominoAutoExitExtension.sol";
import {IDominoFeeSettlement} from "../../../src/v2/interfaces/IDominoFees.sol";
import {IDominoPriceAnchor} from "../../../src/v2/interfaces/IDominoPriceAnchor.sol";
import {IDominoVault, IDominoVaultExecution} from "../../../src/v2/interfaces/IDominoVault.sol";
import {IDominoVaultLedger} from "../../../src/v2/interfaces/IDominoVaultLedger.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";

// Every name here is an interface, a struct or an abstract type. solc 0.8.26
// compiles each concrete contract in a test file's import closure whenever the
// file is rebuilt, even the ones nobody deploys (Forge lists them in the
// output selection with no outputs), so a suite that imported a production
// contract or a fixture runtime paid that contract's via-IR compile again,
// once per suite (#303, 2-4 CI minutes each). The suites therefore import only
// these declarations and deploy every concrete contract from its artifact:
// production ones from src/ (Forge rebuilds those on every run), test helpers
// and fixture runtimes from IntegrationArtifacts.sol, which CI builds first.

/// The Uniswap deployments the journeys run on, as IntegrationStage installed them.
struct IntegrationChain {
    address v3Factory;
    address v3PositionManager;
    address weth9;
    address v4PoolManager;
    address v4PositionManager;
    address v4StateView;
    address permit2;
    /// The PoolManager the deployed Universal Router settles with (Robinhood's).
    address routerPoolManager;
    address router;
}

/// DominoRegistry.Config, field for field (the constructor's only argument).
struct IntegrationRegistryConfig {
    address governance;
    address guardian;
    uint32 timelockSeconds;
    address feeRecipient;
    address[] operators;
    address[] publishers;
    address[] routers;
    IntegrationChargeCurrency[] chargeCurrencies;
}

struct IntegrationChargeCurrency {
    address token;
    uint8 rank;
}

/// IntegrationArtifacts.sol:IntegrationStage.
interface IIntegrationStage {
    function install() external returns (IntegrationChain memory chain);
    function token() external returns (address);
    function trader() external returns (address);
    function liquidity(address poolManager) external returns (address);
    function probe() external returns (address);
}

/// IntegrationArtifacts.sol:IntegrationToken.
interface IIntegrationToken {
    function mint(address to, uint256 amount) external;
    function setBlocked(address account, bool value) external;
    function setHook(address target, bytes calldata data) external;
    function setHookRecipient(address to) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// IntegrationArtifacts.sol:IntegrationTrader: exact-input swaps that stop at a
/// price limit (zero means no limit), paid from the trader's own balances.
interface IIntegrationTrader {
    function swapV3(address pool, bool zeroForOne, uint256 amountIn, uint160 limit) external;
    function swapV4(address manager, IV4PoolManagerMinimal.PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint160 limit)
        external;
}

/// IntegrationArtifacts.sol:IntegrationLiquidity: full-range or ranged v4 liquidity for pool setup.
interface IIntegrationLiquidity {
    function add(IV4PoolManagerMinimal.PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidity) external;
}

/// IntegrationArtifacts.sol:IntegrationProbe: a token hook's callee that calls
/// `target` and records the outcome without ever reverting, so the transfer
/// that triggered it completes and the test reads what the nested call met.
interface IIntegrationProbe {
    function arm(address target, bytes calldata payload) external;
    function fire() external;
    function calls() external view returns (uint256);
    function successes() external view returns (uint256);
    function lastError() external view returns (bytes4);
}

/// The v3 NonfungiblePositionManager's pool creation (IPoolInitializer).
interface IIntegrationV3Initializer {
    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);
}

/// The v4 PoolManager's initialize.
interface IIntegrationV4Initializer {
    function initialize(IV4PoolManagerMinimal.PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
}

/// The price anchor's surface beyond the frozen interface.
interface IIntegrationAnchor is IDominoPriceAnchor {
    function hashObservation(DominoV2Types.PriceObservation calldata point) external view returns (bytes32);
    function spotSqrtPrice(DominoV2Types.PoolRef calldata pool) external view returns (uint160);
    function v3Factory() external view returns (address);
    function v4StateView() external view returns (address);
    function minTwapSeconds() external view returns (uint32);
}

/// A vault clone: the frozen surface, the operator's entry point, the ledger,
/// fee settlement and the implementation's wiring views.
interface IIntegrationVault is IDominoVault, IDominoVaultExecution, IDominoVaultLedger, IDominoFeeSettlement {
    function wiring() external view returns (DominoV2VaultStorage.Deployment memory);
    function executor() external view returns (address);
}

interface IIntegrationAutoExit is IDominoAutoExit, IDominoAutoExitExtension, IDominoFeeSettlement {}

/// The cheatcodes the integration journeys add to ZapVm.
interface IntegrationVm {
    function getNonce(address account) external view returns (uint64);
    function computeCreateAddress(address deployer, uint256 nonce) external pure returns (address);
}
