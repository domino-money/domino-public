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
import { FAILURE_COPY, NO_ROUTE } from '../../v2/crosschain/copy'

export const FUNDS_TEXT = {
  /** The offer's title: the token the position lacks, and the network once one is picked. */
  title: (token: string, network: string | null) => (network ? `Bring ${token} from ${network}` : `Bring ${token} from another network`),
  lead: (token: string, destination: string) => `Use your other tokens as ${token} on ${destination}.`,
  /** What the position lacks of the token Review's plan is short of. */
  needMore: (amount: string, _destination: string) => `${amount} more needed.`,
  /** The wallet holds none of the token there. */
  holdsNone: (token: string, destination: string) => `Your wallet has no ${token} on ${destination}.`,
  /** The other token, which helps only through the swap: no figure claimed. */
  cantFund: (destination: string) => `Your wallet doesn't have enough on ${destination} for this position, even with a swap.`,
  // Changed on purpose 2026-10-05 (the owner, testing it: "very hard to understand ... it has to happen behind the scenes;
  // whoever uses Domino has no experience"): one sentence, one choice of network, the rest done for the person.
  /** What the position lacks, where it is needed: "You need 0.0021 ETH more on Robinhood Chain." */
  youNeed: (amount: string, destination: string) => `You need ${amount} more on ${destination}.`,
  bringFrom: 'Bring it from:',
  howItWorks: (destination: string) => `Your wallet goes to that network to send it, then comes back to ${destination}. You approve each step in your wallet.`,
  signingIn: "Sign in with your wallet to continue. This doesn't move funds.",
  signInFirst: 'Sign in with your wallet to bring funds from another network.',
  switchingTo: (network: string) => `Switching your wallet to ${network}…`,
  checking: (network: string) => `Checking your balance on ${network}…`,
  finding: 'Finding the best route…',
  noneThere: (tokens: string, network: string) => `You have no ${tokens} on ${network}.`,
  notBridged: (network: string) => `Nothing in your wallet on ${network} can be brought here right now.`,
  readFailed: (network: string) => `Your balance on ${network} couldn't be read. Try again.`,
  changeTransfer: 'Change amount',
  /**
   * Decided [owner, 2026-10-02 evening]: while the crosschain-v1 route is not on (the gate's `preview`: the Worker not
   * deployed or switched off), a press of Bring is answered with S2's own plain sentence (in place of the gate's sentence
   * about Domino's contracts, which S2 does not use; that one stays for the zap, the vault and auto-exit).
   */
  locked: "Bringing funds from another network isn't available yet.",
  // What the wallet holds on other networks (./Holdings.tsx), read through the wallet's own provider: never guessed.
  holdingsTitle: 'On your other networks',
  scan: 'Check other networks',
  scanWhat: (networks: string, home: string) =>
    `Check ETH, WETH and USDC on ${networks}. Approve network switches in your wallet; return to ${home} afterward. No funds move.`,
  switching: (network: string) => `Switching to ${network}…`,
  reading: (network: string) => `Reading ${network}…`,
  /** "Base: 0.42 ETH · 120 USDC". */
  holdingsOn: (network: string, amounts: readonly string[]) => `${network}: ${amounts.join(' · ')}`,
  /** Added 2026-10-06: under a network's button, what Domino's service read there (and about how much, when it could value it all). */
  holdsThere: (amounts: readonly string[], usd: string | null) => (usd === null ? `You have ${amounts.join(' · ')}` : `You have ${amounts.join(' · ')} (about ${usd})`),
  nothingThere: 'Nothing to bring from there',
  bring: (amount: string, network: string) => `Bring ${amount} from ${network}`,
  nothingFound: (networks: string) => `Nothing to bring: no ETH, WETH or USDC on ${networks}.`,
  notInWallet: (network: string) => `${network} isn't in your wallet.`,
  couldNotRead: (network: string) => `${network} couldn't be read.`,
  scanStopped: 'Your wallet declined the network switch, so the search stopped.',
  switchBack: (home: string) => `Switch your wallet back to ${home}.`,
  walletGone: "Your wallet isn't connected any more, so nothing was read.",
  /** A holding the origins listing does not bridge to the position's chain. */
  noRoute: (token: string, origin: string, destination: string) => `Relay and Across don't bridge ${token} from ${origin} to ${destination} right now.`,
  which: 'Token to bring',
  network: 'Network',
  chooseNetwork: 'Choose a network',
  token: 'Token to send',
  chooseToken: 'Choose a token',
  loadingNetworks: 'Loading networks…',
  providerListed: (provider: string) => `${provider} is available.`,
  noTokens: 'Nothing on this network can be bridged here right now.',
  bridgedBy: (names: string) => `Bridged by ${names}`,
  amount: 'Amount to send',
  rawUnits: "This token's decimals are unknown, so enter the amount in its smallest units.",
  readDecimals: (origin: string) => `Switch to ${origin} to read this token`,
  slippageTitle: 'Bridge slippage',
  slippage: 'Slippage tolerance (%)',
  slippageHelp: 'Between 0.1% and 5%. The least you receive is shown with the quote.',
  slippageInvalid: 'Enter a slippage tolerance between 0.1% and 5%.',
  amountInvalid: 'Enter an amount above zero.',
  // §3.9 rev2, decision #29: the option's own words, as proposed.
  gasOffer: (destination: string) => `Get gas on ${destination}`,
  gasWhy: (destination: string) =>
    `Your wallet has no ETH on ${destination} to pay network fees there. Relay can deliver a little ETH out of this deposit; Across can't.`,
  gasUnread: (destination: string) => `Relay can deliver a little ETH out of this deposit for network fees on ${destination}; Across can't.`,
  getQuote: 'Get a quote',
  quoting: 'Getting a quote…',
  quoteTitle: 'Quote',
  best: 'Best',
  quoteExpired: 'The quote expired.',
  newQuote: 'The quote expired. Here is a new one. Press Deposit to continue.',
  newQuoteApproved: 'Your approval went through, but the quote expired. Here is a new one. Press Deposit to continue.',
  stepsTitle: (origin: string) => `In your wallet, on ${origin}`,
  stepSwitch: (origin: string) => `Switch to ${origin}`,
  stepApprove: (amount: string) => `Approve ${amount}`,
  stepApproveSkipped: (amount: string) => `Approve ${amount}: already approved`,
  stepDeposit: (amount: string) => `Deposit ${amount}`,
  stepWords: {
    waiting: 'Waiting',
    wallet: 'Confirm in your wallet…',
    sent: 'Sent, waiting to be included…',
    included: 'Included',
    finalized: 'Finalized',
    done: 'Done',
  },
  deposit: (origin: string) => `Deposit from ${origin}`,
  approvalReverted: (origin: string) => `The approval failed on ${origin}. Nothing was deposited.`,
  depositReverted: (origin: string) => `The deposit failed on ${origin}. Nothing was bridged.`,
  notSaved: "This page couldn't save your deposit for later. Keep this page open until it arrives.",
  onTheWay: 'On the way',
  depositFrom: (origin: string, provider: string) => `From ${origin} with ${provider}`,
  arrived: 'Arrived',
  refunded: 'Refunded',
  remove: 'Remove from this list',
  balanceTitle: (destination: string) => `Your balance on ${destination}`,
  switchToDestination: (destination: string) => `Switch to ${destination}`,
  balanceElsewhere: (destination: string) => `Switch your wallet to ${destination} to see what arrived.`,
  /** §3.9: the same position continues with what arrived, read on the destination through the wallet. */
  continueButton: (amount: string) => `Use ${amount} for this position`,
  nothingToUse: (destination: string) => `Nothing of it is in your wallet on ${destination} now.`,
  checkHash: 'Deposit transaction',
  details: 'Details',
  viewOnExplorer: 'View on the explorer',
  copyHash: 'Copy transaction hash',
  heldTitle: (step: 'approval' | 'deposit', origin: string) => (step === 'deposit' ? `Deposit from ${origin}` : `Approval on ${origin}`),
  heldOpen: (step: 'approval' | 'deposit', origin: string) =>
    `We could not confirm whether your wallet sent this ${step}. Check your wallet activity on ${origin}. No new deposit from ${origin} is offered here until this is clear. If you rejected or closed it in your wallet, say so below.`,
  rejectedInWallet: 'I rejected it in my wallet',
  forgotten: 'Nothing was sent. You can deposit again.',
  depositHandedOver: 'This deposit was handed to your wallet. It is never sent twice.',
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
 */
export const bridgeElsewhereLine = (percent: string, provider: string) => `Domino fee ${percent} · via ${provider} · you can also bridge with any other service`
