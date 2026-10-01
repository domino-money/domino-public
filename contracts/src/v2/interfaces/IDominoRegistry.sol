// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Per-chain roles and lists shared by every Domino V2 contract.
/// @dev Anything that widens trust (a new operator, publisher or router, a fee
/// recipient, a guardian) is scheduled by governance and executes after the
/// timelock. The guardian acts immediately, but only to narrow trust:
/// remove a role, void observations, halt automation. Owner exits never
/// depend on this contract.
interface IDominoRegistry {
    error Unauthorized();
    error InvalidChange();
    error ChangeNotReady();

    event GovernanceTransferStarted(address indexed current, address indexed pending);
    event GovernanceTransferred(address indexed previous, address indexed current);
    event ChangeScheduled(bytes32 indexed id, bytes32 indexed kind, bytes data, uint64 executableAt);
    event ChangeCancelled(bytes32 indexed id);
    event ChangeExecuted(bytes32 indexed id, bytes32 indexed kind, bytes data);
    event GuardianChanged(address indexed previous, address indexed current);
    event OperatorSet(address indexed operator, bool allowed);
    event PublisherSet(address indexed publisher, bool allowed);
    event RouterSet(address indexed router, uint16 version);
    event ChargeCurrencySet(address indexed token, uint8 rank);
    event FeeRecipientSet(address indexed recipient);
    event ObservationEpochRaised(uint64 epoch);
    event AutomationHaltSet(bool halted);

    // ---------------------------------------------------------------- views
    function governance() external view returns (address);
    function pendingGovernance() external view returns (address);
    function guardian() external view returns (address);
    function timelockSeconds() external view returns (uint32);

    function isOperator(address account) external view returns (bool);
    function isPublisher(address account) external view returns (bool);
    /// @return version The admitted router version (e.g. 212 for 2.1.2); 0 when not admitted.
    function routerVersion(address router) external view returns (uint16 version);
    /// @return rank 1 for the first charge currency, 2 for the next; 0 when the token is not one.
    function chargeCurrencyRank(address token) external view returns (uint8 rank);
    function feeRecipient() external view returns (address);
    /// Observations with observedAt below this timestamp are void everywhere.
    function observationEpoch() external view returns (uint64);
    /// When true, operator executions stop on every vault; owner actions continue.
    function automationHalted() external view returns (bool);

    // ------------------------------------------------------- governance
    function transferGovernance(address pending) external;
    function acceptGovernance() external;
    /// @param kind One of DominoV2Types.REGISTRY_* kinds; data is its abi-encoded argument.
    function scheduleChange(bytes32 kind, bytes calldata data) external returns (bytes32 id);
    function executeChange(bytes32 id) external;
    function cancelChange(bytes32 id) external;

    // ---------------------------------------------- guardian, immediate
    function removeOperator(address operator) external;
    function removePublisher(address publisher) external;
    function removeRouter(address router) external;
    function raiseObservationEpoch(uint64 epoch) external;
    function haltAutomation() external;
}
