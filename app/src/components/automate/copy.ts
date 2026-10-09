/** These choices share a presentation, not a fee basis or an eligibility rule. */
export const AUTOMATION_CHOICE_COPY = {
  plain: { title: 'Plain position', description: 'Earn fees and collect them when you choose.', fee: 'No automation fee' },
  protection: { title: 'Auto-exit', description: 'Closes at the end of your range and sends the tokens to your wallet.', fee: '0.2% of the position, only when it closes' },
  compound: { title: 'Auto-compound', description: 'Adds earned fees back into the same position, in the same range.', fee: '2% of earned fees used, once' },
  domino: { title: 'Domino-compound', description: 'Earned fees can fund the next range. Your original deposit stays.', fee: '4% of earned fees used, once' },
} as const
