/**
 * Every derived onboarding-v1 and deposit-v1 fixture this app serves, in one
 * place, for the two checks that hold them to the producer (rugged97 on #38,
 * #40 and #72):
 *
 *   tests/consumer.fixtures.test.mjs     node, in check:app and so in CI: the
 *                                        package runtimes plus the producer
 *                                        rules the runtimes do not check;
 *   scripts/check-producer-fixtures.mjs  by hand, not in CI: the same bodies
 *                                        through the Python producer model.
 *
 * Deposit bodies are collected from the lab itself: every scenario scripts a
 * recorder instead of a transport, so no body the lab serves can miss the
 * check. A string reply is a package fixture's raw text, the producer's own
 * output, and an error reply carries no operation, so both are left out; so
 * are the owner-binding controls, which are another owner's on purpose.
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONTRACTS, build, depositSource, fixture } from './consumer-fakes.mjs';
import { DERIVED_POSITIONS, DERIVED_SWAPS } from './onboarding-derived.mjs';

/** Scenarios whose answers are another owner's on purpose: the client refuses them whole. */
export const OWNER_CONTROLS = Object.freeze(['foreign-get', 'foreign-list']);

/** The ten derived previews, as tests/onboarding.project.test.mjs builds them. */
export function onboardingCorpus() {
  const out = [];
  for (const [name, { mutate }] of Object.entries(DERIVED_SWAPS)) {
    const body = fixture('onboarding-v1', 'responses/swap-preview.json');
    mutate(body.preview, { owner: body.preview.request.owner });
    out.push({ id: `swap:${name}`, route: 'swap-preview', body });
  }
  for (const [name, { base, mutate }] of Object.entries(DERIVED_POSITIONS)) {
    const body = fixture('onboarding-v1', base);
    mutate(body.preview);
    out.push({ id: `position:${name}`, route: 'position-preview', body });
  }
  return out;
}

/** The package's own preview answers: the replicas of the producer's pool id and fingerprint must reproduce each. */
export function onboardingPackageResponses() {
  const dir = resolve(CONTRACTS, 'onboarding-v1/fixtures');
  return ['responses', 'variants']
    .flatMap((sub) => readdirSync(resolve(dir, sub)).map((name) => `${sub}/${name}`))
    .filter((path) => /\/(swap|position)-preview[^/]*\.json$/.test(path))
    .map((path) => ({ id: path, route: path.includes('swap-preview') ? 'swap-preview' : 'position-preview', body: fixture('onboarding-v1', path) }));
}

/** Every derived deposit fixture, and every JSON body a lab scenario answers with, by route. */
export function depositCorpus() {
  const { scenarios } = build('deposit/fixtures/scenarios');
  const { DERIVED } = build('deposit/fixtures/derive');
  const out = [];
  for (const [name, entry] of Object.entries(DERIVED)) out.push({ id: `derived:${name}`, route: 'get', body: entry.build(depositSource) });
  for (const scenario of scenarios(depositSource)) {
    if (OWNER_CONTROLS.includes(scenario.id)) continue;
    let n = 0;
    scenario.script({
      script(route, ...replies) {
        for (const reply of replies) {
          n += 1;
          if (reply.status === 200 && typeof reply.body !== 'string') out.push({ id: `${scenario.id}#${n}:${route}`, route, body: JSON.parse(JSON.stringify(reply.body)) });
        }
      },
    });
  }
  return out;
}

/**
 * What the deposit producer never answers, beyond what the deposit-v1
 * runtime checks. Transcribed from the producer; scripts/producer_fixtures.py
 * holds the same rules next to the Python model:
 *
 *   backend/deposit_receipt.py (ReceiptReconciler.reconcile): a reorged
 *     outcome has no receipt; confirmed and reverted come only from a
 *     finalized receipt with that status (anything not finalized is pending).
 *   backend/deposit_service.py (_operation): a step's wire receipt is its
 *     latest observation's, so a reorged step shows none.
 *   backend/deposit_store.py (cancel, reconcile): cancel_requested only from
 *     an operation with an issued step; attention or cancel_requested with
 *     outstanding false only beside another outstanding operation (the newer
 *     reservation); confirmed only after a mint step; reverted only after a
 *     reverted one.
 */
export function depositRuleViolations(route, body) {
  const operations = route === 'list' ? body.operations.map((item) => ({ ...item, history: item.lastStep ? [item.lastStep] : [] })) : [body.operation];
  const problems = [];
  for (const op of operations) {
    for (const step of op.history) {
      const at = `${op.id} step ${step.step}`;
      const receipt = step.receipt;
      if (step.reconciliationState === 'reorged' && receipt !== null) problems.push(`${at}: a reorged observation carries no receipt`);
      if (step.reconciliationState === 'confirmed' && !(receipt && receipt.finality === 'finalized' && receipt.outcome === 'success')) {
        problems.push(`${at}: confirmed only on a finalized, successful receipt`);
      }
      if (step.reconciliationState === 'reverted' && !(receipt && receipt.finality === 'finalized' && receipt.outcome === 'reverted')) {
        problems.push(`${at}: reverted only on a finalized, reverted receipt`);
      }
    }
    const last = op.history.at(-1);
    if (op.state === 'confirmed' && !(last && last.kind === 'mint' && last.reconciliationState === 'confirmed')) problems.push(`${op.id}: confirmed only after a confirmed mint step`);
    if (op.state === 'reverted' && !(last && last.reconciliationState === 'reverted')) problems.push(`${op.id}: reverted only after a reverted step`);
    if (op.state === 'cancel_requested' && op.history.length === 0) problems.push(`${op.id}: only an operation with an issued step is cancel_requested`);
    if ((op.state === 'attention' || op.state === 'cancel_requested') && !op.outstanding && !operations.some((other) => other !== op && other.outstanding)) {
      problems.push(`${op.id}: ${op.state} with outstanding false needs the newer reservation beside it`);
    }
  }
  return problems;
}
