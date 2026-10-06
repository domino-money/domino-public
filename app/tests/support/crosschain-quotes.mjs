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
 * Changed on purpose 2026-10-06 (rugged's delta of 6 Oct §3, crosschain-v1 1.1.0-rc.1): a request by output (`amountKind:
 * 'output'`) is answered from the package's quote.output variants (quote.output-native for the origin's own currency to
 * the destination's): every amount scaled by what must arrive, each deposit's input rounded up (so every minimum still
 * covers the need), a candidate above `maxInputRaw` `input_above_max`; with destination gas, Relay's top-up as the
 * destination-gas variant delivers it and Across `destination_gas_unsupported`. The winner is the better rate, as the
 * runtime decides it, and the wallet steps carry the winner's `inputRaw`.
 */
import { readFileSync } from 'node:fs';
import { CONSTANTS } from '../../../api-contracts/crosschain-v1/schema-data.mjs';
import * as runtime from '../../../api-contracts/crosschain-v1/runtime.mjs';

const PACKAGE = new URL('../../../api-contracts/crosschain-v1/fixtures/', import.meta.url);
const FIXTURE_OWNER = '0x1111111111111111111111111111111111111111';
const ZERO = '0x0000000000000000000000000000000000000000';
const PROVIDERS = ['relay', 'across'];
const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');

/** The recorded answer `name` ('responses/quote', 'variants/quote.destination-gas', 'variants/quote.none'), about `owner`. */
export const recorded = (name, owner) => JSON.parse(readFileSync(new URL(`${name}.json`, PACKAGE), 'utf8').replaceAll(FIXTURE_OWNER, owner));

/** Across with no route (the package's own quote.none candidate). */
const NO_ROUTE = Object.freeze({ appFee: null, destinationGas: null, etaSeconds: null, inputRaw: null, minimumOutputRaw: null, originGas: null, outputRaw: null, provider: 'across', providerFee: null, reason: 'provider_no_route', refund: null, status: 'no_route', tracking: null });

/** The quote.output variant a request by output is answered from, for the exact-input `name` the suite asked. */
function outputName(body, name) {
  if (name === 'variants/quote.none') return name;
  return body.originToken === ZERO && body.destinationToken === ZERO ? 'variants/quote.output-native' : 'variants/quote.output';
}

/** Eligible candidates, best first, as runtime.mjs ranks them: the better rate, the smaller input, the shorter wait, Relay. */
function ranked(candidates) {
  return candidates.filter((c) => c.status === 'quoted').sort((a, b) => {
    const rate = BigInt(b.outputRaw) * BigInt(a.inputRaw) - BigInt(a.outputRaw) * BigInt(b.inputRaw);
    if (rate !== 0n) return rate > 0n ? 1 : -1;
    const input = BigInt(a.inputRaw) - BigInt(b.inputRaw);
    if (input !== 0n) return input > 0n ? 1 : -1;
    return (a.etaSeconds ?? 1e9) - (b.etaSeconds ?? 1e9) || PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider);
  });
}

/** The answer to `body` (the request the page sent) for `owner`, from the recorded answer `name`. Throws if it would not validate. */
export function quoteFor(body, owner, name = 'responses/quote', { rate = null, relayOnly = false } = {}) {
  const output = body.amountKind === 'output';
  // With destination gas by output, Relay adds its top-up's cost to what is sent (the destination-gas variant's provider fee
  // over the base answer's, in the origin's units as recorded), and delivers the gas that variant does.
  const gasRelay = output && name === 'variants/quote.destination-gas' ? recorded(name, owner).quote.candidates.find((c) => c.provider === 'relay') : null;
  const gas = gasRelay?.destinationGas ?? null;
  const topUp = gasRelay ? BigInt(gasRelay.providerFee.amountRaw) - BigInt(recorded('responses/quote', owner).quote.candidates.find((c) => c.provider === 'relay').providerFee.amountRaw) : 0n;
  const data = recorded(output ? outputName(body, name) : name, owner);
  const q = data.quote;
  const base = BigInt(q.request.amountRaw);
  const amount = BigInt(body.amountRaw);
  const origin = body.originChainId;
  const native = body.originToken === ZERO;
  q.request = { ...body, owner };
  if (relayOnly) q.candidates = q.candidates.map((c) => (c.provider === 'across' ? { ...NO_ROUTE } : c));
  if (output) {
    // By output: `amount` must arrive. What arrives scales with it; what is sent too, turned into the origin's units by
    // `rate` and rounded up, so each minimum still covers the need.
    const [num, den] = rate ? [rate.num, rate.den] : [1n, 1n];
    const arrives = (raw) => (raw === null ? null : String((BigInt(raw) * amount) / base));
    const sends = (raw) => (raw === null ? null : String((BigInt(raw) * amount * den + base * num - 1n) / (base * num)));
    for (const c of q.candidates) {
      c.inputRaw = sends(c.inputRaw);
      c.outputRaw = arrives(c.outputRaw);
      c.minimumOutputRaw = arrives(c.minimumOutputRaw);
      if (c.appFee) {
        c.appFee.amountRaw = c.appFee.charged === 'destination_output' ? arrives(c.appFee.amountRaw) : sends(c.appFee.amountRaw);
        if (c.provider === 'relay') Object.assign(c.appFee, { chainId: origin, token: body.originToken });
      }
      if (c.providerFee) Object.assign(c.providerFee, { amountRaw: sends(c.providerFee.amountRaw), chainId: origin, token: body.originToken });
      if (c.refund) c.refund = { chainId: origin, recipient: owner };
      if (c.inputRaw === null) continue;
      // Destination gas first: only Relay's top-up delivers it; then the cap.
      if (body.destinationGas && c.provider === 'across') Object.assign(c, { status: 'destination_gas_unsupported', reason: 'destination_gas_unsupported', destinationGas: null });
      else {
        if (body.destinationGas) {
          c.destinationGas = gas;
          c.inputRaw = String(BigInt(c.inputRaw) + topUp);
          c.providerFee.amountRaw = String(BigInt(c.providerFee.amountRaw) + topUp);
        }
        const above = BigInt(c.inputRaw) > BigInt(body.maxInputRaw);
        Object.assign(c, above ? { status: 'input_above_max', reason: 'input_above_max' } : { status: 'quoted', reason: null });
      }
    }
  } else {
    const scale = (raw) => (raw === null ? null : String((BigInt(raw) * amount) / base));
    // What arrives, in the destination token's units.
    const arrives = (raw) => (raw === null ? null : rate ? String((BigInt(raw) * amount * rate.num) / (base * rate.den)) : scale(raw));
    for (const c of q.candidates) {
      // Changed on purpose (data) 2026-10-06 (crosschain-v1 1.1.0-rc.1): what each deposit takes, the amount asked.
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
  }
  const best = ranked(q.candidates);
  q.decision = best[0]?.provider ?? null;
  q.reason = best.length === 0 ? 'no_quote' : best.length === 1 ? 'only_quote' : 'best_output';
  if (best.length === 2) {
    // The winner's extra output for the other's input (runtime.mjs advantage).
    const [ew, iw, eo, io] = [best[0].outputRaw, best[0].inputRaw, best[1].outputRaw, best[1].inputRaw].map(BigInt);
    q.comparison = { ...q.comparison, advantageRaw: String((ew * io) / iw - eo), advantageBps: Number(((ew * io - eo * iw) * 10000n) / (eo * iw)) };
  } else q.comparison = { ...q.comparison, advantageRaw: null, advantageBps: null };
  if (q.decision === null) q.steps = [];
  else {
    // The wallet sends what the winner's deposit takes.
    const sent = BigInt(best[0].inputRaw);
    const pins = CONSTANTS.chains[String(origin)][q.decision];
    const target = q.decision === 'relay' ? pins.depository : native ? pins.spokePoolPeriphery : pins.spokePool;
    const spender = q.decision === 'relay' ? pins.depository : pins.spokePool;
    const deposit = { approval: null, kind: 'deposit', transaction: { chainId: origin, data: q.steps.at(-1).transaction.data, to: target, valueRaw: native ? String(sent) : '0' } };
    q.steps = native
      ? [deposit]
      : [
          {
            approval: { amountRaw: String(sent), spender, token: body.originToken },
            kind: 'approval',
            transaction: { chainId: origin, data: `0x095ea7b3${word(spender)}${word(sent.toString(16))}`, to: body.originToken, valueRaw: '0' },
          },
          deposit,
        ];
  }
  q.requestedAt = q.retrievedAt = Math.floor(Date.now() / 1000);
  q.expiresAt = q.requestedAt + CONSTANTS.quoteLifetimeSeconds;
  if (!runtime.validateResponse('quote', data)) throw new Error(`the test's quote for ${JSON.stringify(body)} breaks the contract`);
  return data;
}
