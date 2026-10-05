import { feeChipText } from '../format/fee'

/**
 * Every English sentence of the new-position flow, in one place. Plain
 * words, no promises: where a step cannot proceed, the sentence says exactly
 * why. Nothing here says "current", "live" or "qualified" about a figure,
 * and nothing says "your" about chain data.
 */
export const CREATE = {
  // Changed on purpose (round 6, 2026-09-27, the owner: New position is for people who know nothing about liquidity
  // pools): every sentence a person reads on the four steps is plain and short, prices are written "1 ETH = 2,500
  // USDG" rather than "USDG per ETH", and the technical parts (slippage, ticks, token contracts) sit under Advanced
  // or Details, closed until opened.
  page: {
    title: 'New position',
    description: 'Four steps. Nothing leaves your wallet until you confirm.',
    stepOf: (index: number, count: number) => `Step ${index} of ${count}`,
    back: 'Back',
    next: 'Continue',
    create: 'Create position',
    edit: 'Edit',
    notChosen: '—',
    sourceLoading: 'Loading…',
    progress: 'Build your position',
    preview: 'Your position',
    previewNote: 'Your choices appear here as you go.',
    previewExample: 'Illustration of how a price range works',
    previewTotal: 'Estimated total',
    stepState: { done: 'done', current: 'current', upcoming: 'not started' },
  },
  /** The four visual steps of the flow, over the five stages of the state machine. */
  step: {
    // Changed on purpose 2026-10-01 (audit E25): the step asks for a token, then one of its pools, not two tokens.
    pool: { title: 'Pool', lead: 'Search a token, then pick one of its pools.', caption: 'Choose your tokens' },
    range: { title: 'Range', lead: 'You earn fees only while the price stays in this range.', caption: 'Set your price window' },
    // Changed on purpose 2026-10-01 (audit E13, live note L11): a range above or below today's price takes one token
    // alone, so "either token" is said only of a range around the price, and the one-token range has its own lead.
    amount: {
      title: 'Amount',
      lead: 'Enter an amount in either token; the other fills in.',
      caption: 'Choose how much',
      leadOne: (symbol: string) => `This range takes only ${symbol}. Enter how much ${symbol} to put in.`,
    },
    review: { title: 'Review', lead: 'Check your position, then confirm in your wallet.', caption: 'Check and confirm' },
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
    notSelectable: 'The chosen token cannot be deposited: it could not be read.',
    searchLabel: 'Search a token',
    searchPlaceholder: 'Name or address, like USDG',
    preselectHeading: 'Pool from the link',
    preselectChecking: 'Verifying the linked pool on Robinhood Chain…',
    preselectVerified: (block: number) => `Verified at block ${block}.`,
    preselectNotFound: 'The linked pool id was not returned by the read service, so it is not preselected. Search for a token below to choose a pool.',
    preselectMalformed: 'The link does not carry a valid pool id, so nothing is preselected.',
    // A pool the featured list withdrew by a safety rule (featured pools v1 §11.5), or one with a token that passes for a
    // main token (audit I1), opened by a link. Since 2026-10-01 (audit B2) a pool that left the list only because its
    // figures were unavailable is preselected as any other, so this line is said for safety reasons alone.
    preselectWithdrawn: 'For safety, Domino doesn’t open positions in this pool. Choose another pool.',
    nativeNote: 'Native ETH is its own currency at address 0x0000…0000. Wrapped ETH is a separate contract at its own address. Their pools are different pools.',
  },
  pool: {
    needPool: 'Choose a pool to continue.',
    poolMismatch: 'The chosen pool does not hold the selected token. Choose another pool.',
    /** A pool Domino V1's setup contract does not open positions in (DominoSetup.open refuses hooks; a dynamic fee has no fixed key). */
    unsupportedHooks: 'This pool has hooks, and positions can only be created here in pools without hooks. Choose another pool.',
    unsupportedDynamic: 'This pool has a dynamic fee, and positions can only be created here in pools with a fixed fee. Choose another pool.',
    verifiedAt: (block: number) => `Verified at block ${block}`,
    /** The chosen pool's fee, as every fee chip says it (lib/format/fee.ts, audit E21): "Uniswap · 0.30% fee". */
    fee: (fee: string) => feeChipText(fee),
    change: 'Change pool',
    keep: 'Keep this pool',
  },
  amount: {
    entered: 'You enter',
    paired: 'Paired automatically',
    pairGuide: 'These two amounts make up your position. Change either one and the other follows your range.',
    total: 'Estimated total in this position',
    totalNote: 'Network fees are separate.',
    totalOneNote: 'Network fees are separate.',
    totalSwapNote: 'After the estimated swap. Network fees are separate.',
    totalUnavailable: 'USD estimate unavailable',
    budgetHint: (decimals: number | null) => (decimals === null ? 'Decimals for this token could not be read.' : `Up to ${decimals} decimal places.`),
    empty: 'Enter an amount to continue.',
    format: 'Enter a number, like 100 or 0.5.',
    zero: 'The amount must be more than zero.',
    tooManyPlaces: (decimals: number) => `This token allows up to ${decimals} decimal places.`,
    tooLarge: 'That amount is too large.',
    decimalsUnknown: 'This token can’t be read, so no amount can be entered in it. Choose another pool.',
    priceUnavailable: 'This pool’s price can’t be read right now, so no range can be set.',
    noRange: 'Choose a range to continue.',
    rangeTicks: 'Range bounds must be whole ticks.',
    rangeSpacing: 'Range bounds must be multiples of the pool’s tick spacing.',
    rangeBounds: 'Range bounds are outside the ticks this pool allows.',
    rangeOrder: 'The lowest price must stay below the highest price.',
    /** The range step (RangeStep.tsx). */
    now: 'Today’s price',
    widths: 'Range width',
    widthLines: {
      standard: 'A smaller price window. The price can leave it sooner, so check it more often.',
      wide: 'A larger price window gives the price more room to move. Fees are spread over a wider range.',
      custom: 'Set your own lowest and highest price.',
    },
    lowest: 'Lowest price',
    highest: 'Highest price',
    below: (percent: string) => `${percent} below today`,
    above: (percent: string) => `${percent} above today`,
    atToday: 'At today’s price',
    /** A bound's buttons, for assistive technology. */
    lowerBy: (label: string) => `Lower the ${label.toLowerCase()}`,
    raiseBy: (label: string) => `Raise the ${label.toLowerCase()}`,
    rangeOut: {
      below: 'Today’s price is below this range: the position starts with one token only and earns no fees until the price rises into it.',
      above: 'Today’s price is above this range: the position starts with one token only and earns no fees until the price falls into it.',
    },
    rangeIn: 'Today’s price is inside this range.',
    /** The preview's calm word for a range beside today's price (PositionPreview.tsx, 2026-09-28, one-sided): no red alarm. */
    earnsInRange: 'Earns once the price is in range',
    customHint: 'Type a price or drag. It moves to the nearest price the pool allows.',
    /**
     * A typed price the range controls refused (lib/read/screens/RangePriceInput.ts, shared with the pool page), in the
     * step's own words: "lowest" and "highest" rather than "min" and "max", and no "decimal" or "exponents". A message
     * not listed here is said as the shared control says it. Added 2026-09-28 (round 6).
     */
    priceErrors: {
      'Enter a positive decimal price without commas or exponents.': 'Enter a price as a number, like 2000 or 0.5.',
      'Price must be greater than zero.': 'The price must be more than zero.',
      'That price is outside this pool’s supported range.': 'That price is too far from today’s for this pool.',
      'Min price must stay below max price.': 'The lowest price must stay below the highest price.',
      'Max price must stay above min price.': 'The highest price must stay above the lowest price.',
    } as Readonly<Record<string, string>>,
    /* The bound below is the product's (create/slippage.ts), the same numbers the backend's request models check. */
    advanced: 'Advanced',
    slippageLabel: 'Slippage tolerance',
    slippageHint: 'How far prices may move while you confirm. If they move more, the step stops and your tokens stay yours.',
    slippageInvalid: 'Slippage is a whole number of basis points from 10 to 500: 0.1% to 5%.',
    slippagePresets: 'Common tolerances',
    /** Setup's draft and its swap, when the box holds nothing the bound admits. */
    slippageRequired: 'Choose a slippage limit from 0.1% to 5%.',
    slippageExact: 'Exact percentage',
    slippageExactInvalid: 'Enter a percentage from 0.1 to 5, with up to two decimal places.',
    /** Above 1%: what the tolerance lets the deposit, and any balancing swap, do. Said, never blocked. */
    slippageWarning: (percent: string) => `${percent} is more than the usual 1%. The deposit can take up to ${percent} more of each token, and a swap can return ${percent} less.`,
    rangeHeading: 'Price range',
    maxLabel: 'Max',
    connectForBalance: 'Connect a wallet to see your balance.',
    balanceAt: (block: string | null) => (block ? `Balance at block ${block}:` : 'Balance:'),
    balanceNote: 'Public chain data at one block. A connection proves nothing about who controls the address.',
    pairUnused: (symbol: string) => `At today’s price this range holds only ${symbol}. Enter the amount in ${symbol}.`,
    pairOneSided: (symbol: string) => `At today’s price this range holds only ${symbol}.`,
    pairUnknown: 'The other amount can’t be worked out right now.',
    pairUnreadable: 'This token can’t be read, so no amount can be entered in it.',
    pairNone: 'Your balance of this token could not be read.',
    pairReading: 'Checking your balance…',
    /** The wallet cannot fund the amounts either way (lib/create/depositPlan.ts): said under them, never blocked here. */
    short: 'Your wallet doesn’t have enough for this amount. Lower it, or add tokens to your wallet.',
    /**
     * The same under the amounts, naming both tokens (audit E9, 2026-10-01): the plan found that neither one alone nor
     * both together cover the amount. With a symbol unread, the line above.
     */
    shortOf: (first: string, second: string) =>
      first && second ? `Your wallet doesn’t have enough ${first} or ${second} for this amount. Lower it, or add tokens to your wallet.` : 'Your wallet doesn’t have enough for this amount. Lower it, or add tokens to your wallet.',
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
      'The service fee is 2% of the earned fees it uses, taken once. Never on principal.',
      'Only proven earned fees are used. No wallet asset is pulled and no principal is sold.',
    ],
    domino: 'Domino-compound',
    dominoRules: [
      'Fees normally return to their source position.',
      'Within the trigger distance below the source’s upper price, fees can fund an existing successor or open a new one in the same pool.',
      'A successor’s ceiling sits above the previous ceiling by the upside you set for the sequence, rounded up to the tick spacing; the next range below is drawn at 50%. Its floor may overlap downward by at most the configured share of that ceiling.',
      'The sequence has a cap, counted including the root. At the cap, fees fund an existing position or wait.',
      'Fees only, never principal. When an action is not justified, it waits with a reason.',
      'The service fee is 4% of the earned fees it uses, once, for every automated step, including fees added back to the source position. No extra swap fee for the automation’s own balancing.',
    ],
    /**
     * The three choices as cards: a title and one line each. Changed on purpose 2026-10-01 (audit E4): "of the fees it
     * uses", not "of earned fees consumed".
     */
    options: {
      none: { title: 'Plain position', line: 'Fees wait in the position until you collect them.' },
      compound: { title: 'Auto-compound', line: 'Fees go back into the same position. 2% of the fees it uses.' },
      domino: { title: 'Domino-compound', line: 'Fees can fund the next range one step higher. 4% of the fees it uses.' },
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
    choices: 'Your position',
    total: 'Estimated position value',
    steps: 'In your wallet',
    stepsNote: 'Your wallet will ask you to confirm these, in order.',
    /**
     * The one charge Domino makes, on earned fees an automation uses. Automate states it for the mode it applies
     * (screens/Automate.tsx: "2% of the fees it uses, once"); a direct deposit carries none. Changed on purpose
     * 2026-10-01 (audit E4, live note L12): "consumed" said nothing to a beginner.
     */
    serviceFeeValue: (mode: 'none' | 'compound' | 'domino') => mode === 'none' ? 'No automation service fee' : `${mode === 'domino' ? 4 : 2}% of the fees it uses`,
    /** The slippage row of Review's Details (StageReview.tsx). */
    slippage: (percent: string) => `Slippage tolerance ${percent}`,
    /**
     * Above 1%, on Review, where the tolerance itself is inside the closed Details: what the figure is and where it is
     * changed, then what it allows. Added 2026-09-28 (round 6 review): Review said a bare "3% is more than the usual 1%".
     */
    slippageWarning: (percent: string) =>
      `You let prices move up to ${percent} (Amount › Advanced), more than the usual 1%. The deposit can take up to ${percent} more of each token, and a swap can return ${percent} less.`,
    inRange: 'Today’s price is inside this range.',
    outOfRange: 'Today’s price is outside this range, so the position won’t earn fees until the price moves into it.',
    stale: 'The pool price was read more than 5 minutes ago on this page.',
    /** The review step's own line: it is the last one, and its action is Create position (StageReview.tsx FinalControl). */
    final: 'Press Create position, then confirm each step in your wallet.',
    /** Create position with nothing to create: a choice is missing, or the pool is one positions are not created in. */
    notReady: 'Complete the steps above.',
    /** Final control while its chunk loads, if it cannot load, and in builds without a wallet (StageReview.tsx FinalControl). */
    loading: 'Loading the wallet steps…',
    loadFailed: 'The wallet steps could not load. Reload the page to try again.',
    noWallet: 'Creating a position needs a wallet, which isn’t available here.',
    /** 2026-10-05: a pool of another network opens through Domino V2 only; this page could not load it. */
    otherNetwork: 'This page couldn’t load what opens positions on this network. Reload the page and try again.',
    /** Words before an estimate: the one-token plan's amounts after its swap. */
    about: 'About',
    /**
     * The wallet steps Create position asks for, in order (walletSteps in
     * journey.ts, components/create/CreatePosition.tsx): an exact approval for
     * each token whose allowance is short, the deposit of both tokens to
     * Domino V1's setup contract, and the mint of the position NFT to the
     * wallet. Native ETH needs no approval: it travels with the deposit. A
     * step that concerns one token is drawn with its symbol after the title
     * ("Approve USDG").
     */
    approveStep: 'Approve',
    approveStepDetail: 'Lets Domino use this exact amount, never more.',
    fundStep: 'Deposit both tokens',
    fundStepDetail: 'Sends them to Domino’s contract. You can get them back until the position is created.',
    mintStep: 'Create the position',
    /**
     * One signature for every step (EIP-5792), when the wallet executes a batch whole or not at all
     * (components/create/CreatePosition.tsx; docs/plans/2026-09-25-eip5792-batches-design.md).
     */
    batchStep: 'Approve, deposit and create the position',
    /**
     * The one step's title, naming what it does (2026-09-28): an approval only when a token needs one (ETH travels
     * with the deposit), and the swap when the wallet holds one of the two tokens.
     */
    batchStepTitle: (approves: boolean, swaps: boolean) =>
      `${approves ? 'Approve, deposit' : 'Deposit'}${swaps ? ', swap' : ''} and create the position`,
    /** Under that one step on Review, before Create position is pressed (StageReview.tsx). */
    batchStepDetail: 'All in one go, with the exact amounts. Anything the range doesn’t use comes back to you.',
    batchReason: 'Your wallet asks you to sign once: every step together, or none of them.',
    /** Beside the steps when the wallet can batch only after it turns on its smart account: the person chooses. */
    batchOffer: 'Sign all steps at once',
    // Changed on purpose (2026-09-28, beginner first): no "(EIP-7702)" on the main screen; the wallet names the upgrade itself.
    batchOfferNote: 'Your wallet will first ask to turn on its smart account. Your address stays the same, and your key stays in control.',
    mintStepDetail: 'Your position arrives in your wallet. Anything the range doesn’t use comes back to you.',
    /** The deposit and the swap when the wallet holds one of the two tokens (lib/create/depositPlan.ts). */
    fundOneStep: 'Deposit',
    fundOneStepDetail: 'Sends it to Domino’s contract. You can get it back until the position is created.',
    swapStep: 'Swap part of your deposit',
    swapStepDetail: (fee: string) => `Swaps part of it for the other token in this pool. Fee: ${fee} of the swapped part.`,
    /**
     * The same step when the range takes only the other token (lib/create/journey.ts walletSteps, 2026-09-28,
     * one-sided): all of the deposit is swapped, and said so.
     */
    swapAllStep: 'Swap your deposit',
    swapAllStepDetail: (fee: string) => `Swaps all of it for the other token in this pool. Fee: ${fee} of it.`,
    /** Under the headline when part of the deposit is swapped (StageReview.tsx names the two tokens before it): what the swap costs. */
    swapNote: (fee: string) => `The swapped part pays the pool’s fee and Domino’s ${fee} fee.`,
    /** The same when all of it is swapped. */
    swapAllNote: (fee: string) => `The swap pays the pool’s fee and Domino’s ${fee} fee.`,
    /** Under the swap note when the pool's liquidity figure is reported and zero (lib/create/reviewPlan.ts). Nothing is said when the figure is missing. */
    emptyPool: 'This pool is empty, so part of your deposit can’t be swapped in it. Add both tokens, or choose another pool.',
    /** Review's closed Details: the technical facts behind the position, for whoever wants them. */
    details: 'Details',
    detailRows: { ticks: 'Range in ticks', pool: 'Pool id', contracts: 'Token contracts', native: 'native' },
    /** The fee bases side by side (feeBases in journey.ts). The service row is the docs' fees page's (lib/docs/pages/reference.ts), not Review's: a direct deposit carries no Domino fee. */
    feeLabels: { pool: 'Pool trading fee', service: 'Domino service fee', swap: 'Assisted swap fee', gas: 'Network gas' },
    feeValues: { service: 'Auto-compound 2%; Domino-compound 4% of the earned fees it uses', swap: '0.65% of the amount swapped', gas: 'Paid by you' },
    feeNotes: {
      pool: 'Paid by swappers through this pool to its liquidity providers, on each trade. Not a charge to you.',
      swap: 'Only when your wallet holds one of the two tokens and part of it is swapped for the other, simulated before you sign. Not added on top of the service fee.',
      // Changed on purpose 2026-10-01 (audit E24): Review shows no gas figure; the wallet shows the network fee.
      gas: 'Paid by you; your wallet shows the network fee before you sign.',
    },
    /**
     * The swap through Uniswap's router instead of this pool (finance/routedSwap.ts), when the onboarding service offers
     * a better one: what Review says of it (StageReview.tsx). Moved here 2026-10-01 (audit E20) from words written in the
     * component, in plain words: no "router", no "price impact" on screen, and no "guaranteed".
     */
    routed: {
      approveStep: 'Approve the exact swap amount',
      approveDetail: 'Only if your allowance is short. A reset may ask you to confirm once more.',
      permitStep: 'Allow this one swap through Uniswap',
      permitDetail: 'The exact amount, until a deadline.',
      swapStep: 'Swap through Uniswap',
      swapDetail: (fee: string) => `${fee} fee on what you receive, once.`,
      approveOnlyIfShort: 'Only if your allowance is short.',
      batchStep: 'Approve, swap and create the position',
      lead: 'Swap',
      via: 'through Uniswap.',
      unfilled: 'This pool can’t fill this swap.',
      better: (percent: string) => `About ${percent}% more than in this pool.`,
      atLeast: 'You receive at least',
      afterFee: 'after the fee.',
      feeLead: 'Fee:',
      feeOnce: (fee: string) => `(${fee}, once).`,
      keep: 'The position uses that least amount; anything more you receive stays in your wallet.',
      sequential: 'Confirm each step separately. If you stop after the swap, what you received stays in your wallet; the swap and its fee are not undone. Creating the position adds no second swap fee.',
      feeRow: (fee: string) => `${fee} of what you receive, once. No assisted-swap fee on the deposit as well.`,
      /** For the closed Details only: how far the swap moves Uniswap's price, as the route reported it. */
      impact: (percent: string | null) => (percent === null ? 'Not reported' : `${percent}%`),
      impactLabel: 'Price change from the swap',
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
