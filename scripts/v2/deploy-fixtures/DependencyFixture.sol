// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Constructor dependencies for deployment-only offline runs: the gas
/// simulation behind every prepared package and the `local-test` mode.
/// @dev This is not Uniswap, Permit2, a token or a journey simulation. It only
/// answers the wiring reads made by the real Domino constructors and by the
/// deployment tool's dependency cross-checks.
contract DeploymentDependencyFixture {
    address private immutable V3_FACTORY;
    address private immutable V4_POOL_MANAGER;
    address private immutable WRAPPED_NATIVE;
    address private immutable PERMIT2;
    constructor(address v3Factory, address v4PoolManager, address wrappedNative, address permit2_) {
        V3_FACTORY = v3Factory; V4_POOL_MANAGER = v4PoolManager; WRAPPED_NATIVE = wrappedNative; PERMIT2 = permit2_;
    }
    function factory() external view returns (address) { return V3_FACTORY; }
    function poolManager() external view returns (address) { return V4_POOL_MANAGER; }
    function WETH9() external view returns (address) { return WRAPPED_NATIVE; }
    function permit2() external view returns (address) { return PERMIT2; }
}
