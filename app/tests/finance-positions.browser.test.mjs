// finance.browser.test.mjs, part 'positions': Your positions, a position's page, its fees history and the RPC fallbacks.
// The suite runs in parts (tests/support/parts.mjs); CI runs this one in the job finance-positions.
import { runPart } from './support/parts.mjs';

await runPart('positions', () => import('./finance.browser.test.mjs'));
