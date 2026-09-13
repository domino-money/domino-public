/**
 * The deposit consumer's vocabulary (#40/#44). Shapes are rugged97's
 * generated deposit-v1 types, imported in place.
 */
import type {
  AllowanceObservation,
  AllowanceReport,
  DepositErrorCode,
  DepositRequests,
  DepositResponses,
  DepositRoute,
  DepositSelection,
  Operation,
  OperationListItem,
  PreparedArtifact,
  ReceiptPosition,
  ReceiptSummary,
  StepSummary,
} from 'api-contracts/deposit-v1/types'

export type {
  AllowanceObservation,
  AllowanceReport,
  DepositErrorCode,
  DepositRequests,
  DepositResponses,
  DepositRoute,
  DepositSelection,
  Operation,
  OperationListItem,
  PreparedArtifact,
  ReceiptPosition,
  ReceiptSummary,
  StepSummary,
}

export type OperationState = Operation['state']
export type StepKind = StepSummary['kind']
export type AmountBasis = ReceiptPosition['amount0Basis']

/** The package runtime, satisfied structurally; deposit/contract.ts wires the real one. */
export interface DepositValidators {
  readonly CONTRACT_VERSION: string
  readonly ERROR_STATUS_BY_CODE: Readonly<Record<DepositErrorCode, number>>
  validateRequest<R extends DepositRoute>(route: R, value: unknown): value is DepositRequests[R]
  validateResponse<R extends DepositRoute>(route: R, value: unknown): value is DepositResponses[R]
  validateError(status: number, value: unknown): value is { error: DepositErrorCode }
  validateWalletStep(selection: DepositSelection, owner: string, artifact: PreparedArtifact): boolean
}
