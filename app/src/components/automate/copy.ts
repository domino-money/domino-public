/** These choices share a presentation, not a fee basis or an eligibility rule. */
export const AUTOMATION_CHOICE_COPY = {
  plain: { title: 'New position', description: 'Choose a pool, add your tokens and start earning fees.', fee: 'No automation fee', docs: 'new-position' },
  protection: { title: 'Auto-exit', description: 'Closes at the end of your range and sends the tokens to your wallet.', fee: '0.2% of the position, only when it closes', docs: 'auto-exit' },
  compound: { title: 'Auto-compound', description: 'Adds earned fees back into the same position, in the same range.', fee: '2% of earned fees used, once', docs: 'auto-compound' },
  domino: { title: 'Domino-compound', description: 'Earned fees can fund the next range. Your original deposit stays.', fee: '4% of earned fees used, once', docs: 'domino-compound' },
} as const
