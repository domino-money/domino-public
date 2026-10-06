import { SheetNote } from '../../components/positions/ActionSheet'
import { Button } from '../../components/ui'
import { Check } from '../automate/ui'
import { PAST_EDGE_ACK, PAST_EDGE_TEXT, TURN_OFF_INSTEAD } from './turnBackOn'

/**
 * Added 2026-10-06 (the integration review, money #4): what a dialog that turns a paused Auto-exit back on says when the
 * price is already past one of its ends (./turnBackOn.ts): one warning, the tick to go on anyway, and "Turn off instead"
 * where the page has Auto-exit's own Turn off.
 */
export function PastEdge({ acknowledged, onAcknowledge, disabled, onTurnOff }: {
  acknowledged: boolean
  onAcknowledge: (next: boolean) => void
  disabled?: boolean
  onTurnOff?: () => void
}) {
  return (
    <div className="grid gap-2" data-exit-past="">
      <SheetNote tone="warn" data-exit-past-note="">
        {PAST_EDGE_TEXT}
      </SheetNote>
      <Check checked={acknowledged} onChange={onAcknowledge} disabled={disabled} data-exit-past-ack="">
        {PAST_EDGE_ACK}
      </Check>
      {onTurnOff && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onTurnOff} data-exit-past-off="">
            {TURN_OFF_INSTEAD}
          </Button>
        </div>
      )}
    </div>
  )
}
