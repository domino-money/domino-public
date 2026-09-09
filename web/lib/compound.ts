/** USD scenario accounting only. No token authorization or calldata. */
export const MICRO = 1_000_000n;
export const SERVICE_BPS = 200n;
export function moneyUnits(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,9}(\.\d{1,6})?$/.test(value))
    throw new Error(
      'Use a non-negative dollar amount with up to six decimal places.',
    );
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0'));
}
export function moneyString(value: bigint): string {
  return `${value / MICRO}.${(value % MICRO).toString().padStart(6, '0')}`;
}
export interface CompoundInput {
  availableFeesUsd: string;
  positionValueUsd: string;
  gasUsd: string;
}
interface CompoundAmounts {
  mode: 'simulation';
  decision: 'eligible' | 'wait';
  reason: 'ready' | 'no_fees' | 'gas_too_high';
  availableFeesUsd: string;
  consumedFeesUsd: string;
  serviceFeeUsd: string;
  reinvestedUsd: string;
  reserveUsd: string;
  gasUsd: string;
  operatorMarginUsd: string;
  minimumFeesUsd: string;
}
export interface CurrentCompoundDecision extends CompoundAmounts {
  policyVersion: 2;
  reserveReason: 'none' | 'network_cost';
}
/** Preserve historical receipts under the policy that produced them. */
export interface LegacyCompoundDecision extends CompoundAmounts {
  policyVersion?: 1;
  maxNetAdditionUsd: string;
}
export type CompoundDecision = CurrentCompoundDecision | LegacyCompoundDecision;

export function pendingFeesExplanation(d: CompoundDecision): string {
  if (moneyUnits(d.reserveUsd) === 0n)
    return 'No fees are waiting to be reinvested.';
  if (d.decision === 'wait')
    return 'Waiting for the service cut to cover network cost and its buffer. Recheck when fees or gas change.';
  return 'Historical scenario: the former 15% addition limit left these fees waiting. They are available under the new policy.';
}

export function previewCompound(input: CompoundInput): CurrentCompoundDecision {
  const available = moneyUnits(input.availableFeesUsd),
    capital = moneyUnits(input.positionValueUsd),
    gas = moneyUnits(input.gasUsd);
  if (
    capital < 10n * MICRO ||
    capital > 1_000_000n * MICRO ||
    available > 1_000_000n * MICRO ||
    gas > 1000n * MICRO
  )
    throw new Error('The scenario is outside the supported amount limits.');
  // The balanced-fee scenario uses all available fees. Token spending authority
  // in a real vault must be bounded by proven fee balances and execution limits.
  const planned = available,
    plannedCut = (planned * SERVICE_BPS) / 10_000n;
  const requiredCut = (gas * 115n + 99n) / 100n;
  const minimum = (requiredCut * 10_000n + SERVICE_BPS - 1n) / SERVICE_BPS;
  const ready = planned > 0n && plannedCut >= requiredCut;
  const consumed = ready ? planned : 0n,
    cut = ready ? plannedCut : 0n;
  return {
    mode: 'simulation',
    policyVersion: 2,
    decision: ready ? 'eligible' : 'wait',
    reason: ready ? 'ready' : available === 0n ? 'no_fees' : 'gas_too_high',
    availableFeesUsd: moneyString(available),
    consumedFeesUsd: moneyString(consumed),
    serviceFeeUsd: moneyString(cut),
    reinvestedUsd: moneyString(consumed - cut),
    reserveUsd: moneyString(available - consumed),
    reserveReason: !ready && available > 0n ? 'network_cost' : 'none',
    gasUsd: moneyString(gas),
    operatorMarginUsd: moneyString(ready ? cut - gas : 0n),
    minimumFeesUsd: moneyString(minimum),
  };
}
