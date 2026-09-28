import { useState } from 'react'
import { FEATURES } from '../../lib/automate/features'
import { automatable } from '../../lib/automate/picker'
import { automationWord, useAutomation, type AutomationMode, type AutomationView } from '../../lib/automationState'
import { createdHere } from '../../lib/create/createProgress'
import { useWalletAnswer } from '../../lib/walletPositions'
import { ModeArt, PlainArt } from '../automate/ModeArt'
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
const SWITCH_ON: Readonly<Record<AutomationMode, string>> = { compound: '#/docs/auto-compound#where-it-starts', domino: '#/docs/domino-compounder#start-and-stop' }

/** For a sequence that does not run, paused or its permission over the NFT lost, the next step: the docs on switching it on (review of 2026-09-24). */
function switchOn(view: AutomationView): string | null {
  if (view.phase !== 'ready' || !('paused' in view.state) || view.state.active) return null
  return SWITCH_ON[view.state.automation]
}

/** The feature's small picture: one range for a plain position, the mode's own thumbnail for the two automations. */
function Art({ view }: { view: AutomationView }) {
  if (view.phase !== 'ready' || view.state.automation === 'other') return null
  const mode = view.state.automation
  return mode === 'plain' ? <PlainArt className="dm-auto-art" /> : <ModeArt mode={mode} size="thumb" className="dm-auto-art" />
}

/**
 * For a position's own page: whether the position is one the automation page lists for the connected wallet, so that
 * nothing offers Automate for a position the page then leaves out (review of 2026-09-24: an NFT the wallet holds but
 * did not open with Domino led to "No open positions"). That is the wallet's own list of the positions it opened with
 * Domino (the owned read, lib/walletPositions.ts, the picker's source), holding it open, with no hooks and a fixed fee
 * (automatable, the picker's own test). `owner`: the NFT's owner when that wallet is the one connected here on
 * Robinhood Chain, and null for anyone else, for whom nothing is asked. True or false once read, null until then or
 * when nothing is asked. A position this visit's New position made that a read from a node still behind its mint lacks
 * is asked for once more (createdHere); any other missing id is simply not one of the wallet's Domino positions.
 * `changes`: the page's count of the owner's actions on it; each reads the list again (2026-09-25).
 */
export function useListedPosition(tokenId: string, owner: string | null, changes = 0): boolean | null {
  const [again, setAgain] = useState(0)
  const answer = useWalletAnswer(owner ? owner.toLowerCase() : null, again + changes)
  if (answer.phase !== 'ready') return null
  const position = answer.answer.positions.find((entry) => entry.tokenId === tokenId)
  if (!position && !again && createdHere(tokenId)) setAgain(1)
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
 * The way from an open position to Automate. `row`: the line under a row of Your positions (the rows are links,
 * so this sits beside the row, never inside it): the position's feature, and Automate for a plain one, or how to switch
 * on a sequence that does not run. `action`: the same way on, on the position page beside the owner's Collect fees and
 * Close position. `open`: whether the automation page would list the position (automatable for a row of the wallet's
 * own list; useListedPosition on its page).
 */
export function AutomateEntry({ tokenId, open, variant = 'row' }: { tokenId: string; open: boolean; variant?: 'row' | 'action' }) {
  const view = useAutomation(open ? tokenId : null)
  if (!open) return null
  const row = variant === 'row'
  // On a position's page (2026-09-27) the way on is an outlined button like the owner's own actions beside it.
  const look = row ? 'ghost' : 'outline'
  const docs = switchOn(view)
  const go = offered(view) ? (
    <LinkButton href={sequenceHref(tokenId)} variant={look} size={row ? 'sm' : 'md'} className="dm-auto-go" data-automate-entry={tokenId}>
      <IconAutomate />
      Automate
    </LinkButton>
  ) : docs ? (
    <LinkButton href={docs} variant={look} size={row ? 'sm' : 'md'} className="dm-auto-go" data-automate-docs={tokenId}>
      How to switch it on
    </LinkButton>
  ) : null
  if (!row) return go
  // A subscriber that is not Domino's: nothing to say and nothing to offer, so no line at all.
  if (view.phase === 'ready' && view.state.automation === 'other') return null
  const text = stateText(view)
  return (
    <div className="dm-own-auto" data-position-automation={tokenId} {...dataOf(view)}>
      <span className="dm-own-auto-state">
        <Art view={view} />
        {text}
      </span>
      {go}
    </div>
  )
}
