import type { KeyboardEvent } from 'react'
import { RangeBar } from '../ui'
import { feeText, rangeView, tokenName } from '../../lib/automate/picker'
import { feeWords } from '../../lib/format/fee'
import { FEATURES } from '../../lib/automate/features'
import { automationWord, useAutomation } from '../../lib/automationState'
import type { WalletPosition } from '../../lib/walletPositions'
import type { TokenChainId } from '../../lib/read/types'
import { AddressMark } from './marks'

/** A position that already runs one of the two automations says which, and whether it runs (2026-09-24). */
function PickAutomation({ tokenId }: { tokenId: string }) {
  const view = useAutomation(tokenId)
  if (view.phase !== 'ready' || view.state.automation === 'plain' || view.state.automation === 'other') return null
  return (
    <span className="dm-seq-pick-auto" data-automation={view.state.automation}>
      {FEATURES[view.state.automation].name} · {automationWord(view.state)}
    </span>
  )
}

type Choice = WalletPosition & { key?: string; chainId?: TokenChainId; network?: string; dex?: 3 | 4 }
const choiceKey = (position: Choice) => position.key ?? position.tokenId

/**
 * The connected wallet's open positions as a list to choose from (2026-09-24,
 * the owner's simpler automation page): each one its two token marks, its
 * pair, its fee tier and a mini range bar, as radios in one group. Nothing is
 * typed or searched; the positions arrive as props (useWalletPositions on the
 * page, injected data in tests). The arrow keys move the choice, as a radio
 * group does. A position with a note (`notes`, by NFT id: the chain showed
 * something already subscribed to it) is shown with it and can't be chosen.
 */
export function PositionPicker({ positions, selected, onSelect, disabled = false, notes = {} }: { positions: readonly Choice[]; selected: string | null; onSelect: (tokenId: string) => void; disabled?: boolean; notes?: Readonly<Record<string, string>> }) {
  const first = positions.find((position) => !notes[choiceKey(position)])
  const focusable = selected ?? (first ? choiceKey(first) : null)
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    // The next one that can be chosen, past any with a note.
    let next = index
    do next = (next + step + positions.length) % positions.length
    while (notes[choiceKey(positions[next])] && next !== index)
    onSelect(choiceKey(positions[next]))
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="radio"]')
    buttons?.[next]?.focus()
    // V2 replaces the financial review on a different full position identity. Restore radio focus after that
    // deliberate remount; consent and the old transaction steps remain discarded.
    const key = positions[next].key
    if (key) requestAnimationFrame(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-sequence-position-key]')).find(button => button.dataset.sequencePositionKey === key)?.focus())
  }
  return (
    <div className="dm-seq-picker" role="radiogroup" aria-label="Your open positions">
      {positions.map((position, index) => {
        const [a, b] = position.currencies
        const pair = `${tokenName(a)} / ${tokenName(b)}`
        const range = rangeView(position)
        const key = choiceKey(position)
        const checked = selected === key
        const note = notes[key]
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={focusable === key ? 0 : -1}
            className="dm-seq-pick"
            disabled={disabled || !!note}
            data-sequence-position={position.tokenId}
            data-sequence-position-key={position.key}
            onClick={() => onSelect(key)}
            onKeyDown={(event) => move(event, index)}
          >
            <span className="dm-seq-pick-marks" aria-hidden="true">
              <AddressMark address={a.address} chainId={position.chainId} size={28} />
              <AddressMark address={b.address} chainId={position.chainId} size={28} />
            </span>
            <span className="dm-seq-pick-name">
              <bdi className="dm-seq-pick-pair">{pair}</bdi>
              <span className="dm-seq-pick-meta">
                {position.network && <span className="dm-chip">{position.network} · v{position.dex}</span>}
                <span className="dm-chip">{feeWords(feeText(position.fee))}</span>
                <span className="dm-seq-pick-id">#{position.tokenId}</span>
                {note ? <span className="dm-seq-pick-note">{note}</span> : !__DOMINO_V2__ && <PickAutomation tokenId={position.tokenId} />}
              </span>
            </span>
            <span className="dm-seq-pick-range" aria-hidden="true">
              <RangeBar lower={range.lower} upper={range.upper} current={range.current} inRange={range.inRange} />
            </span>
            <span className="dm-seq-pick-dot" aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}
