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
    preview: 'Your position',
    /** The same card while a pool row is only pointed at in step 1, nothing chosen yet (QA round 2 N21, the owner's yes). */
    previewPointed: 'Preview',
    previewExample: 'Illustration of how a price range works',
    previewTotal: 'Estimated total',
    stepState: { done: 'done', current: 'current', upcoming: 'not started' },
    /**
     * Added 2026-10-30 (QA round 2, final review create-1): heard after a link the flow opens in a new tab, so the steps
     * already filled stay as they are; never shown (as components/pool/ExplorerAddress.tsx and the footer say it).
     */
    newTab: ' (opens in a new tab)',
  },
  /**
   * The four visual steps of the flow, over the five stages of the state machine. Changed on purpose 2026-10-06 (the
   * owner's point 4: little text, for someone who knows nothing about pools): each lead is one short line. Removed on
   * purpose 2026-10-06 (the V2 bundle budget): each step's caption, which no screen drew.
   */
  step: {
    // Changed on purpose 2026-10-01 (audit E25): the step asks for a token, then one of its pools, not two tokens.
    pool: { title: 'Pool', lead: 'Search a token, then pick a pool.' },
    range: { title: 'Range', lead: 'You earn fees while the price is in your range.' },
    // Changed on purpose 2026-10-01 (audit E13, live note L11): a range above or below today's price takes one token
    // alone, so "either token" is said only of a range around the price, and the one-token range has its own lead.
    amount: {
      title: 'Amount',
      // Changed on purpose 2026-10-30 (QA round 2, Q4): a position holds both tokens, said before the fields.
      lead: 'You add both tokens: type one, the other fills in.',
      leadOne: (symbol: string) => `This range takes only ${symbol}. Enter an amount.`,
      /** Added 2026-10-06: the deposit paid with one other token (lib/create/journey.ts PayWith). */
      leadPay: (symbol: string) => `Pay with ${symbol}. Domino swaps it for the pool’s tokens.`,
    },
    review: { title: 'Review', lead: 'Check your position, then confirm in your wallet.' },
  },
  /**
   * The state machine's stages: `short` labels the plain-text summary lines. Removed on purpose 2026-10-06 (the V2 bundle
   * budget, tests/session.bundle.test.mjs): each stage's title and lead, which no screen drew (the steps say theirs, `step`).
   */
  stage: {
    token: { short: 'Token' },
    pool: { short: 'Pool' },
    amount: { short: 'Amount' },
    balance: { short: 'Balance' },
    review: { short: 'Review' },
  },
  token: {
    needToken: 'Choose a token to continue.',
    notSelectable: 'The chosen token cannot be deposited: it could not be read.',
    // Removed on purpose 2026-10-30 (QA round 2, N33/N102): the search's label and placeholder, now the one pair every
    // search uses (components/read/screens/TokenSearch.tsx SEARCH_LABEL, SEARCH_PLACEHOLDER).
    /**
     * Added 2026-10-30 (QA round 2 sweep): a network whose creation gate is closed, in the gate's own words (the V2
     * journey's JOURNEY.pool.networkClosed), never that creating there "is unavailable". Its pools can still be explored.
     */
    networkClosed: (chain: string) => `New positions on ${chain} aren’t open right now.`,
    exploreStill: 'You can still explore its pools.',
    preselectHeading: 'Pool from the link',
    preselectChecking: 'Verifying the linked pool on Robinhood Chain…',
    preselectVerified: 'Pool selected.',
    // Changed on purpose 2026-10-30 (QA round 2 sweep): plain words, nothing about the read service.
    preselectNotFound: 'This pool wasn’t found. Search for a token to choose a pool.',
    preselectMalformed: 'The link does not carry a valid pool id, so nothing is preselected.',
    // A pool the featured list withdrew by a safety rule (featured pools v1 §11.5), or one with a token that passes for a
    // main token (audit I1), opened by a link. Since 2026-10-01 (audit B2) a pool that left the list only because its
    // figures were unavailable is preselected as any other, so this line is said for safety reasons alone.
    preselectWithdrawn: 'For safety, Domino doesn’t open positions in this pool. Choose another pool.',
    nativeNote: 'Native ETH is its own currency at address 0x0000…0000. Wrapped ETH is a separate contract at its own address. Their pools are different pools.',
    /**
     * Added 2026-10-30 (QA round 2, N19): the heading over the list's pools under the search, as Home and Markets name the
     * same list (lib/read/featuredList.ts featuredTitle), without "· last 24h": these rows show no 24h figures.
     */
    topPools: (server: boolean) => (server ? 'Top pools' : 'Selected pools'),
  },
  pool: {
    needPool: 'Choose a pool to continue.',
    poolMismatch: 'The chosen pool does not hold the selected token. Choose another pool.',
    /** A pool Domino V1's setup contract does not open positions in (DominoSetup.open refuses hooks; a dynamic fee has no fixed key). */
    unsupportedHooks: 'This pool has hooks, and positions can only be created here in pools without hooks. Choose another pool.',
    unsupportedDynamic: 'This pool has a dynamic fee, and positions can only be created here in pools with a fixed fee. Choose another pool.',
    // Changed on purpose 2026-10-06 (the owner's point 4): the chosen pool's "Verified at block" tooltip is gone.
    /** The chosen pool's fee, as every fee chip says it (lib/format/fee.ts, audit E21): "Uniswap · 0.30% fee". */
    fee: (fee: string) => feeChipText(fee),
    change: 'Change pool',
    keep: 'Keep this pool',
  },
  amount: {
    entered: 'You enter',
    // Changed on purpose 2026-10-30 (QA round 2, Q4): the other panel is needed too, not optional.
    paired: 'Also needed, worked out for you',
    total: 'Estimated total',
    // Changed on purpose 2026-10-06 (the owner's point 4: little text): the total's note in a few words. Network fees are
    // paid in ETH on top, never taken from the position, so they are "extra", not something the total is "before".
    // Changed on purpose 2026-10-30 (QA round 2, N37 c): and which token pays them (ETH on all three networks).
    totalNote: 'Network fees are extra, paid in ETH.',
    totalOneNote: 'Network fees are extra, paid in ETH.',
    totalSwapNote: 'After the swap; network fees are extra, paid in ETH.',
    /**
     * Added 2026-10-30 (QA round 2, N51, the owner's yes above 10%): the deposit's share of the pool, said plainly beside the
     * total, never as a warning. Q20: an amount above everything the pool holds asks for a second look instead.
     */
    poolShare: (percent: string) => `You’d be about ${percent} of this pool.`,
    beyondPool: 'That is more than this whole pool holds. Check the amount.',
    /** Added 2026-10-30 (QA round 2, N54, the owner's US$ 1 minimum): the Continue reason below it. */
    tooSmall: 'Enter at least $1. Smaller amounts cost more in network fees than they earn.',
    /** The same for a pool with no USD price, when the amount rounds to nothing in one of its tokens. */
    tooSmallUnpriced: 'This amount is too small for this pool. Enter a larger one.',
    /**
     * Added 2026-10-30 (QA round 2, N99): a decimal comma, said plainly instead of the generic format line. Since
     * 2026-11-02 (review M4): where the person's language writes decimals with a dot (./typedFigure.ts FIGURE_TEXT, the
     * same words, says the other comma problems).
     */
    decimalComma: 'Use a dot for decimals, like 0.5.',
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
    // Changed on purpose 2026-10-06 (the owner's point 4: little text): what each width means, in one short line; the
    // wider range keeps its cost, so it never reads as simply better. Changed on purpose 2026-10-30 (QA round 2, Q30 and
    // N74, the owner's approved words): literal lines, no idioms ("window", "spread thinner"), each saying how the width
    // changes what it earns.
    widthLines: {
      standard: 'Earns more per dollar, but the price leaves it sooner.',
      wide: 'Stays in range longer, earns less per dollar.',
      custom: 'Set your own lowest and highest price.',
    },
    lowest: 'Lowest price',
    highest: 'Highest price',
    below: (percent: string) => `${percent} below today`,
    above: (percent: string) => `${percent} above today`,
    /** (QA round 2, the owner's find) An end more than 10,000% above today (lib/create/plain.ts FAR_PERCENT). */
    farAbove: (percent: string) => `More than ${percent} above today`,
    atToday: 'At today’s price',
    /** A bound's buttons, for assistive technology. */
    lowerBy: (label: string) => `Lower the ${label.toLowerCase()}`,
    raiseBy: (label: string) => `Raise the ${label.toLowerCase()}`,
    // Changed on purpose 2026-10-06 (the owner's point 4: little text): what a range beside today's price means, in one
    // short line; that it takes one token alone is said where the amount is typed (step.amount.leadOne, pairOneSided).
    rangeOut: {
      below: 'No fees until the price rises into this range.',
      above: 'No fees until the price falls into this range.',
    },
    rangeIn: 'Today’s price is inside this range.',
    /** The preview's calm word for a range beside today's price (PositionPreview.tsx, 2026-09-28, one-sided): no red alarm. */
    earnsInRange: 'Earns once the price is in range',
    // Changed on purpose 2026-10-30 (QA round 2, N36): a typed price moves outward, never to the nearest step.
    customHint: 'Type a price or drag. It moves a little outward, to the closest price the pool allows.',
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
    // Changed on purpose 2026-10-30 (QA round 2, N28): the Continue reason while the box holds no usable tolerance, in plain words.
    slippageInvalid: 'Choose a slippage tolerance from 0.1% to 5% under Advanced.',
    slippagePresets: 'Common tolerances',
    /** Setup's draft and its swap, when the box holds nothing the bound admits. */
    slippageRequired: 'Choose a slippage limit from 0.1% to 5%.',
    slippageExact: 'Exact percentage',
    slippageExactInvalid: 'Enter a percentage from 0.1 to 5, with up to two decimal places.',
    /**
     * Above 2% (lib/create/slippage.ts SLIPPAGE_WARN_ABOVE_BPS): said, never blocked, beside the slider, on Setup and on
     * Review. Changed on purpose 2026-10-06 (the owner's point 4: one rule everywhere): the spec's line and threshold
     * (F7 §2.9, the owner's decision #29), as Domino V2's journey and position dialogs say it, instead of this flow's own
     * longer sentence above 1%.
     */
    slippageWarning: 'High slippage: you may receive noticeably less than quoted.',
    rangeHeading: 'Price range',
    maxLabel: 'Max',
    /**
     * Added 2026-10-31 (QA round 2 follow-ups, free-amounts; the owner: "tem que ter a opção de preencher de forma
     * automática"): beside the amount typed second, once both are typed; it works that amount out from the other again.
     */
    fillIn: 'Fill in for me',
    connectForBalance: 'Connect a wallet to see your balance.',
    /**
     * Added 2026-10-30 (QA round 2, N22): after it, with no wallet, what the landing and the docs promise. The other-network
     * line is the funds offer's (src/v2in/funds), said only while bringing funds from another network is open (the S2 gate).
     */
    connectOneToken: 'Only have one of these tokens? Domino can swap part of it for the other.',
    /** Its link to the docs' amount step (QA round 2 review, N22). */
    connectOneTokenLink: 'How it works',
    connectOtherNetwork: 'Funds on another network? Domino can bring them over once you connect.',
    // Changed on purpose 2026-10-06 (the owner's point 4): the balance line carries no tooltip.
    balanceAt: (block: string | null) => (block ? `Balance at block ${block}:` : 'Balance:'),
    pairUnused: (symbol: string) => `At today’s price this range holds only ${symbol}. Enter the amount in ${symbol}.`,
    pairOneSided: (symbol: string) => `At today’s price this range holds only ${symbol}.`,
    pairUnreadable: 'This token can’t be read, so no amount can be entered in it.',
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
    // Removed on purpose 2026-10-06 (the V2 bundle budget): the estimate's own "your wallet does not cover" line, which
    // nothing drew any more (the amount step says it in its own words, amount.shortOf).
    hooks: 'this pool has hooks, and deposits support hookless pools only.',
    dynamicFee: 'this pool has a dynamic fee, and deposits support fixed fees only.',
  },
  /**
   * The automation choices and their limits. No step of New position shows them: Automate does, for a position that exists.
   * Removed on purpose 2026-10-06 (the V2 bundle budget, tests/session.bundle.test.mjs): the strings no screen drew any more
   * (the rule lists and their headings, the choices' names, legend and details apart from the cards' own, the limits'
   * labels, heading and hints, the successor's geometry and notes, "Not connected" and "Planned"), as the retired balance
   * line's went (tests/create-journey.test.mjs). Automate says these things in its own words.
   */
  automation: {
    /**
     * The three choices as cards: a title and one line each. Changed on purpose 2026-10-01 (audit E4): "of the fees it
     * uses", not "of earned fees consumed".
     */
    options: {
      none: { title: 'Plain position', line: 'Fees wait in the position until you collect them.' },
      compound: { title: 'Auto-compound', line: 'Fees go back into the same position. 2% of the fees it uses.' },
      domino: { title: 'Domino-compound', line: 'Fees can fund the next range one step higher. 4% of the fees it uses.' },
    },
    /* The bounds below are the contract's (PolicyValidation.sol), as LIMIT_BOUNDS in journey.ts holds them. */
    triggerInvalid: 'Trigger distance is a percentage from 0 to 20, with up to two decimal places.',
    overlapInvalid: 'Maximum overlap is a percentage from 0 to 20, with up to two decimal places.',
    capInvalid: 'The number of positions is a whole number from 1 to 255.',
    infeasible: 'The successor geometry is not feasible on this tick spacing.',
  },
  review: {
    choices: 'Your position',
    // Changed on purpose 2026-10-30 (QA round 2, one name per concept): as the amount step, the preview and V2's Review say it.
    total: 'Estimated total',
    steps: 'In your wallet',
    /** Added 2026-10-30 (QA round 2, Q31): the same section's title while no wallet is connected, as V2's Review titles it. */
    stepsConnect: 'Next: connect your wallet',
    stepsNote: 'Your wallet will ask you to confirm these, in order.',
    /**
     * Added 2026-10-30 (QA round 2, Q12): automation is added later, from Automate; the last word is the link. Changed on
     * purpose 2026-10-31 (QA round 2 follow-ups, Q12): it names Domino-compound too, as the created view and Automate offer it.
     */
    automateLater: 'You can add Auto-compound, Domino-compound or Auto-exit after the position is created, from',
    /** The same for a Full range position, which Auto-exit is not offered for (N73, the owner's decision; its review). */
    automateLaterFull: 'You can add Auto-compound after the position is created, from',
    automateLink: 'Automate',
    /**
     * The one charge Domino makes, on earned fees an automation uses. Automate states it for the mode it applies
     * (screens/Automate.tsx: "2% of the fees it uses, once"); a direct deposit carries none. Changed on purpose
     * 2026-10-01 (audit E4, live note L12): "consumed" said nothing to a beginner.
     */
    serviceFeeValue: (mode: 'none' | 'compound' | 'domino') => mode === 'none' ? 'No automation service fee' : `${mode === 'domino' ? 4 : 2}% of the fees it uses`,
    /** The slippage row of Review's Details (StageReview.tsx). */
    slippage: (percent: string) => `Slippage tolerance ${percent}`,
    // Changed on purpose 2026-10-06 (the owner's point 4): Review warns of a high slippage in the amount step's one line
    // (amount.slippageWarning, the spec's), no longer a sentence of its own.
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
