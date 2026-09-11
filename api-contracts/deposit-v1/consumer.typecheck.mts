import type {CreateRequest, PrepareResponse, ReportRequest} from './types.js';
import {validateResponse, validateWalletStep} from './runtime.mjs';
declare const raw: unknown;
if (validateResponse('prepare', raw) && raw.walletStep) {
  const result: PrepareResponse = raw;
  validateWalletStep(result.operation.selection, result.operation.owner, raw.walletStep);
  const nonce: bigint = BigInt(raw.walletStep.transaction.nonceRaw);
  void nonce;
}
declare const create: CreateRequest;
// @ts-expect-error: owner must come from the session.
create.owner = '0x0000000000000000000000000000000000000001';
// @ts-expect-error: amounts must remain exact integer strings.
create.selection.budget0Raw = 1000;
declare const report: ReportRequest;
// @ts-expect-error: a browser receipt claim is not accepted.
report.success = true;
if (validateResponse('allowances', raw)) {
  for (const observation of raw.allowances.observations) {
    const residual: bigint | null = observation.erc20AllowanceRaw === null ? null : BigInt(observation.erc20AllowanceRaw);
    void residual;
  }
  // @ts-expect-error: a read cannot assert that a wallet revoked an approval.
  raw.allowances.revoked = true;
}
