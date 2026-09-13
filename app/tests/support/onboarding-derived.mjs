/**
 * The onboarding previews the package does not ship (FIX-1): ten small edits
 * of package fixtures, eight swaps and two positions. They are shared by
 * tests/onboarding.project.test.mjs, which projects them in node, and by
 * support/fake-onboarding.mjs, which serves them to Chromium. Each must still
 * pass the pinned runtime, and both users check that it does.
 *
 * Passing the runtime is not producer acceptance: rugged97 (#38) found
 * multi_hop and multi_path failing the Python producer model (route pool ids
 * that were not the keccak of their PoolKeys) and native_blocked_twice
 * carrying the fingerprint of the request it was edited from. Pool ids and
 * fingerprints are now computed the producer's way (poolIdOf, fingerprintOf);
 * tests/consumer.fixtures.test.mjs checks them in check:app, and
 * `npm run check:producer-fixtures` runs every preview through the Python
 * model. rugged97 accepted the other seven as synthetic producer-shaped
 * display cases; none qualifies a live provider response.
 *
 * A swap edit takes the preview for a 1000-unit SYN-A to SYN-B request at 50
 * bps slippage (the package's swap request, and the form's default), and the
 * signed-in owner. A position edit names the package fixture it starts from;
 * an edit of the request is the request the form must send to receive it.
 */
import { createHash } from 'node:crypto';
import { encodeAbiParameters, keccak256 } from 'viem';

export const FEE_RECIPIENT = '0x9999999999999999999999999999999999999999';
export const SYN_A = '0x1111111111111111111111111111111111111111';
export const SYN_B = '0x2222222222222222222222222222222222222222';
export const SYN_C = '0x3333333333333333333333333333333333333333';

/** A v4 pool id: keccak256 of the ABI-encoded PoolKey, as the producer's PoolKey.checked recomputes it (backend/discovery.py). */
export const poolIdOf = ({ currency0, currency1, fee_pips, tick_spacing, hooks }) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [currency0, currency1, fee_pips, tick_spacing, hooks]));

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;

/**
 * A preview's requestFingerprint as the producer computes it: the SHA-256 of
 * its request identity as compact JSON with sorted keys (backend/uniswap_quote.py
 * and uniswap_position.py: json.dumps(identity, sort_keys=True, separators=(',', ':'))).
 */
export const fingerprintOf = (request) => createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex');

/** One route hop between two tokens, with the pool id of its PoolKey. */
export const hop = (tokenIn, tokenOut, amountInRaw, amountOutRaw, fee = 3000) => {
  const [currency0, currency1] = [tokenIn, tokenOut].sort();
  const poolKey = { currency0, currency1, fee_pips: fee, hooks: '0x0000000000000000000000000000000000000000', tick_spacing: 60 };
  return {
    amountInRaw,
    amountOutRaw,
    poolId: poolIdOf(poolKey),
    poolKey,
    tokenIn: { address: tokenIn, decimals: 18 },
    tokenOut: { address: tokenOut, decimals: 18 },
  };
};

export const DERIVED_SWAPS = Object.freeze({
  unsupported_nonzero_fee: {
    label: 'unsupported non-zero fee with itemised outputs',
    mutate(p, { owner }) {
      p.providerOutputFee = {
        aggregatedOutputs: [
          { amountRaw: '5', bps: '25', kind: 'INTEGRATOR', minimumAmountRaw: '5', recipient: FEE_RECIPIENT },
          { amountRaw: '1995', bps: null, kind: null, minimumAmountRaw: '1985', recipient: owner },
        ],
        amountRaw: '5',
        basis: 'output_currency',
        bps: '25',
        currency: SYN_B,
        recipient: FEE_RECIPIENT,
        status: 'unsupported_nonzero',
        zeroEvidence: null,
      };
      p.quote.outputAfterProviderFeeRaw = null;
      p.quote.minimumAfterProviderFeeRaw = null;
      p.previewChecks = { reasons: ['provider_output_fee_unsupported_nonzero'], status: 'blocked' };
    },
  },
  provider_failure: {
    label: 'provider failure',
    mutate(p) {
      p.simulation = { failureCodes: ['SIMULATION_ERROR'], independentSuccessProven: false, status: 'provider_reported_failure' };
      p.previewChecks = { reasons: ['provider_simulation_failed'], status: 'blocked' };
    },
  },
  impact_exceeded: {
    label: 'impact exceeded',
    mutate(p) {
      p.quote.priceImpactPercent = '1.5';
      p.previewChecks = { reasons: ['price_impact_exceeded'], status: 'blocked' };
    },
  },
  approval_unknown: {
    label: 'approval unknown',
    mutate(p) {
      p.approvalApplicable = null;
    },
  },
  usd_null: {
    label: 'usd-only null',
    mutate(p) {
      p.gas.usd = null;
    },
  },
  decimals_null: {
    label: 'decimals null',
    mutate(p) {
      p.quote.routes[0][0].tokenIn.decimals = null;
      p.quote.routes[0][0].tokenOut.decimals = null;
    },
  },
  multi_hop: {
    label: 'multi-hop',
    mutate(p) {
      p.quote.routes = [[hop(SYN_A, SYN_C, '1000', null), hop(SYN_C, SYN_B, null, '2000')]];
    },
  },
  multi_path: {
    label: 'multi-path 2x1',
    mutate(p) {
      p.quote.routes = [[hop(SYN_A, SYN_B, '500', '1000')], [hop(SYN_A, SYN_B, '500', '1000', 500)]];
    },
  },
});

export const DERIVED_POSITIONS = Object.freeze({
  native_blocked_twice: {
    label: 'native blocked twice',
    base: 'variants/position-preview.native.json',
    mutate(p) {
      p.request.nativeBalanceRaw = '100';
      p.nativeFunding.reportedBalanceRaw = '100';
      p.previewChecks = { reasons: ['native_deposit_exceeds_balance', 'native_gas_reserve_exceeded'], status: 'blocked' };
      // A new request is a new identity: its own fingerprint.
      p.requestFingerprint = fingerprintOf(p.request);
    },
  },
  gas_reported: {
    label: 'gas reported',
    base: 'responses/position-preview.json',
    mutate(p) {
      p.gas = { feeWei: '1000000', fullNetworkCostVerified: false, source: 'provider_estimate' };
    },
  },
});
