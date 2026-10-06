/**
 * TEST-ONLY. crosschain-v1 quote answers for whatever a browser suite's page asks (Added 2026-10-06: the bring-funds
 * offer now sizes what it brings from the service's own quotes, so it asks for amounts no fixture was recorded for).
 * Built from the package's own recorded answer (fixtures/responses/quote.json, or a variant): the request echoed with the
 * owner; every amount scaled by the amount asked; the refund, Relay's fee and the provider's fee on the origin asked; the
 * winner, the comparison and the times worked out again; the exact approval for the amount (or, for the origin's own
 * currency, the one deposit carrying it), to the pinned contracts. Every answer passes the package's validator before it
 * is served, so a suite never draws what the contract refuses. Nothing here is a price: the scale is the fixture's.
 * Changed on purpose 2026-10-06 (the review: a bring of another kind of token, ETH for USDG): `rate` ({ num, den }) turns
 * the amount sent into the destination token's units (what arrives, its minimum and a fee taken from what arrives), and
 * `relayOnly` has Across answer no route, as it does for anything but a plain bridge of one token.
 */
import { readFileSync } from 'node:fs';
import { CONSTANTS } from '../../../api-contracts/crosschain-v1/schema-data.mjs';
import * as runtime from '../../../api-contracts/crosschain-v1/runtime.mjs';

const PACKAGE = new URL('../../../api-contracts/crosschain-v1/fixtures/', import.meta.url);
const FIXTURE_OWNER = '0x1111111111111111111111111111111111111111';
const ZERO = '0x0000000000000000000000000000000000000000';
const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');

/** The recorded answer `name` ('responses/quote', 'variants/quote.destination-gas', 'variants/quote.none'), about `owner`. */
export const recorded = (name, owner) => JSON.parse(readFileSync(new URL(`${name}.json`, PACKAGE), 'utf8').replaceAll(FIXTURE_OWNER, owner));

/** Across with no route (the package's own quote.none candidate). */
const NO_ROUTE = Object.freeze({ appFee: null, destinationGas: null, etaSeconds: null, inputRaw: null, minimumOutputRaw: null, originGas: null, outputRaw: null, provider: 'across', providerFee: null, reason: 'provider_no_route', refund: null, status: 'no_route', tracking: null });

/** The answer to `body` (the request the page sent) for `owner`, from the recorded answer `name`. Throws if it would not validate. */
export function quoteFor(body, owner, name = 'responses/quote', { rate = null, relayOnly = false } = {}) {
  const data = recorded(name, owner);
  const q = data.quote;
  const base = BigInt(q.request.amountRaw);
  const amount = BigInt(body.amountRaw);
  const scale = (raw) => (raw === null ? null : String((BigInt(raw) * amount) / base));
  // What arrives, in the destination token's units.
  const arrives = (raw) => (raw === null ? null : rate ? String((BigInt(raw) * amount * rate.num) / (base * rate.den)) : scale(raw));
  const origin = body.originChainId;
  const native = body.originToken === ZERO;
  q.request = { ...body, owner };
  if (relayOnly) q.candidates = q.candidates.map((c) => (c.provider === 'across' ? { ...NO_ROUTE } : c));
  for (const c of q.candidates) {
    // Changed on purpose (data) 2026-10-06 (crosschain-v1 1.1.0-rc.1): what each deposit takes, the amount asked (the
    // page asks by exact input).
    c.inputRaw = scale(c.inputRaw);
    c.outputRaw = arrives(c.outputRaw);
    c.minimumOutputRaw = arrives(c.minimumOutputRaw);
    if (c.appFee) {
      c.appFee.amountRaw = c.appFee.charged === 'destination_output' ? arrives(c.appFee.amountRaw) : scale(c.appFee.amountRaw);
      if (c.provider === 'relay') Object.assign(c.appFee, { chainId: origin, token: body.originToken });
    }
    if (c.providerFee) Object.assign(c.providerFee, { amountRaw: scale(c.providerFee.amountRaw), chainId: origin, token: body.originToken });
    if (c.refund) c.refund = { chainId: origin, recipient: owner };
  }
  const best = q.candidates.filter((c) => c.status === 'quoted').sort((a, b) => {
    const out = BigInt(b.outputRaw) - BigInt(a.outputRaw);
    if (out !== 0n) return out > 0n ? 1 : -1;
    return (a.etaSeconds ?? 1e9) - (b.etaSeconds ?? 1e9) || ['relay', 'across'].indexOf(a.provider) - ['relay', 'across'].indexOf(b.provider);
  });
  q.decision = best[0]?.provider ?? null;
  q.reason = best.length === 0 ? 'no_quote' : best.length === 1 ? 'only_quote' : 'best_output';
  if (best.length === 2) {
    const advantage = BigInt(best[0].outputRaw) - BigInt(best[1].outputRaw);
    q.comparison = { ...q.comparison, advantageRaw: String(advantage), advantageBps: Number((advantage * 10000n) / BigInt(best[1].outputRaw)) };
  } else q.comparison = { ...q.comparison, advantageRaw: null, advantageBps: null };
  if (q.decision === null) q.steps = [];
  else {
    const pins = CONSTANTS.chains[String(origin)][q.decision];
    const target = q.decision === 'relay' ? pins.depository : native ? pins.spokePoolPeriphery : pins.spokePool;
    const spender = q.decision === 'relay' ? pins.depository : pins.spokePool;
    const deposit = { approval: null, kind: 'deposit', transaction: { chainId: origin, data: q.steps.at(-1).transaction.data, to: target, valueRaw: native ? body.amountRaw : '0' } };
    q.steps = native
      ? [deposit]
      : [
          {
            approval: { amountRaw: body.amountRaw, spender, token: body.originToken },
            kind: 'approval',
            transaction: { chainId: origin, data: `0x095ea7b3${word(spender)}${word(amount.toString(16))}`, to: body.originToken, valueRaw: '0' },
          },
          deposit,
        ];
  }
  q.requestedAt = q.retrievedAt = Math.floor(Date.now() / 1000);
  q.expiresAt = q.requestedAt + CONSTANTS.quoteLifetimeSeconds;
  if (!runtime.validateResponse('quote', data)) throw new Error(`the test's quote for ${JSON.stringify(body)} breaks the contract`);
  return data;
}
