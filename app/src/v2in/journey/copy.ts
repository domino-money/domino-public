/**
 * New position's words where it runs Domino's new contracts (the integrated journey, 2026-10-02): the steps keep the
 * journey's own titles and voice (lib/create/copy.ts CREATE), and these sentences cover what only the zap does. Sentences
 * the spec quotes (F7 rev2/rev3 §1.5, §2.4, §2.6, §2.7, §2.8, §2.9, §2.11, §2.12) are used exactly as written (decision
 * #29); the rest is plain words for a person who knows nothing about liquidity positions. No "V2" anywhere: the person
 * sees New position, on Robinhood Chain (no network choice: the owner, 2026-10-02). The Uniswap version is never a word
 * on screen (the lists' rule, lists/parts.tsx), apart from the pool finder's own control, which finds a pool by it.
 */
export const JOURNEY = {
  step: {
    /** The pool step's lead on a network where the person names the pool. */
    poolLead: 'Choose the two tokens, then one of their pools.',
    amountLead: 'Enter an amount in either token, or both. Domino swaps for you when needed.',
    amountLeadOther: 'Pay with another token. Domino swaps it for the pool’s tokens.',
    reviewLead: 'Check your position, then confirm in your wallet.',
  },
  pool: {
    find: 'Find a pool',
    findLead: 'Pick two tokens, the Uniswap version and the fee. The pool is read through your wallet.',
    tokenA: 'First token',
    tokenB: 'Second token',
    otherAddress: 'Another token (address)',
    otherAddressHint: 'Paste the token’s address. Its name is shown as the token says it, and it is not checked.',
    version: 'Uniswap version',
    tier: 'Fee tier',
    read: 'Check this pool',
    reading: 'Reading the pool through your wallet…',
    noPrice: 'This pool has no price yet.',
    unsupported: 'This pool isn’t supported.',
    sameToken: 'Choose two different tokens.',
    decimalsUnknown: 'This token doesn’t say how many decimals it has, so it can’t be used here.',
    /** Another network's token chosen in today's journey with no wallet connected (2026-10-05, ./otherChains.ts). */
    connectFor: (chain: string) => `Connect your wallet to see the pools on ${chain}.`,
    /** Its S1 gate closed while the page was open. */
    networkClosed: (chain: string) => `New positions on ${chain} aren’t open right now.`,
    /**
     * Added 2026-10-06: a search hit on Base or Arbitrum One whose symbol is one of the network's own currencies' but whose
     * address is not (./model/chainReads.ts lookalikeOf): listed with this line, never chosen. Today's search says the same.
     */
    lookalike: (main: string) => `Not the ${main} Domino uses`,
    connectFirst: 'Connect a wallet to read a pool on this network.',
    change: 'Change pool',
    readAt: (block: string) => `Read at block ${block}`,
    fromList: 'From the list',
    /** Robinhood Chain, while its listed pools keep today's steps: a pool today's journey cannot open. */
    findOther: 'Find a pool by its tokens',
    backToList: 'Back to the pool list',
    /** Under "Create a new pool (advanced)" at the foot of the pool step. */
    advancedLead: "A pool Domino doesn't list yet, or one that doesn't exist: pick its two tokens, the Uniswap version and the fee, and Domino reads it through your wallet. A pool with no price yet can be created here.",
    listed: 'This pool is in the list: it opens with today’s steps.',
    takeListed: 'Use this pool',
    pickedWallet: 'Read through your wallet',
  },
  newPool: {
    lead: 'Nobody has set a price for this pool yet. You set its starting price with your first deposit.',
    start: 'Set a starting price',
    price: 'Starting price',
    base: 'Price of',
    in: (base: string, quote: string) => `${quote} per 1 ${base}`,
    both: (a: string, b: string) => `${a} · ${b}`,
    tick: 'Starting tick',
    sqrt: 'Starting sqrt price',
    roundTrip: 'From the exact value',
    invalid: 'Check the starting price.',
    gas: 'Creating a pool costs more network fee than a usual deposit.',
    needed: 'Set a starting price to continue.',
  },
  range: {
    start: 'Starting price',
    ticksOnly: 'This pool’s prices can’t be written here: its range is shown in ticks.',
  },
  amount: {
    payWith: 'Pay with',
    poolTokens: 'This pool’s tokens',
    otherToken: 'Another token',
    otherChoice: 'Token to pay with',
    none: 'Enter an amount in at least one token.',
    invalid: 'Enter a number, like 100 or 0.5.',
    rawUnits: 'raw units',
    ethDirect: 'Paying with ETH needs a direct transaction.',
    slippageInvalid: 'Choose between 0.1% and 5%.',
  },
  review: {
    /**
     * Said under Create position (FinalControl's line) while the same choices are quoted again; a first quote,
     * final.reasonQuote. Changed on purpose 2026-10-06 (the review of point 4): no longer "The price moved. …", which
     * was said of every new quote, also of one that only ran out or followed a cancelled signature.
     */
    requoting: 'Getting a fresh quote…',
    network: 'Network',
    pool: 'Pool',
    youPut: 'You put in',
    route: 'Swap',
    expected: 'Expected',
    atLeast: 'At least',
    asQuoted: 'as quoted',
    /**
     * Changed on purpose 2026-10-06 (the owner's point 4: little text): Review's one fee line, in spec §2.8's words,
     * "Domino fee: 3.25 USDG (0.65% of 500 USDG swapped)" (ReviewStage.tsx puts the label, the amount and the base
     * together), or "No Domino fee". The receipt says the exact fee.
     */
    fee: 'Domino fee',
    feeBase: (swapped: string) => `0.65% of ${swapped} swapped`,
    noFee: 'No Domino fee',
    smaller: (percent: string) => `If the price moves within your slippage, your position can be up to ${percent}% smaller. The rest returns to your wallet.`,
    leftovers: 'Comes back to your wallet',
    leftoversNone: 'Nothing',
    /**
     * Changed on purpose 2026-10-06 (the owner's point 4): ONE network fee line on Review ("Network fee: about 0.00022
     * ETH", present.ts networkFeeLine: the plan's cost and the approvals still to send), its ceiling and its L1 data fee
     * under Details; no fee on each wallet step. Changed on purpose 2026-10-06 (the review of point 4: no jargon and no
     * bare dash in view): a part that could not be read is `networkMore`, after the figure ("…, plus a little more your
     * wallet shows before you confirm"); Details' ceiling still names it, "+ other steps —". A fee with no figure at all
     * (a signature comes first, or nothing may be checked before a box is ticked) is `networkLater`, in words.
     */
    networkFee: 'Network fee',
    networkAbout: (eth: string) => `about ${eth}`,
    networkUpTo: (eth: string) => `up to ${eth}`,
    networkUnknown: 'Your wallet shows it before you confirm',
    networkLater: 'your wallet shows it before you confirm',
    networkMore: 'plus a little more your wallet shows before you confirm',
    networkOthers: 'other steps',
    /** Base's ceiling, under Details: a label of its own, not a second "Network fee" beside the one in view. */
    networkCeiling: 'Network fee, at most',
    l1Fee: 'L1 data fee',
    l1Unavailable: 'Not available right now',
    deadline: 'Good for',
    deadlineValue: (span: string) => `${span}, then a new quote`,
    signedFor: (span: string) => `What you sign stays valid for ${span}.`,
    /** Shown for a v3 pool only (ReviewStage.tsx): the version is never a word on screen. */
    wethWarning: 'On this pool, unused ETH comes back as WETH.',
    ethDirect: 'Paying with ETH needs a direct transaction.',
    feesSent: 'Uncollected fees will also be sent to your wallet.',
    approvalStays: 'Domino can manage this position for you when you ask. You can revoke this on the position afterwards.',
    replacesApproval: 'This replaces another app’s permission on this position.',
    planUnavailable: 'The planning service isn’t available yet.',
    planInvalid: 'The quote came back in a form this app does not accept.',
    /**
     * A wallet short of the amount, said once, in Review's view (Changed on purpose 2026-10-06, the review of point 4: it
     * was the small line under Create position only): native ETH counted after the network fees Review keeps back, as
     * today's Review says it, and the two ways on: bringing the token from another network only where Amount's offer can
     * bring it (`bring`), else adding it to the wallet, today's Review's own words.
     */
    walletShort: (have: string, need: string, token: string, afterFees: boolean, bring: boolean) =>
      `Your wallet has ${have}${afterFees ? ' after network fees' : ''}; this position needs ${need}. Lower the amount, or ${bring ? `bring ${token} from another network` : `add ${token} to your wallet`}.`,
    /** Today's journey on Domino V2 (./JourneyCreateV2.tsx): the plan is asked for the signed-in wallet only. */
    signInForQuote: 'Sign in with your wallet to get the quote. Signing in moves nothing.',
    signIn: 'Sign in',
    custody: 'Your position stays in your wallet. Each action is a single transaction. Domino’s contract keeps nothing afterwards.',
    reviewAgain: 'Review again',
  },
  /**
   * The wallet's steps on Review, by their titles. Changed on purpose 2026-10-06 (the owner's point 4: little text): the
   * line under each step is its live state only once Create position runs ("Confirm in your wallet"); the sentences that
   * explained each step before (an exact amount, a signature good for 5 minutes, one confirmation for all) are the
   * wallet's own prompt and the docs' (lib/docs/pages/introduction.ts), no longer a line on every step.
   */
  steps: {
    resetAllowance: (token: string) => `Reset the ${token} permission to zero`,
    allow: (amount: string) => `Allow ${amount}`,
    allowForSigning: (amount: string) => `Allow ${amount} for signing`,
    signPermit: 'Sign the deposit',
    batch: 'Approve and create the position, all at once',
    create: 'Create the position',
  },
  live: {
    next: 'Next',
    preparing: 'Checking…',
    wallet: 'Confirm in your wallet',
    sent: 'Waiting for the network',
    included: 'Included',
    finalized: 'Finalized',
    failed: 'Stopped',
  },
  final: {
    create: 'Create position',
    creating: 'Creating position…',
    created: 'Position created',
    reasonSteps: 'Your wallet will ask you to confirm each step.',
    reasonBatch: 'Your wallet asks you to confirm once: every step together, or none of them.',
    reasonBusy: 'Confirm in your wallet.',
    /** A step that failed on a reviewed plan, said only while Create position can be pressed again (ReviewStage.tsx reasonOf). */
    reasonAgain: 'Press Create position to try again.',
    /**
     * Added 2026-10-06 (the final check's F5, a second look): a quote that failed before any review leaves nothing to press;
     * the failure itself is said above, in Review's body, and Review again (review.reviewAgain), an outline button under
     * this line, asks the quote again.
     */
    reasonNoQuote: 'No quote yet.',
    reasonQuote: 'Getting a quote…',
    /** A wallet short of the amount: why Create position waits (Review says what it has and needs, above). */
    reasonShort: 'Your wallet doesn’t have enough for this amount.',
    reasonTick: 'Tick the box above first.',
    reasonNoWallet: 'Connect a wallet to create this position.',
    /**
     * Added 2026-10-06 (the final check's F4): with no wallet, Create position's place asks for one, as today's control does
     * (components/create/CreatePosition.tsx), opening the header's wallet dialog; reasonNoWallet is the line under it.
     */
    connect: 'Connect wallet',
    /**
     * Added 2026-10-06 (the final check's F5): the wallet's balances of the pool's two tokens could not be read, so no quote
     * can be asked; `readAgain`, an outline button under the line, reads them again.
     */
    reasonUnread: 'Your balance couldn’t be read.',
    readAgain: 'Read again',
    permitReverted: 'The transaction failed on the network, so nothing moved. The signature you gave for it can still be used until it expires: cancel it before a new quote.',
    cancelSignature: 'Cancel the signature',
    keepSignature: 'Keep it and get a new quote',
  },
  created: {
    line: (tokenId: string) => `Position NFT ${tokenId} is in your wallet.`,
    pending: 'Your position is being created. Waiting for the network…',
    receipt: 'Receipt',
    paidIn: 'Paid in',
    swapped: 'Swapped',
    fee: 'Domino fee (0.65% of the amount swapped)',
    returned: 'Returned to your wallet',
    added: 'Added to the position',
    gas: 'Network fee',
    gasUnavailable: 'Not reported',
    state: 'Status',
    unreadable: 'This receipt can’t be read exactly. Nothing is guessed.',
    positions: 'Your positions',
    view: 'View position',
    /** Auto-exit beside the position's link (2026-10-06, the review of point 5), in today's created view's words. */
    recommended: 'Recommended',
    turnOn: 'Turn on',
  },
} as const
