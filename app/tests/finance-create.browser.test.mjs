// finance.browser.test.mjs, part 'create': New position, Create position and Setup's assisted swap.
// The suite runs in parts (tests/support/parts.mjs); CI runs this one in the job finance-create.
import { runPart } from './support/parts.mjs';

await runPart('create', () => import('./finance.browser.test.mjs'));
