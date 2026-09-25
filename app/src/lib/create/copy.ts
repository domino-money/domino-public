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
    description: 'Four steps. Nothing moves until your wallet signs.',
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
  /** The four visual steps of the flow, over the five stages of the state machine. */
  step: {
    pool: { title: 'Pool', lead: 'Choose the pool this position trades in.' },
    range: { title: 'Range', lead: 'Choose the price band this position earns fees in.' },
    amount: { title: 'Amount', lead: 'How much of each token this position holds.' },
    review: { title: 'Review', lead: 'Every choice and the wallet steps. Create position opens it.' },
  },
  /** The state machine's stages: `short` labels the plain-text summary lines. */
  stage: {
    token: { title: 'Deposit token', short: 'Token', lead: 'The asset you deposit. Identity is the chain and the contract address, never a symbol.' },
    pool: { title: 'Pool', short: 'Pool', lead: 'A position holds two assets. Pick an existing pool that trades your token against the other.' },
    amount: { title: 'Amount and range', short: 'Amount', lead: 'How much of each token, and the price band the position earns fees in.' },
    balance: { title: 'Deposit amounts', short: 'Balance', lead: 'How much of each token the deposit is expected to take, and the most it may take.' },
    review: { title: 'Review', short: 'Review', lead: 'Every choice and the wallet steps. Create position opens it.' },
  },
  token: {
    needToken: 'Choose a token to continue.',
    /** Arriving with a pool already chosen: its two currencies are the choice. */
    depositWhich: 'Which of this pool’s tokens are you depositing?',
    depositWhichNote: 'You can enter an amount of both in step 3; this one leads.',
    notSelectable: 'The chosen token cannot be deposited: it could not be read.',
    searchLabel: 'Token in the pool',
    searchPlaceholder: 'Token name or address',
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
    /** A pool Domino V1's setup contract does not open positions in (DominoSetup.open refuses hooks; a dynamic fee has no fixed key). */
    unsupportedHooks: 'This pool has hooks, and positions can only be created here in pools without hooks. Choose another pool.',
    unsupportedDynamic: 'This pool has a dynamic fee, and positions can only be created here in pools with a fixed fee. Choose another pool.',
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
    /* The bound below is the product's (create/slippage.ts), the same numbers the backend's request models check. */
    slippageLabel: 'Slippage tolerance',
    slippageHint: 'From 0.1% to 5%, in hundredths of a percent: press a preset, drag the slider, or type an exact percentage. Let the slider go beside a mark and it settles on it.',
    slippageInvalid: 'Slippage is a whole number of basis points from 10 to 500: 0.1% to 5%.',
    slippagePresets: 'Common tolerances',
    /** Setup's draft and its swap, when the box holds nothing the bound admits. */
    slippageRequired: 'Choose a slippage limit from 0.1% to 5%.',
    slippageExact: 'Exact percentage',
    slippageExactInvalid: 'Enter a percentage from 0.1 to 5, with up to two decimal places.',
    /** Above 1%: what the tolerance lets the deposit, and any balancing swap, do. Said, never blocked. */
    slippageWarning: (percent: string) =>
      `${percent} is more than the usual 1%. The deposit may take up to ${percent} more of each token than the expected amounts, and a balancing swap may return ${percent} less than its quote.`,
    rangeHeading: 'Price range',
    budgetNote: 'The budget is the total in this token before separately disclosed costs. It is not an amount of each asset.',
    maxLabel: 'Use max',
    connectForBalance: 'Connect a wallet in the header to use its balance.',
    balanceAt: (block: string | null) => (block ? `Balance at block ${block}:` : 'Balance:'),
    balanceNote: 'Public chain data at one block. A connection proves nothing about who controls the address.',
    pairUnused: (symbol: string) => `At this price your range takes only ${symbol}, so an amount of this token would buy no position.`,
    pairOneSided: (symbol: string) => `At this price your range takes only ${symbol}.`,
    pairUnknown: 'The pool’s price or the range could not be used, so the other amount is not shown.',
    pairUnreadable: 'This token’s decimals or contract could not be read, so an amount cannot be entered in it.',
    pairNone: 'The wallet balance of this token could not be read.',
    pairReading: 'Reading the wallet balance…',
  },
  balance: {
    /** The one line under the deposit amount rows (the docs' New position page shows it too, lib/docs/pages/using.ts). */
    notEnabled: 'Exact amounts are calculated when you create the position, at the price when you sign.',
    /** Why no request can be formed, from previewRequest in journey.ts. */
    incomplete: 'the earlier steps are not complete.',
    /**
     * The line that says the wallet does not cover the deposit, by token. Shown
     * only for a currency the estimate itself reported short in `previewChecks`;
     * nothing here compares an amount to a balance.
     */
    short: (symbols: readonly string[]) =>
      `A position holds both of this pool’s tokens, and your wallet does not cover the most this deposit may take of ${
        symbols.length > 1 ? `${symbols.slice(0, -1).join(', ')} and ${symbols[symbols.length - 1]}` : symbols[0]
      }. Lower the budget, or add ${symbols.length > 1 ? 'them' : 'it'} to your wallet first.`,
    hooks: 'this pool has hooks, and deposits support hookless pools only.',
    dynamicFee: 'this pool has a dynamic fee, and deposits support fixed fees only.',
  },
  /** The automation choices and their limits. No step of New position shows them: Automate does, for a position that exists. */
  automation: {
    notEnabled: 'Not connected',
    planned: 'Planned',
    none: 'Plain position',
    noneDetail: 'Earned fees stay in the position until you collect them. Nothing runs on your behalf.',
    compound: 'Auto-compound',
    compoundRules: [
      'Earned fees go back into this same root position. The position cap is one; no successors are created.',
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
      'The service fee is 4% of the earned fees consumed, once, for every Domino recipe, including reinvestment into the source. No extra swap fee for the automation’s own balancing.',
    ],
    /** The three choices as cards: a title and one line each. */
    options: {
      none: { title: 'Plain position', line: 'Fees wait in the position until you collect them.' },
      compound: { title: 'Auto-compound', line: 'Fees go back into the same position. 2% of earned fees consumed.' },
      domino: { title: 'Domino-compound', line: 'Fees can fund the next range one step higher. 4% of earned fees consumed.' },
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
    choices: 'Your choices',
    steps: 'Wallet steps',
    stepsNote: 'What your wallet asks you to sign, in order, when you press Create position.',
    /** The one charge Domino makes, on earned fees an automation consumes. Automate states it for the mode it applies (screens/Automate.tsx); a direct deposit carries none. */
    serviceFeeValue: (mode: 'none' | 'compound' | 'domino') => mode === 'none' ? 'No automation service fee' : `${mode === 'domino' ? 4 : 2}% of earned fees consumed`,
    /** The slippage line of the headline, so the choice is in view before the wallet is asked for anything. */
    slippage: (percent: string) => `Slippage tolerance ${percent}`,
    rangeBetween: 'between',
    inRange: 'The pool price at its read block is inside this range.',
    outOfRange: 'The pool price at its read block is outside this range: the position would start inactive, holding one asset.',
    stale: 'The pool price was read more than 5 minutes ago on this page.',
    /** The review step's own line: it is the last one, and its action is Create position (StageReview.tsx FinalControl). */
    final: 'Press Create position: your wallet asks you to sign each step.',
    /** Create position with nothing to create: a choice is missing, or the pool is one positions are not created in. */
    notReady: 'Complete the steps above. Positions are created in pools without hooks and with a fixed fee.',
    /** Final control while its chunk loads, if it cannot load, and in builds without a wallet (StageReview.tsx FinalControl). */
    loading: 'Loading the wallet steps…',
    loadFailed: 'The wallet steps could not load. Reload the page to try again.',
    noWallet: 'Creating a position needs a wallet, which isn’t available here.',
    /**
     * The wallet steps Create position asks for, in order (walletSteps in
     * journey.ts, components/create/CreatePosition.tsx): an exact approval for
     * each token whose allowance is short, the deposit of both tokens to
     * Domino V1's setup contract, and the mint of the position NFT to the
     * wallet. Native ETH needs no approval: it travels with the deposit.
     */
    approveStep: 'Approve the exact amount',
    approveStepDetail: 'Asked only when this token’s allowance is short: never unlimited, and a smaller allowance is reset to zero first.',
    fundStep: 'Deposit the tokens',
    fundStepDetail: 'One transaction to Domino’s setup contract, verified on chain first. Native ETH travels with it. The tokens stay yours until the mint, and can be refunded.',
    mintStep: 'Create the position',
    mintStepDetail: 'One transaction: the position NFT is minted to your wallet at your range, and what the range does not use comes back with it.',
    /** The deposit and the swap when the wallet holds one of the two tokens (lib/create/depositPlan.ts). */
    fundOneStep: 'Deposit the token',
    /** `native`: the token deposited is native ETH, which travels with the transaction; an ERC-20 alone sends no ETH. */
    fundOneStepDetail: (native: boolean) =>
      `One transaction to Domino’s setup contract, verified on chain first.${native ? ' Native ETH travels with it.' : ''} The token stays yours until the mint, and can be refunded.`,
    swapStep: 'Swap for the other token',
    swapStepDetail: (fee: string) => `One swap inside this pool, of part of your deposit, with at least what your slippage limit allows. The pool’s fee and Domino’s assisted-swap fee (${fee}) apply to the swapped part.`,
    /** Under the headline when part of the deposit is swapped (StageReview.tsx names the two tokens before it): what the swap costs, and what bounds it. */
    swapNote: (fee: string) => `The amounts are estimates before the pool’s price impact. The swap returns at least what your slippage limit allows; the pool’s fee and Domino’s assisted-swap fee (${fee}) apply to the swapped part.`,
    /** Under the swap note when the pool's liquidity figure is reported and zero (lib/create/reviewPlan.ts). Nothing is said when the figure is missing. */
    emptyPool: 'This pool reports no liquidity, so part of a one-token deposit cannot be swapped in it. Deposit both tokens, or choose another pool.',
    /** The fee bases side by side (feeBases in journey.ts). The service row is the docs' fees page's (lib/docs/pages/reference.ts), not Review's: a direct deposit carries no Domino fee. */
    feeLabels: { pool: 'Pool trading fee', service: 'Domino service fee', swap: 'Assisted swap fee', gas: 'Network gas' },
    feeValues: { service: 'Auto-compound 2%; Domino-compound 4% of earned fees consumed', swap: '0.65% of the amount swapped', gas: 'Paid by you' },
    feeNotes: {
      pool: 'Paid by swappers through this pool to its liquidity providers, on each trade. Not a charge to you.',
      swap: 'Only when your wallet holds one of the two tokens and part of it is swapped for the other, simulated before you sign. Not added on top of the service fee.',
      gas: 'Paid by you; each wallet step shows its gas limit before you sign.',
    },
    /** The words of the plain-text summary (summaryLines and serialiseSummary in journey.ts). */
    summary: {
      beyondDisplay: 'beyond display',
      rangePrices: (lower: string, upper: string, tickLower: number, tickUpper: number) => `${lower} to ${upper} (ticks ${tickLower} to ${tickUpper})`,
      rangeTicks: (tickLower: number, tickUpper: number) => `ticks ${tickLower} to ${tickUpper}`,
      slippage: (percent: string) => `slippage ${percent}`,
      price: 'Price',
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
