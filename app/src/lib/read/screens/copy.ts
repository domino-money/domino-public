/**
 * Every English sentence the read screens show, in one place.
 *
 * The default build ships none of it: this module is reached only from the
 * lazily loaded screens chunk, which the sample build never emits.
 * `allCopyStrings()` lists the fixed sentences so tests/render.test.mjs can
 * prove that none of them is in dist.
 *
 * Nothing here says "current", "live", "updated" or "qualified" about a
 * provider figure, and nothing says "your" about anything read from chain.
 */
import { describeFailure, reasonText } from '../describe'
import type { ReadRoute } from '../types'
import type { AddressProblem } from './identity'
import type { IdsProblem } from './positions'
import type { ScreenOutcome } from './screenRead'

export const COPY = {
  slotFailed: 'Chain data couldn’t load. Reload the page to try again.',
  lookup: {
    heading: 'Public chain lookup',
    pillFixture: 'Fixture read',
    pillChain: 'Chain read',
    intro:
      'Look up any position NFT by its ID. This is public data at one block: it does not show that anyone controls a wallet, and nothing here can be signed or moved.',
    show: 'Show lookup',
    hide: 'Hide lookup',
    label: 'Position NFT IDs',
    hint: 'Up to 10 IDs, separated by commas, spaces or new lines.',
    submit: 'Look up positions',
    loading: 'Reading position NFTs…',
    retained: 'The cards below are from the last read that worked, with its own block and time.',
    changedIds: 'New IDs: earlier cards were cleared.',
    tokenProblems: 'Some token details couldn’t be read, so those amounts are shown in raw units.',
    tokenCap: 'Token details are read for at most 8 currencies per lookup; the rest are shown in raw units.',
  },
  card: {
    chainPill: 'Read from chain',
    publicPill: 'Public data',
    stalePill: 'Stale',
    empty: 'Empty at this block: the NFT has no position info.',
    pool: 'Pool',
    pair: 'Pair',
    fee: 'Fee tier',
    tickSpacing: 'Tick spacing',
    hooks: 'Hooks',
    noHooks: 'None (0x0000…0000)',
    range: 'Range',
    inRange: 'In range at this block',
    outOfRange: 'Out of range at this block',
    noLiquidity: 'No liquidity at this block (closed or zero)',
    pricesUnavailable: 'Prices need both tokens’ decimals; showing ticks only.',
    principal: 'Principal',
    unsettled: 'Unsettled fees (not yet collected)',
    noHistory: 'Totals from earlier collections aren’t available from public data.',
    owner: 'Owner at this block (public data)',
    ownerNote: 'An NFT owner at one block, read from chain. It proves nothing about who is using this page and enables nothing here.',
    value: 'USD value',
    valueUnavailable: 'Unavailable: no qualified price source yet.',
    manager: 'Position manager',
    snapshot: 'Snapshot',
  },
  local: {
    queueFull: 'Too many reads queued. Try again in a moment.',
    budget: 'The read took too long and was stopped.',
    incomplete: 'The reply didn’t cover every ID asked for, so nothing new is shown.',
    gate: 'Beta access expired. Reload the page to sign in to the beta.',
    gatePaused: 'The beta gate is unavailable right now. Nothing is wrong on your side.',
    access: 'An access check redirected this read. Nothing from it is shown.',
    update: 'This build can’t read the server’s reply. It needs an update.',
    identity: 'The reply was about something other than what was asked, so nothing from it is shown.',
    requestContract: 'This request isn’t allowed by the read contract, so nothing was sent.',
    network: 'The read service couldn’t be reached.',
    liveOff: 'This build doesn’t read live data.',
    serverOff: 'This server has live reads turned off.',
    restart: 'The list changed on the server and has to start again.',
  },
  selection: {
    heading: 'Chain data (read only)',
    pill: 'Reference only',
    chooseToken: 'Choose token',
    changeToken: 'Change token',
    chooseSecond: 'Choose second asset (optional)',
    changeSecond: 'Change second asset',
    choosePool: 'Choose existing pool',
    changePool: 'Change pool',
    unknownSymbol: 'Unknown symbol',
    verifiedAt: 'Verified at block',
    decimalsUnavailable: 'decimals unavailable',
    setRange: 'Set a range',
    changeRange: 'Change range',
    rangeSummary: 'Range',
    rangeSummaryNote: 'not saved, nothing is created',
  },
  picker: {
    tokenTitle: 'Choose a token from chain data',
    tokenDescription: 'Paste a token contract address, or list the tokens held by a public address.',
    pairTitle: 'Choose the second asset',
    pairDescription: 'A position holds two assets. Pick the one to pair with the first.',
    poolTitle: 'Choose an existing pool',
    poolDescription: 'Pools that already exist for this token, in a neutral order. Nothing here is a recommendation.',
    back: 'Back to pair',
    useToken: 'Use this token',
    useAsset: 'Use this asset',
    usePool: 'Use this pool',
    nativeNote:
      'Native ETH has the address 0x0000…0000. Wrapped ETH is a separate ERC-20 contract at its own address. They are different assets, and their pools are different pools.',
    secondNote: 'Liquidity is always a pair: the pool trades one asset against the other, and a position holds some of each.',
    pasteLabel: 'Token contract address',
    pasteHint: '0x followed by 40 hexadecimal characters. Sent exactly as typed.',
    check: 'Check address',
    checking: 'Checking…',
    walletToggle: 'List tokens from a public address',
    walletPill: 'Public lookup, not your wallet',
    walletPublicNote:
      'Balances are public chain data on Robinhood Chain (4663) at one block. Listing an address isn’t proof that anyone here owns or controls it, and it enables nothing.',
    walletLabel: 'Public address to list tokens from',
    walletTokensLabel: 'Token addresses to check (up to 10)',
    walletTokensHint: 'Optional. Separated by commas, spaces or new lines.',
    walletSubmit: 'List tokens',
    walletEmpty: 'This server can’t list tokens by itself. Add token addresses to check.',
    walletCapped: 'Showing the first 5 pages.',
    walletRestarted: 'The list restarted from the first page. Rows marked “from earlier list” haven’t been seen again yet.',
    walletExhausted: 'The list changed again while restarting. Restart it when you’re ready.',
    walletExpired: 'The page handle has expired, so Load more starts the list again.',
    restartList: 'Restart list',
    loadMore: 'Load more',
    allLoaded: 'All pages loaded',
    fromEarlier: 'from earlier list',
    candidates: 'Tokens found',
    filterLabel: 'Find by address',
    filterHint: 'Hex characters of the address only; symbols are never searched.',
    noMatch: 'No loaded token has that address.',
    selectedHidden: 'Selected, hidden by the filter:',
    noContract: 'Not selectable: no contract at this address.',
    notReadable: 'Not selectable: the token couldn’t be read',
    sameAsFirst: 'Not selectable: this is the first token.',
    walletUnavailable: 'Not selectable: its balance couldn’t be read.',
    poolsLoading: 'Reading existing pools…',
    poolsLegend: 'Existing pools',
    rejectedHeading: 'Rejected candidates (not selectable)',
    catalogueHeading: 'Stored pool catalogue',
    catalogueLoad: 'Load catalogue candidates',
    catalogueNote: 'Catalogue candidates cover a configured block interval only. Verify one at the latest block before it can be chosen.',
    verify: 'Verify at the latest block',
    verified: 'Verified',
    catalogueRestarted: 'The catalogue changed during the read, so it restarted from the first page.',
    catalogueEmpty: 'No catalogue candidates in the configured interval. That isn’t proof that none exist.',
    newPool:
      'Opening a brand-new pool is a separate, advanced path. It isn’t available here, and nothing on this screen can create, fund or sign anything.',
    aprUnavailable: 'Pool APR unavailable: reconciled fee history unavailable.',
    needsAdapter: 'Needs a separate adapter',
    hookless: 'No hooks, fixed fee',
    providerConflict: 'Provider figures rejected: the provider’s currencies conflict with the chain.',
    partialMetadata: 'Token metadata partial',
    noOptions: 'No verified pool was found in these sources. That isn’t proof that none exists.',
  },
  range: {
    title: 'Range on this pool',
    description: 'A range drawn on this pool’s price as read, at one block. Nothing is quoted, created, approved or signed.',
    use: 'Use this range',
    pill: 'Not executable',
    partialPill: 'Partial',
    stalePill: 'Stale',
    priceHeading: 'Pool price read from chain',
    checked: 'The pool’s tick agrees with its square-root price at this block.',
    partial: 'Token metadata is partial: a symbol may be missing, so both addresses are shown. The price uses the decimals read from chain.',
    stale: 'This price was read more than 5 minutes ago on this page, and the pool’s price has probably moved since.',
    reread: 'Read the price again',
    rereading: 'Reading the price…',
    notReturned: 'The pools route did not return this pool again, so its price wasn’t updated.',
    unavailableTitle: 'Pool price unavailable',
    noControls: 'Range controls need a price read from chain, so this pool has none.',
    problems: {
      not_initialized: 'The pool has no price at this block.',
      tick_mismatch: 'The pool’s tick and square-root price don’t agree, so neither is used.',
      decimals_unknown: 'A price needs both tokens’ decimals, and at least one couldn’t be read.',
      beyond_display: 'The price is too large or too small to write as a plain number.',
    },
    width: 'Range width',
    custom: 'Custom',
    minPrice: 'Min price',
    maxPrice: 'Max price',
    spacingHint: 'Each step is one tick spacing. v4 positions start and end on multiples of it.',
    thumbHint: 'The handle shows the distance from the pool price.',
    inside: 'The pool price at this block is inside this range.',
    below: 'The pool price at this block is below this range.',
    above: 'The pool price at this block is above this range.',
    beyondDisplay: 'beyond display',
    note:
      'An illustration of a range, not a quote or an order: there are no amounts, no swap, no approval, no signature and no wallet here.',
  },
  figures: {
    open: 'figures',
    qualified: 'Qualified 24h',
    notQualified: 'Not qualified',
    notQualifiedDetail: 'Domino’s own 24h figures for this pool aren’t usable yet: they need a qualified USD price source.',
    reference: 'Reference analytics, not current',
    referenceDetail: 'Calculated for reference only. Never shown in the table.',
    provider: 'Provider figures',
    providerDetail: 'Provider-reported, not reconciled with chain data. Retrieval age isn’t proof of a complete 24h window.',
    activity: 'Pool age and coverage',
    activityLoading: 'Reading pool activity…',
    caveat: 'Pool APR describes a pool, not a position. It isn’t a forecast or a return on a deposit.',
    done: 'Done',
    legend: 'About these figures',
    turnoverPending: 'Volume over TVL from provider figures waits on a decision about derived figures.',
  },
} as const

type Leaves<T> = T extends string ? T : { [K in keyof T]: Leaves<T[K]> }[keyof T]

function leaves(value: unknown, out: string[]): string[] {
  if (typeof value === 'string') out.push(value)
  else if (value && typeof value === 'object') for (const inner of Object.values(value)) leaves(inner, out)
  return out
}

/** Every fixed sentence above of 12 characters or more, once each. */
export function allCopyStrings(): Array<Leaves<typeof COPY>> {
  return [...new Set(leaves(COPY, []))].filter((text) => text.length >= 12) as Array<Leaves<typeof COPY>>
}

export const ADDRESS_PROBLEM: Record<AddressProblem, string> = {
  empty: 'Enter a token contract address.',
  line_break: 'The pasted text contains a line break. Paste just the address.',
  whitespace: 'Remove the spaces.',
  prefix: 'Addresses start with lowercase 0x.',
  hex: 'Only 0–9 and a–f can follow 0x.',
  length: 'An address has 40 hexadecimal characters after 0x.',
}

export const IDS_PROBLEM: Record<IdsProblem, string> = {
  empty: 'Enter at least one position NFT ID.',
  not_decimal: 'NFT IDs are whole numbers written with digits only.',
  leading_zero: 'IDs are written without leading zeros.',
  too_large: 'That ID is larger than any NFT ID can be.',
  duplicate: 'Each ID can appear only once.',
  too_many: 'Up to 10 IDs at a time.',
}

const SCREEN_REASONS: Record<string, string> = {
  derived_figure_pending_q8: 'volume over TVL from provider figures waits on a decision about derived figures',
  no_provider_figures: 'no provider figures in this reply',
}

/** Contract reason codes and this screen's own, as words. */
export const screenReason = (code: string | null | undefined) => (code && SCREEN_REASONS[code]) || reasonText(code)

export type Subject = 'positions' | 'token' | 'wallet' | 'pools' | 'catalogue' | 'activity'

const SUBJECT: Record<Subject, string> = {
  positions: 'Position',
  token: 'Token',
  wallet: 'Wallet',
  pools: 'Pool',
  catalogue: 'Catalogue',
  activity: 'Pool activity',
}

export interface ScreenText {
  /** The state behind it, for tests and styling. */
  code: string
  title: string
  detail: string
  /** Whether asking again could help. */
  retry: boolean
}

export type ScreenFailure = Exclude<ScreenOutcome<ReadRoute>, { state: 'ok' }> | { state: 'incomplete_reply' }

/** What a failed read says on a read screen. Gate states never offer a wallet sign-in. */
export function failureText(outcome: ScreenFailure, subject: Subject): ScreenText {
  const name = SUBJECT[subject]
  switch (outcome.state) {
    case 'gate_required':
      return { code: outcome.state, title: 'Beta access expired', detail: COPY.local.gate, retry: false }
    case 'gate_unavailable':
      return { code: outcome.state, title: 'Access is paused', detail: COPY.local.gatePaused, retry: true }
    case 'access_required':
      return { code: outcome.state, title: 'Blocked by an access check', detail: COPY.local.access, retry: false }
    case 'incompatible':
      // A mismatch the read service reports about its own upstream reply is
      // the server's, never this app's: it is not an update the visitor needs.
      if (outcome.reason === 'upstream_contract_mismatch') {
        return { code: outcome.state, title: `${name} data unavailable`, detail: 'The read service reported a contract mismatch for this read, so nothing is shown.', retry: true }
      }
      // Otherwise deliberately the same words as a reply that fails validation:
      // to a person both mean this build needs an update, and screens.test.mjs
      // pins that. The state still differs in `code`.
      return { code: outcome.state, title: 'Update needed', detail: COPY.local.update, retry: true }
    case 'invalid':
      if (outcome.reason === 'identity_mismatch') return { code: outcome.state, title: 'Wrong answer', detail: COPY.local.identity, retry: true }
      if (outcome.reason === 'request_contract') return { code: outcome.state, title: 'Not sent', detail: COPY.local.requestContract, retry: false }
      return { code: outcome.state, title: 'Update needed', detail: COPY.local.update, retry: true }
    case 'unavailable': {
      const cause = outcome.cause
      switch (cause.kind) {
        case 'producer':
          if (cause.code === 'activity_pool_not_registered') {
            return { code: outcome.state, title: 'Activity isn’t indexed for this pool', detail: 'The read service answered: activity pool not registered.', retry: outcome.retryable }
          }
          return { code: outcome.state, title: `${name} data unavailable`, detail: `The read service answered: ${reasonText(cause.code)}.`, retry: outcome.retryable }
        case 'network':
          return { code: outcome.state, title: `${name} data unavailable`, detail: COPY.local.network, retry: true }
        case 'edge':
          return { code: outcome.state, title: `${name} data unavailable`, detail: `The network edge answered with an error page (HTTP ${cause.status}).`, retry: true }
        case 'queue_full':
          return { code: 'queue_full', title: 'Busy on this page', detail: COPY.local.queueFull, retry: true }
        case 'read_deadline':
          // Never worded as retries used up: a deadline stops a read that was
          // still going. R-1 has two, and they are not the same event as the
          // screen's own budget, which has its own state and its own words.
          return {
            code: outcome.state,
            title: cause.limit === 'attempt' ? 'One attempt timed out' : `${name} data unavailable`,
            // The same words slice A already ships in describe.ts: a reader
            // should not meet two descriptions of one event.
            detail:
              cause.limit === 'attempt'
                ? 'The read service did not answer within 20 s, so the read was stopped.'
                : 'Stopped after 60 s, time spent queued included.',
            retry: true,
          }
        default:
          return cause satisfies never
      }
    }
    case 'busy':
      return { code: outcome.state, title: 'Read service busy', detail: `Try again in ${outcome.retryAfterSeconds} s.`, retry: true }
    case 'restart_required':
      return { code: outcome.state, title: 'The list changed', detail: COPY.local.restart, retry: true }
    case 'request_rejected':
      return { code: outcome.state, title: 'Request refused', detail: `The server refused this request (${reasonText(outcome.code)}, HTTP ${outcome.status}).`, retry: false }
    case 'disabled':
      return {
        code: outcome.state,
        title: `${name} reads are off`,
        detail:
          outcome.reason === 'route_not_enabled'
            ? `${name} reads aren’t enabled on this server.`
            : outcome.reason === 'live_data_disabled'
              ? COPY.local.liveOff
              : COPY.local.serverOff,
        retry: false,
      }
    case 'not_connected': {
      // The site's own /api layer answered instead of the read bridge. The app
      // already has words for each reason; a screen says the same thing.
      const said = describeFailure(outcome)
      return { code: outcome.state, title: said.title, detail: said.detail, retry: said.retry }
    }
    case 'aborted':
      return { code: outcome.state, title: '', detail: '', retry: false }
    case 'local':
      return { code: outcome.code, title: 'Stopped', detail: COPY.local.budget, retry: true }
    case 'incomplete_reply':
      return { code: outcome.state, title: 'Incomplete reply', detail: COPY.local.incomplete, retry: true }
    default:
      return outcome satisfies never
  }
}
