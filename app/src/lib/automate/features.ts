/**
 * Domino's three features, as the owner names the product (2026-09-24): a
 * plain position, opened in New position, and the two ways to put its earned
 * fees to work, Auto-compound and Domino-compound, set up on it from
 * Automate. One name, one line and, for the automations, the service fee,
 * wherever the three are offered side by side: Automate, New position's
 * success, and a position's own state. The lines are the ones the automation
 * page's own options say (CREATE.automation.options, without their fee
 * sentence), and the fees are the contract's (finance/sequence.ts
 * AUTOMATION_FEE_BPS): tests/automation-state.test.mjs holds them equal,
 * without this module importing either.
 * Pure data: no React, no chain, no clock.
 */

export type FeatureKey = 'plain' | 'compound' | 'domino'

export interface Feature {
  name: string
  line: string
  /** The service fee on earned fees consumed; none on a plain position. */
  fee: string | null
}

export const FEATURES: Readonly<Record<FeatureKey, Feature>> = {
  plain: { name: 'Plain position', line: 'Fees wait in the position until you collect them.', fee: null },
  compound: { name: 'Auto-compound', line: 'Fees go back into the same position.', fee: '2%' },
  domino: { name: 'Domino-compound', line: 'Fees can fund the next range one step higher.', fee: '4%' },
}

/** The order they are offered in: the position first, then what its fees can do. */
export const FEATURE_ORDER: readonly FeatureKey[] = ['plain', 'compound', 'domino']
