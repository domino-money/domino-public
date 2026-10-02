// finance.browser.test.mjs, part 'automation': Automate and sequences, receipts, managed positions, Setup's deposits.
// The suite runs in parts (tests/support/parts.mjs); CI runs this one in the job finance-automation.
import { runPart } from './support/parts.mjs';

await runPart('automation', () => import('./finance.browser.test.mjs'));
