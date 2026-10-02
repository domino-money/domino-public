/**
 * finance.browser.test.mjs in parts (audit H2, 2026-10-01). As one file it ran
 * about 19 of its CI job's 25 minutes and had doubled in six days; CI now runs
 * it as parts, each in a job of its own, side by side.
 *
 * In the suite, `part('name')` before a stretch of tests names the part those
 * tests belong to, until the next `part(...)`; a test added inside a stretch
 * joins its part. Each part has an entry file,
 * tests/finance-<name>.browser.test.mjs, which runs only that part:
 *
 *   await runPart('create', () => import('./finance.browser.test.mjs'))
 *
 * Run on its own, the suite registers every test, as it always did.
 * scripts/check-app-jobs.test.mjs holds every part to an entry file that
 * check:app and a CI job run.
 *
 * Also (audit H3): with DOMINO_FAILURE_SHOTS set, as CI sets it, a failed
 * test leaves a picture of each page its scenarios had open, under
 * .test-artifacts/failures/<test>/, which CI uploads (keepOnFailure).
 */
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test as nodeTest } from 'node:test';

/** The part an entry file runs; null when the suite runs whole. */
let selected = null;
/** The part the tests being registered belong to. */
let current = null;
/** Tests registered per part, the ones not run included. */
const counts = new Map();

const FAILURES = resolve(import.meta.dirname, '../../.test-artifacts/failures');
/** Where this process keeps the pictures of the test under way, until it knows whether they are needed. */
const PENDING = process.env.DOMINO_FAILURE_SHOTS ? join(FAILURES, `.pending-${process.pid}`) : null;
let pictures = 0;

/** The tests registered from here on belong to `name`. */
export function part(name) {
  current = name;
}

/** A test's function, keeping its pictures when it fails and dropping them when it passes. */
function keeping(name, fn) {
  return async function (t) {
    try {
      return await fn.call(this, t);
    } catch (error) {
      if (existsSync(PENDING)) renameSync(PENDING, join(FAILURES, `${String(name).replace(/[^a-z0-9]+/gi, '-').slice(0, 90)}-${process.pid}`));
      throw error;
    } finally {
      rmSync(PENDING, { recursive: true, force: true });
    }
  };
}

function register(run, args) {
  if (current === null) throw new Error(`"${args[0]}" comes before any part(): say which part it belongs to`);
  counts.set(current, (counts.get(current) ?? 0) + 1);
  if (selected !== null && selected !== current) return undefined;
  const fn = args.at(-1);
  return run(...(PENDING && typeof fn === 'function' ? [...args.slice(0, -1), keeping(args[0], fn)] : args));
}

/** node:test's `test`, registering only the tests of the part an entry file runs. */
export function test(...args) {
  return register(nodeTest, args);
}
test.skip = (...args) => register(nodeTest.skip, args);
test.todo = (...args) => register(nodeTest.todo, args);
test.only = (...args) => register(nodeTest.only, args);

/** Loads the suite with only `name`'s tests registered; a part with no test is a mistake, not a pass. */
export async function runPart(name, load) {
  if (selected !== null) throw new Error(`one part per entry file: ${selected} is already selected`);
  selected = name;
  await load();
  if (!counts.get(name)) throw new Error(`the suite has no test in part "${name}"`);
}

/**
 * A picture of each page of `context`, as a scenario closes it: a failed test's `finally` closes its pages before the
 * failure reaches the runner, so this is the last look at them. Kept only if the test fails. Nothing without
 * DOMINO_FAILURE_SHOTS; a page that cannot be pictured any more is passed over.
 */
export async function keepOnFailure(context) {
  if (!PENDING) return;
  mkdirSync(PENDING, { recursive: true });
  for (const page of context.pages()) {
    await page.screenshot({ path: join(PENDING, `${++pictures}.png`), timeout: 5_000 }).catch(() => {});
  }
}
