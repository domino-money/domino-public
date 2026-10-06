// Closed schema validation plus the crosschain-v1 rules the backend enforces: the route
// decision recomputed from the candidates, wallet steps that only reach the contracts
// pinned for that provider and origin chain, exact approvals for what the winner's deposit
// takes, and tracking states that only move forward. No fetch, wallet or signing.
// 1.1.0-rc.1 (6 Oct 2026): a quote asks by exact input or by output (the least that must
// arrive, with the most the wallet may send), each priced candidate says what its deposit
// takes (inputRaw), and the decision is the better rate (backend/crosschain_models.py).
import { SCHEMAS, ERRORS, CONSTANTS } from './schema-data.mjs';
import { createContractValidators } from '../shared/closed-schema.mjs';

export const CONTRACT_VERSION = '1.1.0-rc.1';
export const ROUTES = Object.freeze(Object.keys(SCHEMAS));
export const ERROR_STATUS_BY_CODE = Object.freeze({ ...ERRORS });

const ZERO = '0x' + '0'.repeat(40);
const PROVIDERS = ['relay', 'across'];
const PRICED = ['quoted', 'destination_gas_unsupported', 'input_above_max'];
const UINT128 = 1n << 128n;
const STATES = ['awaiting_deposit', 'pending', 'refund_pending', 'failed', 'refund_failed', 'filled', 'refunded'];
const TERMINAL = new Set(['filled', 'refunded']);
const NEXT = {
  awaiting_deposit: STATES,
  pending: STATES.filter((state) => state !== 'awaiting_deposit'),
  refund_pending: ['refund_pending', 'refunded'],
  failed: ['failed', 'refunded', 'refund_failed'],
  refund_failed: ['refund_failed', 'refunded'],
  filled: ['filled'],
  refunded: ['refunded'],
};
const RECOVERY = { refund_pending: 'automatic_refund', failed: 'automatic_refund', refunded: 'refunded', refund_failed: 'manual_recovery' };
const word = (hex) => hex.replace(/^0x/u, '').padStart(64, '0');
const approveData = (spender, amount) => '0x095ea7b3' + word(spender) + word(BigInt(amount).toString(16));
const offered = (chain, token) => (CONSTANTS.destinations[String(chain)] || []).includes(token.toLowerCase());
const pinned = (provider, chain) => (CONSTANTS.chains[String(chain)] || {})[provider] || null;

export function advance(previous, observed) {
  if (previous === null) return [observed, 'initial'];
  if (observed === previous) return [previous, 'unchanged'];
  if (NEXT[previous].includes(observed)) return [observed, 'advanced'];
  return [previous, 'held'];
}

function depositTarget(provider, chain, native) {
  const pin = pinned(provider, chain);
  if (!pin) return null;
  if (provider === 'relay') return pin.depository;
  return (native ? pin.spokePoolPeriphery : pin.spokePool) || null;
}

function approvalSpender(provider, chain) {
  const pin = pinned(provider, chain);
  if (!pin) return null;
  return provider === 'relay' ? pin.depository : pin.spokePool;
}

// Eligible candidates, best first: more output per unit sent (E_a·I_b against E_b·I_a, exactly), then the smaller
// input, then a shorter wait, then provider order. With equal inputs (exact input) the first key is more output.
function ranked(candidates) {
  return candidates.filter((c) => c.status === 'quoted').sort((a, b) => {
    const rate = BigInt(b.outputRaw) * BigInt(a.inputRaw) - BigInt(a.outputRaw) * BigInt(b.inputRaw);
    if (rate !== 0n) return rate > 0n ? 1 : -1;
    const input = BigInt(a.inputRaw) - BigInt(b.inputRaw);
    if (input !== 0n) return input > 0n ? 1 : -1;
    const eta = (a.etaSeconds ?? 1e9) - (b.etaSeconds ?? 1e9);
    return eta !== 0 ? eta : PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider);
  });
}

// The winner's margin over the other quoted candidate: the extra output it delivers for the other's input,
// floor(E_w·I_o / I_w) − E_o, and (E_w·I_o − E_o·I_w) · 10000 / (E_o·I_w) in whole bps; null without one.
function advantage(best) {
  if (best.length !== 2) return null;
  const [ew, iw, eo, io] = [best[0].outputRaw, best[0].inputRaw, best[1].outputRaw, best[1].inputRaw].map(BigInt);
  return { raw: (ew * io) / iw - eo, bps: ((ew * io - eo * iw) * 10000n) / (eo * iw) };
}

function quoteRequest(value) {
  return offered(value.destinationChainId, value.destinationToken) && value.originChainId !== value.destinationChainId &&
    !(value.destinationGas && value.destinationToken.toLowerCase() === ZERO) && BigInt(value.amountRaw) < UINT128 &&
    (value.maxInputRaw === null) === (value.amountKind === 'exact_input') &&
    (value.maxInputRaw === null || BigInt(value.maxInputRaw) < UINT128);
}

function candidate(value) {
  const priced = PRICED.includes(value.status);
  const fields = [value.inputRaw, value.outputRaw, value.minimumOutputRaw, value.appFee, value.originGas, value.refund, value.tracking];
  if (priced) {
    if (fields.some((field) => field === null) || BigInt(value.minimumOutputRaw) > BigInt(value.outputRaw)) return false;
    if ((value.provider === 'relay') !== (value.tracking.requestId !== null)) return false;
    if (value.status === 'quoted' && value.reason !== null) return false;
  } else if ([...fields, value.providerFee, value.destinationGas, value.etaSeconds].some((field) => field !== null) || value.reason === null) {
    return false;
  }
  if (value.provider === 'across' && value.destinationGas !== null) return false;
  return value.appFee === null || (value.appFee.charged === 'origin_input') === (value.provider === 'relay');
}

function step(value) {
  if ((value.kind === 'approval') !== (value.approval !== null)) return false;
  if (value.approval === null) return true;
  const { approval, transaction } = value;
  return transaction.to === approval.token && transaction.valueRaw === '0' &&
    transaction.data === approveData(approval.spender, approval.amountRaw);
}

function quotePlan(value) {
  const { request } = value;
  if (!(value.requestedAt <= value.retrievedAt && value.retrievedAt < value.expiresAt &&
        value.expiresAt === value.requestedAt + CONSTANTS.quoteLifetimeSeconds)) return false;
  if (value.candidates.map((c) => c.provider).join() !== PROVIDERS.join() || [ZERO, request.owner].includes(value.feeRecipient)) return false;
  const origin = request.originChainId, native = request.originToken === ZERO, output = request.amountKind === 'output';
  for (const c of value.candidates) {
    if (c.refund !== null && (c.refund.chainId !== origin || c.refund.recipient !== request.owner)) return false;
    if (c.appFee !== null && c.appFee.chainId !== (c.provider === 'relay' ? origin : request.destinationChainId)) return false;
    // Destination gas is judged before the cap: a candidate quoted above it served the gas asked for too.
    if (['quoted', 'input_above_max'].includes(c.status) && request.destinationGas && c.destinationGas === null) return false;
    if (c.destinationGas !== null && !request.destinationGas) return false;
    // Exact input: the deposit takes exactly the amount asked. By output: every price guarantees at least that amount.
    if (c.inputRaw !== null && (output ? BigInt(c.minimumOutputRaw) < BigInt(request.amountRaw) : c.inputRaw !== request.amountRaw)) return false;
    // By output, only a quote within what the wallet may send is eligible; one above it is input_above_max.
    if (['quoted', 'input_above_max'].includes(c.status) &&
        (c.status === 'input_above_max') !== (output && BigInt(c.inputRaw) > BigInt(request.maxInputRaw))) return false;
  }
  const best = ranked(value.candidates);
  const decision = best.length ? best[0].provider : null;
  const reason = !best.length ? 'no_quote' : best.length === 1 ? 'only_quote' : 'best_output';
  if (value.decision !== decision || value.reason !== reason) return false;
  const margin = advantage(best);
  if (value.comparison.advantageRaw !== (margin === null ? null : String(margin.raw))) return false;
  if (margin === null ? value.comparison.advantageBps !== null : BigInt(value.comparison.advantageBps ?? -1) !== margin.bps) return false;
  if (decision === null) return value.steps.length === 0;
  const kinds = value.steps.map((s) => s.kind).join();
  if (kinds !== (native ? 'deposit' : 'approval,deposit') || value.steps.some((s) => s.transaction.chainId !== origin)) return false;
  // The wallet sends what the winner's deposit takes.
  const sent = best[0].inputRaw;
  const deposit = value.steps.at(-1).transaction;
  if (deposit.to !== depositTarget(decision, origin, native) || deposit.valueRaw !== (native ? sent : '0')) return false;
  if (native) return true;
  const approval = value.steps[0].approval;
  return approval.token === request.originToken && approval.amountRaw === sent &&
    approval.spender === approvalSpender(decision, origin);
}

function originsList(value) {
  if (!offered(value.destinationChainId, value.destinationToken) || value.providers.map((p) => p.provider).join() !== PROVIDERS.join()) return false;
  const listed = new Set(value.providers.filter((p) => p.status === 'listed').map((p) => p.provider));
  const ids = value.chains.map((c) => c.chainId);
  if (ids.some((id, index) => index > 0 && id <= ids[index - 1]) || ids.includes(value.destinationChainId)) return false;
  return value.chains.every((chain) => (CONSTANTS.chains[String(chain.chainId)] || {}).name === chain.name &&
    chain.tokens.every((token) => token.providers.every((p) => listed.has(p) && pinned(p, chain.chainId))));
}

function feeMeasure(value) {
  const known = ['measured', 'not_collected'].includes(value.status);
  const filled = [value.amountRaw, value.chainId, value.token, value.evidence].map((field) => field !== null);
  if (filled.some((present) => present !== known)) return false;
  if (value.status === 'measured' && BigInt(value.amountRaw) === 0n) return false;
  if (value.status === 'not_collected' && value.amountRaw !== '0') return false;
  return !['pending', 'unavailable'].includes(value.status) || value.reason !== null;
}

function statusReport(value) {
  const { request } = value;
  const [state, transition] = advance(request.previousState, value.observedState);
  if (value.state !== state || value.transition !== transition || value.terminal !== TERMINAL.has(value.state)) return false;
  if (value.nextCheckSeconds !== (CONSTANTS.pollSeconds[request.provider][value.state] ?? null)) return false;
  if ((value.providerStatus === null) !== (request.provider === 'across' && value.observedState === 'awaiting_deposit')) return false;
  if (value.fillTxHash !== null && value.state !== 'filled') return false;
  if (['measured', 'not_collected'].includes(value.fee.status) && value.state !== 'filled') return false;
  const recovery = RECOVERY[value.state] ?? null;
  if ((value.recovery === null) !== (recovery === null)) return false;
  return value.recovery === null || (value.recovery.kind === recovery && value.recovery.chainId === request.originChainId &&
    value.recovery.recipient === request.owner);
}

function semantic(name, value) {
  if (name === 'OriginsRequest') return offered(value.destinationChainId, value.destinationToken);
  if (['QuoteRequest', 'QuoteIdentity'].includes(name)) return quoteRequest(value);
  if (['StatusRequest', 'StatusIdentity'].includes(name)) return value.originChainId !== value.destinationChainId &&
    (value.provider === 'relay') === (value.requestId !== null);
  if (name === 'Candidate') return candidate(value);
  if (name === 'Step') return step(value);
  if (name === 'QuotePlan') return quotePlan(value);
  if (name === 'OriginToken') return value.providers.join() === PROVIDERS.filter((p) => value.providers.includes(p)).join();
  if (name === 'OriginChain') return value.tokens.every((token, index) => index === 0 || token.address > value.tokens[index - 1].address);
  if (name === 'ProviderListing') return (value.status === 'listed') === (value.reason === null);
  if (name === 'OriginsList') return originsList(value);
  if (name === 'FeeMeasure') return feeMeasure(value);
  if (name === 'StatusReport') return statusReport(value);
  return true;
}

export const { validateRequest, validateResponse, validateError } =
  createContractValidators(SCHEMAS, ERROR_STATUS_BY_CODE, semantic);
