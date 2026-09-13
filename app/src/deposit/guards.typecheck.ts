/**
 * Compile-only checks, run by the app's own `tsc --noEmit`, mirroring the four
 * cases of deposit-v1's consumer.typecheck.mts through the app's alias.
 */
import type { AllowancesResponse, CreateRequest, ReportRequest } from 'api-contracts/deposit-v1/types'

declare const create: CreateRequest
declare const report: ReportRequest
declare const allowances: AllowancesResponse

function mutations() {
  // @ts-expect-error The owner comes from the session, never from the browser.
  create.owner = '0x0000000000000000000000000000000000000001'
  // @ts-expect-error Budgets are exact integer strings, never numbers.
  create.selection.budget0Raw = 1000
  // @ts-expect-error A browser cannot claim a receipt's outcome.
  report.success = true
  // @ts-expect-error A read cannot say an approval was revoked.
  allowances.allowances.revoked = true
}

void mutations
