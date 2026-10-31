/**
 * These choices share a presentation, not a fee basis or an eligibility rule.
 *
 * Changed on purpose 2026-10-30 (QA round 2): one wording per fee wherever it is shown (the owner's Q1: "of the earned fees
 * it uses, each time", and Auto-exit "of the position's value, only if it closes"), with when a run happens and who pays
 * its network fee (N29; the docs' "when a run pays off" and "Domino pays the runs' gas"). Domino-compound in plain words
 * and who holds the positions it opens (Q32, N48). Auto-exit's trigger, its year and that it is never combined with
 * compounding said in its own card, in three sentences (N12, N70, N47: render.test.mjs forbids a note under the cards). New position read as
 * the step before the automations, its name kept (the owner's decision on N11). Each fee keeps its leading figure, so
 * AutomationChoice's feeFigure still sets it in its own <b>.
 */
export const AUTOMATION_CHOICE_COPY = {
  plain: { title: 'New position', description: 'Start here: choose a pool and add your tokens. The automations below work on a position you already have.', fee: 'No automation fee', docs: 'new-position' },
  protection: { title: 'Auto-exit', description: 'Closes at the end of your range, with no price to set, and sends the tokens to your wallet. Lasts a year, then turn it on again. Can’t be combined with Auto-compound or Domino-compound.', fee: '0.2% of the position’s value, only if it closes', docs: 'auto-exit' },
  compound: { title: 'Auto-compound', description: 'Adds earned fees back into the same position, in the same range.', fee: '2% of the earned fees it uses, each time. Runs when enough fees have built up. Domino pays the network fee.', docs: 'auto-compound' },
  domino: { title: 'Domino-compound', description: 'Near the top of your range, earned fees open a new position higher up, held by your automation until you withdraw it. Your original deposit stays.', fee: '4% of the earned fees it uses, each time. Runs when enough fees have built up. Domino pays the network fee.', docs: 'domino-compound' },
} as const
