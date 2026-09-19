/**
 * Every English sentence of the new-position flow, in one place. Plain
 * words, no promises: where a step cannot proceed, the sentence says exactly
 * why. Nothing here says "current", "live" or "qualified" about a figure,
 * and nothing says "your" about chain data.
 */
export const CREATE = {
  page: {
    eyebrow: 'Robinhood Chain · Uniswap',
    title: 'New position',
    description: 'Five steps. Nothing moves until your wallet signs in Setup.',
    stepOf: (index: number, count: number) => `Step ${index} of ${count}`,
    back: 'Back',
    next: 'Continue',
    create: 'Create position',
    edit: 'Edit',
    rail: 'Your choices',
    railHint: 'Completed steps can be reopened. Inputs are kept.',
    notChosen: '—',
    sourceLoading: 'Connecting to the read service…',
    stepState: { done: 'done', current: 'current', upcoming: 'not started' },
  },
  /** The five visual steps of the flow, over the six stages of the state machine. */
  step: {
    pool: { title: 'Pool', lead: 'Choose the pool and the token you deposit.' },
    range: { title: 'Range', lead: 'Choose the price band this position earns fees in.' },
    amount: { title: 'Amount', lead: 'How much of the token you deposit.' },
    automation: { title: 'Automation', lead: 'What happens to the fees this position earns.' },
    review: { title: 'Review', lead: 'Every choice, the fees and the wallet steps, before Setup.' },
  },
  /** The state machine's stages: `short` labels the plain-text summary lines. */
  stage: {
    token: { title: 'Deposit token', short: 'Token', lead: 'The asset you deposit. Identity is the chain and the contract address, never a symbol.' },
    pool: { title: 'Pool', short: 'Pool', lead: 'A position holds two assets. Pick an existing pool that trades your token against the other.' },
    amount: { title: 'Amount and range', short: 'Amount', lead: 'The budget in the deposit token, and the price band the position earns fees in.' },
    balance: { title: 'Deposit amounts', short: 'Balance', lead: 'How much of each token the deposit is expected to take, and the most it may take.' },
    automation: { title: 'Automation', short: 'Automation', lead: 'What happens to the fees this position earns.' },
    review: { title: 'Review', short: 'Review', lead: 'Every choice, the fees and the wallet steps, before Setup.' },
  },
  token: {
    needToken: 'Choose a token to continue.',
    notSelectable: 'The chosen token cannot be deposited: it could not be read.',
    searchLabel: 'Token you deposit',
    searchPlaceholder: 'Token name or address',
    depositWith: 'Deposit with',
    moreWays: 'More ways to find a token',
    walletHeading: 'From a wallet',
    walletNote: 'Check a contract address, or list the tokens a public address holds. Balances are public chain data at one block.',
    connectedNote: (short: string) => `The wallet connected in the header, ${short}, fills in the address below. Any other public address works the same way.`,
    disconnectedNote: 'Connect a wallet in the header to fill in its address, or enter any public address.',
    preselectHeading: 'Pool from the link',
    preselectChecking: 'Verifying the linked pool on Robinhood Chain…',
    preselectVerified: (block: number) => `Verified at block ${block}. Pick the token you deposit below.`,
    preselectNotFound: 'The linked pool id was not returned by the read service, so it is not preselected. Search for a token below to choose a pool.',
    preselectMalformed: 'The link does not carry a valid pool id, so nothing is preselected.',
    nativeNote: 'Native ETH is its own currency at address 0x0000…0000. Wrapped ETH is a separate contract at its own address. Their pools are different pools.',
  },
  pool: {
    needPool: 'Choose a pool to continue.',
    poolMismatch: 'The chosen pool does not hold the selected token. Choose another pool.',
    chosenHeading: 'Chosen pool',
    verifiedAt: (block: number) => `Verified at block ${block}`,
    change: 'Choose a different pool',
    keep: 'Keep this pool',
    pairedHeading: 'Second asset (optional)',
    pairedNote: 'Narrow the pools to those that trade your token against one asset. USDG is a dollar-linked asset; ETH is another volatile asset.',
    choosePaired: 'Choose second asset',
    changePaired: 'Change second asset',
    clearPaired: 'Clear second asset',
    pairedDialogTitle: 'Choose the second asset',
    pairedDialogDescription: 'Search by contract address, or list the tokens held by a public address.',
    selectPaired: 'Use this asset',
  },
  amount: {
    budgetLabel: 'Budget',
    budgetHint: (decimals: number | null) => (decimals === null ? 'Decimals for this token could not be read.' : `Up to ${decimals} decimal places.`),
    rawUnits: (raw: string, decimals: number) => `${raw} raw units at ${decimals} decimals`,
    /** Where the raw units come from: the raw-units line's title, never a caption on screen. */
    rawUnitsTitle: 'Converted to raw units with the decimals read from chain.',
    empty: 'Enter a deposit budget.',
    format: 'Enter a positive decimal amount without commas, signs or exponents.',
    zero: 'The budget must be greater than zero.',
    tooManyPlaces: (decimals: number) => `This token has ${decimals} decimal places, so the budget cannot have more.`,
    tooLarge: 'That amount is larger than a token balance can be.',
    decimalsUnknown: 'This token’s decimals could not be read, so an amount cannot be converted to raw units. Choose a token whose decimals were read.',
    priceUnavailable: 'The pool’s price could not be used, so no range can be set on it.',
    noRange: 'Set a price range to continue.',
    rangeTicks: 'Range bounds must be whole ticks.',
    rangeSpacing: 'Range bounds must be multiples of the pool’s tick spacing.',
    rangeBounds: 'Range bounds are outside the ticks this pool allows.',
    rangeOrder: 'The lower bound must stay below the upper bound.',
    slippageLabel: 'Slippage tolerance (basis points)',
    slippageHint: '0 to 9999 basis points; 50 is 0.5%.',
    slippageInvalid: 'Slippage is a whole number of basis points from 0 to 9999.',
    slippageValue: (bps: string) => `${bps} basis points`,
    advanced: 'Advanced: slippage tolerance',
    rangeHeading: 'Price range',
    budgetNote: 'The budget is the total in this token before separately disclosed costs. It is not an amount of each asset.',
    maxLabel: 'Use max',
    connectForBalance: 'Connect a wallet in the header to use its balance.',
    balanceAt: (block: string | null) => (block ? `Balance at block ${block}:` : 'Balance:'),
    balanceFromListing: 'Balance from the wallet listing:',
    balanceReading: 'Reading the wallet balance…',
    balanceWaiting: 'Connecting to the read service…',
    balanceNotReturned: (block: string | null) => `The read returned no balance for this token${block ? ` at block ${block}` : ''}.`,
    balanceInvalidAddress: 'The connected wallet reported an address that is not in the expected form, so nothing was read.',
    balanceNote: 'Public chain data at one block. A connection proves nothing about who controls the address.',
    balanceRaw: 'Shown in raw units because the token’s decimals were not read, so it cannot fill the budget.',
    balanceZero: 'The wallet holds none of this token at that block.',
    balanceUnreadable: 'The balance could not be read, so it cannot fill the budget.',
    balanceNoDecimals: 'The token’s decimals were not read, so the balance cannot fill the budget.',
    /** The balance line's title when it shows a dash: why there is no balance. */
    balanceFailed: 'The wallet balance could not be read.',
    /**
     * The pool's other token on the amount step. A position is funded with
     * both of a pool's tokens: the budget above is in the one chosen, and the
     * service derives the other from the range and the price. So the balance
     * that decides whether the deposit can go through is often this one.
     */
    pairNote: 'A position holds both of the pool’s tokens. How much of each this budget takes is calculated in Review, from the range and the price at that moment.',
    pairLabel: 'The pool’s other token',
    pairBalanceAt: (block: string | null) => (block ? `Your balance at block ${block}:` : 'Your balance:'),
    pairNone: 'Your balance of this token could not be read, so nothing here can say whether it covers the deposit.',
    pairConnect: 'Connect a wallet in the header to see what you hold of both tokens.',
    pairReading: 'Reading your balance of both tokens…',
  },
  balance: {
    /** The one line under the deposit amount rows (the docs' New position page shows it too, lib/docs/pages/using.ts). */
    notEnabled: 'Exact amounts are calculated in Setup, at the price when you sign.',
    /** Why no request can be formed, from previewRequest in journey.ts. */
    incomplete: 'the earlier steps are not complete.',
    /** The estimate waits for the balances, because they are part of its own request. */
    balances: 'your balances of this pool’s tokens are still being read.',
    /**
     * The line that says the wallet does not cover the deposit, by token. Shown
     * only for a currency the estimate itself reported short in `previewChecks`;
     * nothing here compares an amount to a balance.
     */
    short: (symbols: readonly string[]) =>
      `A position holds both of this pool’s tokens, and your wallet does not cover the most this deposit may take of ${
        symbols.length > 1 ? `${symbols.slice(0, -1).join(', ')} and ${symbols[symbols.length - 1]}` : symbols[0]
      }. Lower the budget, or swap into ${symbols.length > 1 ? 'them' : 'it'} in Setup before depositing.`,
    hooks: 'this pool has hooks, and deposits support hookless pools only.',
    dynamicFee: 'this pool has a dynamic fee, and deposits support fixed fees only.',
    /** The four rows, filled while an estimate for these choices is current. */
    rows: {
      expected: 'Expected deposit',
      maximum: 'Maximum debit',
      unspent: 'Unspent budget',
      liquidity: 'Mint liquidity',
    },
    /** What a row's title says, never on screen: where the figure stands, or why it is a dash. */
    titles: {
      current: (until: string) => `An estimate for these choices, current until ${until}.`,
      expected: 'What the deposit is expected to take of this token.',
      maximum: 'The most the deposit may take of this token, with your slippage.',
      liquidity: 'The liquidity the mint would add, in raw units.',
      rawUnits: 'Raw units: this token’s decimals were not read.',
      noBudget: 'No budget was set for this token.',
      expired: (at: string) => `This estimate expired at ${at}.`,
      signedOut: 'Sign in with your wallet to see these amounts.',
      loading: 'Reading the amounts…',
      off: 'Exact amounts are calculated in Setup, at the price when you sign.',
      unavailable: 'These amounts could not be read.',
    },
    /** The screen reader's line when the rows change. */
    announce: {
      current: 'Deposit amounts shown.',
      expired: 'The deposit amounts expired.',
    },
    rawUnits: (text: string) => `${text} raw units`,
  },
  automation: {
    notEnabled: 'Not connected',
    planned: 'Planned',
    none: 'Self-managing',
    noneDetail: 'Earned fees stay in the position until you collect them. Nothing runs on your behalf.',
    compound: 'Auto-compound',
    compoundRules: [
      'Earned fees go back into this same position.',
      'The service fee is 2% of the earned fees consumed, taken once. Never on principal.',
      'Only proven earned fees are used. No wallet asset is pulled and no principal is sold.',
    ],
    domino: 'Domino-compound',
    dominoRules: [
      'Fees normally return to their source position.',
      'Within the trigger distance below the source’s upper price, fees can fund an existing successor or open a new one in the same pool.',
      'A successor’s ceiling sits above the previous ceiling by the upside you set for the sequence, rounded up to the tick spacing; the next range below is drawn at 50%. Its floor may overlap downward by at most the configured share of that ceiling.',
      'The sequence has a cap, counted including the root. At the cap, fees fund an existing position or wait.',
      'Fees only, never principal. When an action is not justified, it waits with a reason.',
      'The service fee is 2% of the earned fees consumed, once. No extra swap fee for the automation’s own balancing.',
    ],
    /** The three choices as cards: a title and one line each. */
    options: {
      none: { title: 'Self-managing', line: 'Fees wait in the position until you collect them.' },
      compound: { title: 'Auto-compound', line: 'Fees go back into the same range.' },
      domino: { title: 'Domino-compound', line: 'Fees open the next range one step higher.' },
    },
    optionsLegend: 'What the earned fees do',
    compoundRulesHeading: 'How Auto-compound works',
    dominoRulesHeading: 'How Domino-compound works',
    limitsHeading: 'Limits',
    /* The bounds below are the contract's (PolicyValidation.sol), as LIMIT_BOUNDS in journey.ts holds them. */
    trigger: 'Trigger distance (%)',
    triggerHint: '0 to 20. A 5% trigger means the price at 95% of the previous ceiling; 0 waits for the ceiling itself.',
    overlap: 'Maximum overlap (%)',
    overlapHint: '0 to 20. With a ceiling of 1 and 20% overlap, the successor’s floor cannot be below 0.80.',
    cap: 'Positions in the sequence',
    capHint: '1 to 255, including the first position. The default is 3.',
    triggerInvalid: 'Trigger distance is a percentage from 0 to 20, with up to two decimal places.',
    overlapInvalid: 'Maximum overlap is a percentage from 0 to 20, with up to two decimal places.',
    capInvalid: 'The number of positions is a whole number from 1 to 255.',
    limitsInvalid: 'Fix the Domino-compound limits to continue.',
    nextRange: 'Next proposed range, from your upper bound',
    nextRangeNote: 'Geometry only, in the pool’s price orientation, drawn at a 50% upside, rounded outward to the tick spacing. Not a plan: a trigger is eligibility to evaluate, never an order to mint.',
    infeasible: 'The successor geometry is not feasible on this tick spacing.',
    fundingNote: 'A successor is funded from earned fees inside the sequence only, after the service fee.',
    geometry: {
      trigger: 'Trigger at',
      floor: 'Successor floor, no lower than',
      ceiling: 'Successor ceiling',
      tick: (tick: number) => `tick ${tick}`,
      words: (price: string, tick: number, distance: string) => `${price} (tick ${tick}, ${distance} from your upper bound)`,
    },
  },
  review: {
    gate: 'Deposits are made in Setup, one reviewed wallet step at a time.',
    gateDetail: 'Signing stays in Setup and your wallet. Nothing can be approved, minted or swapped from this page.',
    choices: 'Your choices',
    lines: {
      pool: 'Pool',
      token: 'Deposit token',
      range: 'Range',
      budget: 'Budget',
      slippage: 'Slippage',
      automation: 'Automation',
    },
    amounts: 'Deposit amounts per token',
    steps: 'Wallet steps',
    stepsNote: 'What your wallet will be asked for, in order: the deposit in Setup, then any automation from Automate. None of it starts from this page.',
    fees: 'Fees',
    feesNote: 'Two different bases, shown apart: a trading fee paid by swappers to the pool, and a service fee taken from earned fees consumed by automation.',
    summaryHeading: 'Plain-text summary',
    inRange: 'The pool price at its read block is inside this range.',
    outOfRange: 'The pool price at its read block is outside this range: the position would start inactive, holding one asset.',
    stale: 'The pool price was read more than 5 minutes ago on this page.',
    recipient: 'NFT recipient',
    recipientValue: 'The wallet that signs the mint. No address is known to this screen.',
    /** Final control, wallet builds: a link to Setup, which opens with these choices filled in for the signed-in wallet. */
    setup: 'Continue in Setup',
    setupNote: 'Setup opens with this pool, range and amount filled in. Nothing is sent until you create the draft there.',
    setupNoteSignedOut: 'Sign in first, and Setup opens with this pool, range and amount filled in. Nothing is sent until you create the draft there.',
    /** Under the link when the pool is one Setup's deposits do not take (hooks or a dynamic fee): nothing is carried, and nothing is promised. */
    setupNoteUnsupported: 'Deposits in Setup take pools with no hooks and a fixed fee.',
    /** Final control, builds without wallet sign-in. */
    noSetup: 'Deposits are made in Setup, which isn’t available here.',
    /**
     * The wallet steps, in order (walletSteps in journey.ts). A deposit takes
     * each ERC-20 through Permit2: an exact approval to Permit2, then a Permit2
     * allowance for the position manager (docs/DIRECT_DEPOSITS.md). Native ETH
     * needs no approval: it goes with the mint. Automation is three owner
     * transactions on the sequence (finance/sequence.ts).
     */
    approveStep: 'Approve the selected token to Permit2',
    approveStepDetail: 'An exact amount, never unlimited, asked only when the current allowance is short. A smaller allowance is reset to zero first.',
    permitStep: 'Allow the position manager to use the selected token through Permit2',
    permitStepDetail: 'A Permit2 allowance for that exact amount, to the verified position manager only, expiring within an hour.',
    otherApproveStep: 'Approve the other token to Permit2, if the composition needs it',
    otherPermitStep: 'Allow the position manager to use the other token through Permit2, if the composition needs it',
    otherTokenStep: 'The amount, if any, is calculated when the deposit is prepared.',
    mintStep: 'Mint the position NFT to your wallet',
    mintStepDetail: 'One transaction to the verified position manager: mint, then settle both currencies. Nothing else in it.',
    nativeMintDetail: 'One transaction to the verified position manager: mint, then settle both currencies. Native ETH needs no approval: it goes with this transaction, capped at the budget, and what is not used is refunded.',
    otherNativeMintDetail: 'One transaction to the verified position manager: mint, then settle both currencies. Native ETH needs no approval: if the composition needs it, it goes with this transaction, and what is not used is refunded.',
    automationApproveStep: 'Approve this position NFT to its sequence',
    automationApproveDetail: 'Only this NFT, to the address its sequence will have; never approval for all NFTs. The NFT stays in your wallet.',
    automationCreateStep: 'Create the sequence, paused',
    automationCreateDetail: 'Registers this NFT, its limits and the 2% service fee on earned fees consumed. It starts paused: nothing runs yet.',
    automationActivateStep: (name: string) => `Activate ${name}`,
    automationActivateDetail: 'A separate owner transaction, when you choose. Nothing runs before it, and you can pause or revoke it from your wallet.',
    automationStepNames: { compound: 'Auto-compound', domino: 'Domino-compound' },
    /** The fee bases side by side (feeBases in journey.ts). */
    feeLabels: { pool: 'Pool trading fee', service: 'Domino service fee', swap: 'Assisted swap fee', gas: 'Network gas' },
    feeValues: { service: '2% of earned fees consumed', swap: 'At most 0.65% of the consumed swap budget', gas: 'Paid by you' },
    feeNotes: {
      pool: 'Paid by swappers through this pool to its liquidity providers, on each trade. Not a charge to you.',
      service: 'Once, when Auto-compound or Domino-compound consumes earned fees. Never on principal, never on a direct deposit.',
      swap: 'Only if you request a balancing swap, quoted before you approve it. Not added on top of the service fee.',
      gas: 'Paid by you; each wallet step shows its gas limit before you sign.',
    },
    /** The words of the plain-text summary (summaryLines and serialiseSummary in journey.ts). */
    summary: {
      beyondDisplay: 'beyond display',
      rangePrices: (lower: string, upper: string, tickLower: number, tickUpper: number) => `${lower} to ${upper} (ticks ${tickLower} to ${tickUpper})`,
      rangeTicks: (tickLower: number, tickUpper: number) => `ticks ${tickLower} to ${tickUpper}`,
      limits: (trigger: number, overlap: number, cap: number) => `trigger ${trigger}%, overlap ${overlap}%, cap ${cap}`,
      limitsInvalid: 'limits invalid',
      notConnected: 'not connected',
      price: 'Price',
      amounts: 'Deposit amounts',
      walletStep: (index: number) => `Wallet step ${index}`,
      create: 'Create position',
      enabled: 'enabled',
      disabled: (reason: string) => `disabled — ${reason}`,
    },
  },
} as const

/** Every fixed sentence above, once each, for tests that check the words. */
export function allCreateStrings(): string[] {
  const out: string[] = []
  const walk = (value: unknown) => {
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(CREATE)
  return [...new Set(out)]
}
