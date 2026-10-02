import { FEATURES } from '../../lib/automate/features'
import { automatable } from '../../lib/automate/picker'
import { automationWord, useAutomation, type AutomationMode, type AutomationView } from '../../lib/automationState'
import { useWalletAnswer } from '../../lib/walletPositions'
import { sequenceHref } from '../explore/routes'
import { IconAutomate } from '../icons'
import { LinkButton, Pill } from '../ui'

/*
 * The three features on a position (the owner, 2026-09-24: a plain position,
 * Auto-compound and Domino-compound, "totally integrated"): which one the
 * position is in, read from chain (lib/automationState.ts), and for a plain
 * one the quiet way to automate it, the automation page with this position
 * already chosen. Kept apart from the screens that show it, so each screen
 * places it with one line and owns nothing of it.
 */

/** The state in words, "Plain position" or the mode and whether it runs; null while unknown, or for a subscriber that is not Domino's. */
function stateText(view: AutomationView): string | null {
  if (view.phase !== 'ready') return null
  const state = view.state
  if (state.automation === 'other') return null
  if (state.automation === 'plain') return FEATURES.plain.name
  return `${FEATURES[state.automation].name} · ${automationWord(state)}`
}

/** A position's automation as data attributes: its feature, and for a sequence whether it runs. */
function dataOf(view: AutomationView) {
  if (view.phase !== 'ready') return { 'data-automation': view.phase }
  const { state } = view
  return { 'data-automation': state.automation, 'data-automation-state': 'paused' in state ? (state.paused ? 'paused' : state.active ? 'active' : 'stopped') : undefined }
}

/**
 * Whether the way to Automate is offered: for a plain position, and for one whose state could not be read (the
 * automation page checks the position on chain again before anything is signed). Never for one already automated.
 */
const offered = (view: AutomationView) => view.phase === 'unknown' || (view.phase === 'ready' && view.state.automation === 'plain')

/** Where the docs say how a sequence is switched on: the automation page's own link once a sequence is set up (SequenceCreate.tsx). */
const SWITCH_ON: Readonly<Record<AutomationMode, string>> = { compound: '#/docs/auto-compound#where-it-starts', domino: '#/docs/domino-compound#start-and-stop' }

/** For a sequence that does not run, paused or its permission over the NFT lost, the next step: the docs on switching it on (review of 2026-09-24). */
function switchOn(view: AutomationView): string | null {
  if (view.phase !== 'ready' || !('paused' in view.state) || view.state.active) return null
  return SWITCH_ON[view.state.automation]
}

/**
 * For a position's own page: whether the position is one the automation page lists for the connected wallet, so that
 * nothing offers Automate for a position the page then leaves out (review of 2026-09-24: an NFT the wallet holds but
 * did not open with Domino led to "No open positions"). That is the wallet's own list of the positions it opened with
 * Domino (the owned read, lib/walletPositions.ts, the picker's source), holding it open, with no hooks and a fixed fee
 * (automatable, the picker's own test). `owner`: the NFT's owner when that wallet is the one connected here on
 * Robinhood Chain, and null for anyone else, for whom nothing is asked. True or false once read, null until then or
 * when nothing is asked. A position this visit's New position made that a read from a node still behind its mint lacks
 * is asked for again, a few times (the read's own ladder, walletPositions.ts askWallet); any other missing id is simply
 * not one of the wallet's Domino positions.
 * `changes`: the page's count of the owner's actions on it; each reads the list again (2026-09-25).
 */
export function useListedPosition(tokenId: string, owner: string | null, changes = 0): boolean | null {
  // 2026-10-01 (fees item A23): this read only decides Automate: it does not hold the page's history reads (hold off).
  // 2026-10-02 (RPC fix round 2): a list that lacks a position made here is asked again by the read itself (askWallet).
  const answer = useWalletAnswer(owner ? owner.toLowerCase() : null, changes, null, undefined, false)
  if (answer.phase !== 'ready') return null
  const position = answer.answer.positions.find((entry) => entry.tokenId === tokenId)
  return position ? automatable(position) : false
}

/**
 * A position's automation as a pill, beside its range status on its own page. Nothing while it is unknown. One of
 * the two automations is shown to anyone: its vault is one Domino's factory made, read on chain. "Plain position" only
 * where the Positions rows say it too: for one of the connected wallet's own open Domino positions (`listed`,
 * useListedPosition), never for a closed one or an NFT opened elsewhere.
 */
export function AutomationChip({ tokenId, listed }: { tokenId: string; listed: boolean | null }) {
  const view = useAutomation(tokenId)
  const text = stateText(view)
  if (!text || (view.phase === 'ready' && view.state.automation === 'plain' && listed !== true)) return null
  const running = view.phase === 'ready' && 'active' in view.state && view.state.active
  return (
    <Pill dot={view.phase === 'ready' && view.state.automation !== 'plain'} tone={running ? 'accent' : 'neutral'} className="dm-auto-pill" {...dataOf(view)}>
      {text}
    </Pill>
  )
}

/**
 * The way from an open position to Automate. `row`: the Automation column of a row of Your positions (round 6,
 * 2026-09-27, the owner: one tidy row, no line under it): a small badge for Auto-compound or Domino-compound, with
 * Paused or Stopped under it when it does not run (its page says how to switch it on), or Automate for a plain one;
 * the rows are links, so this sits over the row as its sibling, never inside it, and a click anywhere on it but on
 * Automate is the row's (positions.css; 2026-09-28, review: the badge was a dead spot, its tooltip with it, so it has
 * none). `action`: the same way on, on the
 * position page beside the owner's Collect fees and Close position, or how to switch on a sequence that does not
 * run. `open`: whether the automation page would list the position (automatable for a row of the wallet's own list;
 * useListedPosition on its page).
 */
export function AutomateEntry({ tokenId, open, variant = 'row' }: { tokenId: string; open: boolean; variant?: 'row' | 'action' }) {
  const view = useAutomation(open ? tokenId : null)
  if (!open) return null
  const row = variant === 'row'
  const state = view.phase === 'ready' ? view.state : null
  // A subscriber that is not Domino's: nothing to say and nothing to offer.
  if (state?.automation === 'other') return null
  const sequence = state && 'paused' in state ? state : null
  const running = sequence !== null && sequence.active && !sequence.paused
  // On a position's page (2026-09-27) the way on is an outlined button like the owner's own actions beside it.
  const go = offered(view) ? (
    <LinkButton href={sequenceHref(tokenId)} variant={row ? 'ghost' : 'outline'} size={row ? 'sm' : 'md'} className="dm-auto-go" data-automate-entry={tokenId}>
      <IconAutomate />
      Automate
    </LinkButton>
  ) : null
  if (!row) {
    const docs = switchOn(view)
    return (
      go ??
      (docs && (
        <LinkButton href={docs} variant="outline" size="md" className="dm-auto-go" data-automate-docs={tokenId}>
          How to switch it on
        </LinkButton>
      ))
    )
  }
  return (
    <div className="dm-own-auto" data-position-automation={tokenId} {...dataOf(view)}>
      {sequence ? (
        <>
          <span className="dm-own-badge" data-running={running ? '' : undefined}>
            {FEATURES[sequence.automation].name}
          </span>
          {!running && <span className="dm-own-badge-word">{automationWord(sequence)}</span>}
        </>
      ) : (
        go
      )}
    </div>
  )
}
