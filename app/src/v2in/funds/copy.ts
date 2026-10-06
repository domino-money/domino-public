/**
 * The words of the inline "Bring {token} from {network}" offer in New position's amount step (spec F7 §3), in English,
 * beginner-first: no jargon on the step itself, technical detail only under "Details". Where the spec quotes a sentence
 * it is v2/crosschain/copy.ts's (candidate statuses, the §3.5 lines, the tracking states, the §3.8 errors, "Add {origin}
 * to your wallet, then try again."); this file holds the labels and the sentences the spec leaves to the app. Copied on
 * purpose from the rejected #/v2 section's words (src/v2ui/s2/copy.ts, reference only) where they still fit, and
 * rewritten where the offer now sits inside an existing step. A code never appears in a sentence: it goes in a
 * data-error-code attribute.
 */
import { DECLINED_COPY } from '../../v2/errors'
import { FAILURE_COPY, NO_ROUTE, NOT_REPORTED } from '../../v2/crosschain/copy'

export const FUNDS_TEXT = {
  /**
   * The offer's title: the token the position lacks, before a network is picked. Changed on purpose 2026-10-06 (the
   * integration review: "Bring USDG from Arbitrum One" above the button "Bring 100 USDC from Arbitrum One"): once one is
   * picked, the network alone; the button says what leaves the wallet, and the quote what arrives.
   */
  title: (token: string, network: string | null) => (network ? `Bring funds from ${network}` : `Bring ${token} from another network`),
  /** The wallet holds none of the token there. */
  holdsNone: (token: string, destination: string) => `Your wallet has no ${token} on ${destination}.`,
  /** The other token, which helps only through the swap: no figure claimed. */
  cantFund: (destination: string) => `Your wallet doesn't have enough on ${destination} for this position, even with a swap.`,
  // Changed on purpose 2026-10-05 (the owner, testing it: "very hard to understand ... it has to happen behind the scenes;
  // whoever uses Domino has no experience"): one sentence, one choice of network, the rest done for the person.
  /** What the position lacks, where it is needed: "You need 0.0021 ETH more on Robinhood Chain." */
  youNeed: (amount: string, destination: string) => `You need ${amount} more on ${destination}.`,
  /** A new deposit in place of the typed one (the zap path): reviewed again. */
  asNewDeposit: (token: string) => `Use ${token} as a new deposit, then review the swap.`,
  bringFrom: 'Bring it from:',
  // Added 2026-10-06 (the owner's point 1: "only before an amount, and only when the person has money on another network";
  // "a visual sign that she has a token there and that we will bridge it"): the discreet line under the two amounts.
  /** "You have 100 USDC on Arbitrum One". */
  youHave: (amount: string, network: string) => `You have ${amount} on ${network}`,
  bringItHere: 'Bring it here',
  /** "(about $100.00)": from a qualified price only. */
  aboutUsd: (usd: string) => `(about ${usd})`,
  // Added 2026-10-06 (the owner's points 1 and 3): the short box says what each network holds, drops a network read as
  // empty, and says it once when every network read is empty.
  checkingNetworks: 'Checking your other networks…',
  nothingElsewhere: (networks: string) => `Nothing to bring from ${networks}.`,
  /** Under a network's button: what the service read there, and about how much in USD when it valued all of it. */
  holdsThere: (amounts: readonly string[], usd: string | null) => (usd === null ? `You have ${amounts.join(' · ')}` : `You have ${amounts.join(' · ')} (about ${usd})`),
  /** A network holding tokens and no ETH to send them (the owner's point 7: no transaction that cannot go through). */
  noGasHint: (tokens: string) => `${tokens} there, but no ETH for the network fee`,
  noGasThere: (tokens: string, network: string) => `You have ${tokens} on ${network}, but no ETH there to pay the network fee.`,
  otherNetworks: 'Other networks',
  /** "Base or Arbitrum One", "Robinhood Chain, Base or Arbitrum One". */
  orList: (names: readonly string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : (names[0] ?? '')),
  signingIn: "Sign in with your wallet to continue. This doesn't move funds.",
  signInFirst: 'Sign in with your wallet to bring funds from another network.',
  /** Added 2026-10-06 (the integration review: a closed sign-in dialog left nothing to press): opens the wallet's dialog. */
  signIn: 'Sign in',
  switchingTo: (network: string) => `Switching your wallet to ${network}…`,
  checking: (network: string) => `Checking your balance on ${network}…`,
  finding: 'Finding the best route…',
  noneThere: (tokens: string, network: string) => `You have no ${tokens} on ${network}.`,
  notBridged: (network: string) => `Nothing in your wallet on ${network} can be brought here right now.`,
  readFailed: (network: string) => `Your balance on ${network} couldn't be read. Try again.`,
  /**
   * Added 2026-10-06 (the owner's point 2b): the holding is smaller than what the position lacks; it brings all of it.
   * Changed on purpose 2026-10-06 (the integration review: the sentence was not English).
   */
  allYouHave: (network: string) => `That's all you have on ${network}. It's less than this amount needs.`,
  /** Added 2026-10-06 (the integration review): the quote shown guarantees less than the position lacks. */
  bringsLess: 'This may bring less than this amount needs.',
  /** Added 2026-10-06 (the owner's point 2b): no figure can be worked out, so the person says how much. */
  enterAmount: 'Enter how much to bring.',
  /** Added 2026-10-06 (the review): the list of what can be brought did not come in time (the balance itself was read). */
  noRoutes: "Couldn't find a route right now. Try again.",
  changeTransfer: 'Change amount',
  /**
   * Decided [owner, 2026-10-02 evening]: while the crosschain-v1 route is not on (the gate's `preview`: the Worker not
   * deployed or switched off), a press of Bring is answered with S2's own plain sentence (in place of the gate's sentence
   * about Domino's contracts, which S2 does not use; that one stays for the zap, the vault and auto-exit).
   */
  locked: "Bringing funds from another network isn't available yet.",
  which: 'Token to bring',
  network: 'Network',
  chooseNetwork: 'Choose a network',
  token: 'Token to send',
  chooseToken: 'Choose a token',
  loadingNetworks: 'Loading networks…',
  noTokens: 'Nothing on this network can be bridged here right now.',
  amount: 'Amount to send',
  rawUnits: "This token's decimals are unknown, so enter the amount in its smallest units.",
  readDecimals: (origin: string) => `Switch to ${origin} to read this token`,
  amountInvalid: 'Enter an amount above zero.',
  // §3.9 rev2, decision #29: the option's own words, as proposed.
  gasOffer: (destination: string) => `Get gas on ${destination}`,
  // Changed on purpose 2026-10-06 (the owner's point 4: little text): one short clause each.
  gasWhy: (destination: string) => `You have no ETH on ${destination} for network fees. Relay can add a little from this deposit.`,
  gasUnread: (destination: string) => `Relay can add a little ETH from this deposit for network fees on ${destination}.`,
  quoting: 'Getting a quote…',
  quoteExpired: 'The quote expired.',
  /** Added 2026-10-06 (the review: past the automatic new quotes, the expired state had no way out). */
  renewQuote: 'Get a new quote',
  // Changed on purpose 2026-10-06 (the integration review: "the button" beside Continue): the button by its own word.
  newQuote: 'The quote expired. Here is a new one: press Bring again to continue.',
  newQuoteApproved: 'Your approval went through, but the quote expired. Here is a new one: press Bring again to continue.',
  stepWords: {
    waiting: 'Waiting',
    wallet: 'Confirm in your wallet…',
    sent: 'Sent, waiting to be included…',
    included: 'Included',
    finalized: 'Finalized',
    done: 'Done',
  },
  /** The quote's one button (Changed on purpose 2026-10-06, the owner's point 4): what leaves the wallet, and from where. */
  bring: (amount: string, network: string) => `Bring ${amount} from ${network}`,
  /**
   * Added 2026-10-06 (rugged's answer of 6 Oct, F7 delta of 6 Oct §2 step 7: the line that counts the transactions says
   * one confirmation for a batch, in his words): the live line while the approval and the deposit go as one batch.
   */
  batchLine: (sent: boolean) => `Approval and deposit in one confirmation · ${sent ? 'waiting to be included…' : 'confirm in your wallet'}`,
  /**
   * Added 2026-10-06 (rugged's answer of 6 Oct, F7 delta of 6 Oct §1: one network cost line in view, never 0; in S2 the
   * gas on the origin the provider estimated, or "Not reported"): the winner's estimate, as Details writes it.
   */
  networkFee: (origin: string, fee: string | null, provider: string) => `Network fee on ${origin}: ${fee === null ? NOT_REPORTED : `about ${fee}, estimated by ${provider}`}`,
  // Added 2026-10-06 (the owner's point 4): what the quote's Details list.
  youSend: 'You send',
  chosenRoute: (provider: string) => `${provider} (chosen)`,
  whyThisRoute: 'Why this route',
  approvalReverted: (origin: string) => `The approval failed on ${origin}. Nothing was deposited.`,
  depositReverted: (origin: string) => `The deposit failed on ${origin}. Nothing was bridged.`,
  notSaved: "This page couldn't save your deposit for later. Keep this page open until it arrives.",
  onTheWay: 'On the way',
  /** Changed on purpose 2026-10-06 (the owner's point 4): the network alone; the bridge is in Details. */
  depositFrom: (origin: string) => `Coming from ${origin}`,
  bridge: 'Bridge',
  arrived: 'Arrived',
  refunded: 'Refunded',
  remove: 'Remove from this list',
  balanceTitle: (destination: string) => `Your balance on ${destination}`,
  switchToDestination: (destination: string) => `Switch to ${destination}`,
  balanceElsewhere: (destination: string) => `Switch your wallet to ${destination} to see what arrived.`,
  /** §3.9: the same position continues with what arrived, read on the destination through the wallet. */
  continueButton: (amount: string) => `Use ${amount} for this position`,
  /** The zap path: what arrived becomes a new deposit, reviewed again. */
  newDepositHint: 'Use this balance as your new deposit. You will review the swap before confirming.',
  /**
   * Added 2026-10-06 (the integration review: a range beside today's price takes one token alone, and "Use" made the
   * other one the amount's token): the amount is typed in the token the range takes, and the swap pays with what arrived.
   */
  takesOnly: (token: string | null) => (token ? `Enter the amount in ${token} above: Domino swaps what arrived for it.` : 'Enter the amount above: Domino swaps what arrived for it.'),
  // Changed on purpose 2026-10-06 (the integration review: the sentence was not idiomatic).
  nothingToUse: (destination: string) => `None of it is in your wallet on ${destination} now.`,
  checkHash: 'Deposit transaction',
  details: 'Details',
  viewOnExplorer: 'View on the explorer',
  copyHash: 'Copy transaction hash',
  heldTitle: (step: 'approval' | 'deposit', origin: string) => (step === 'deposit' ? `Deposit from ${origin}` : `Approval on ${origin}`),
  // Changed on purpose 2026-10-06 (the owner's point 4: little text): the same facts, shorter.
  heldOpen: (step: 'approval' | 'deposit', origin: string) =>
    `We couldn't confirm whether your wallet sent this ${step}. Check your wallet's activity on ${origin}. Until it is clear, nothing more is sent from ${origin}; if you rejected it, say so below.`,
  rejectedInWallet: 'I rejected it in my wallet',
  forgotten: 'Nothing was sent. You can deposit again.',
  depositHandedOver: 'This deposit was handed to your wallet. It is never sent twice.',
  /**
   * Added 2026-10-06 (the owner: AI/PONS short on Robinhood Chain and nothing offered): one line where the offer would be,
   * "Pay with ETH instead · Domino swaps it for AI and PONS" (the pool's symbols drawn as read; ./PayWith.tsx). The way back,
   * "Use AI and PONS instead", is the amount step's own (components/create/PairedAmounts.tsx).
   */
  payInstead: (token: string) => `Pay with ${token} instead`,
  paySwaps: 'Domino swaps it for',
  and: 'and',
} as const

/** The closed sender's stops (finance/v2/crosschain.ts OriginStepError codes), said. `{origin}` and `{native}` are filled here. */
export const SENDER_COPY: Readonly<Record<string, string>> = Object.freeze({
  declined: DECLINED_COPY,
  wallet_refused: 'Your wallet refused this request. Nothing was sent.',
  wallet_result_unknown:
    'We could not confirm whether your wallet sent this. Check your wallet activity on {origin}. Nothing is sent twice: no new deposit from {origin} is offered here until this is clear.',
  // V1's own sentence for a request handed to the wallet with no answer (components/create/CreatePosition.tsx).
  wallet_request_open: 'Your wallet may still be showing an earlier request from this page. Approve or reject it there. If you already rejected or closed it, say so below.',
  deposit_may_have_gone:
    'Your wallet sent a transaction from {origin} in place of your earlier deposit, so that deposit probably went through. This page never got its transaction and cannot follow it. Check your wallet activity on {origin} before you deposit again.',
  deposit_already_offered: "This quote's deposit was already handed to your wallet. It is never sent twice.",
  wallet_wrong_chain: 'Your wallet is on another network. Switch it to {origin}, then try again.',
  wallet_identity_changed: 'Your wallet changed, so nothing more was sent.',
  wallet_action_busy: 'Another wallet request is still open. Finish it, then try again.',
  wallet_action_expired: 'Your wallet took too long to answer. Try again.',
  // The sender's own guard (finance/v2/crosschain.ts): a quote that did not come from Domino's service is never sent. Said
  // plainly; no test data exists any more (the owner, 2026-10-02 night), so the offer never meets it in practice.
  quote_synthetic: "This quote can't be sent from here, so nothing was sent and your wallet was not asked. Get a new quote.",
  quote_expired: FAILURE_COPY.expired,
  quote_owner: FAILURE_COPY.owner,
  quote_no_decision: NO_ROUTE,
  quote_not_validated: FAILURE_COPY.contract,
  quote_shape: FAILURE_COPY.contract,
  quote_allowance: FAILURE_COPY.contract,
  allowance_short: 'The approval is not on {origin} yet. Try again in a moment.',
  pending_wallet_transaction: 'Your wallet has a transaction still waiting on {origin}. Wait for it to finish, then try again.',
  network_fee_unavailable: "Your wallet couldn't tell the network fee on {origin}. Try again.",
  gas_budget_exceeded: 'This step needs a larger network fee than Domino allows, so nothing was sent.',
  native_balance_insufficient: 'Not enough {native} on {origin} to pay the network fee.',
  step_would_fail: 'This step would fail on {origin}. Get a new quote and try again.',
  // Added 2026-10-06 (rugged's answer of 6 Oct: approval and deposit in one batch): what became of a batch the wallet took.
  batch_not_included: "Your wallet didn't send it. Nothing was bridged.",
  batch_reverted: 'The approval and the deposit failed on {origin}. Nothing was bridged.',
  batch_unknown: "We couldn't follow this deposit. Check your wallet's activity on {origin}.",
})
export const SENDER_GENERIC = "Something went wrong with your wallet's answer. Check your wallet's activity on {origin}."

/** A sender stop as a sentence: its table's, or the generic one. */
export function senderCopy(code: string, values: { origin: string; native: string }): string {
  const template = Object.hasOwn(SENDER_COPY, code) ? SENDER_COPY[code] : SENDER_GENERIC
  // One pass, through a function: a value is never read as a template or a replacement pattern.
  return template.replace(/\{(origin|native)\}/g, (_whole, name: 'origin' | 'native') => values[name])
}

/**
 * Decision #16 [owner, 02/10] (§3.5, §8.2 S2; texts #29): the discrete small line beside the fee and the provider in the
 * quote, exactly: "Domino fee 0.35% · via {provider} · you can also bridge with any other service".
 * Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, F7 delta of 6 Oct §1: the Domino fee stays in view with its
 * amount and token, and in S2 its chain and where it is charged; the card showed only "Domino fee 0.35% · via …"): the
 * fee is §3.5's own sentence for the winner (v2/crosschain/copy.ts feeLines.domino: "Domino fee (0.35%): 0.35 USDC,
 * charged by Relay on Arbitrum One"), which names the provider; the clause after it is #16's, as it was.
 */
export const bridgeElsewhereLine = (fee: string) => `${fee} · you can also bridge with any other service`
