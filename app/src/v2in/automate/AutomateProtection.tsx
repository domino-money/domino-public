import { PlainArt } from '../../components/automate/ModeArt'
import { IconChevronRight } from '../../components/icons'
import { Display, LinkButton } from '../../components/ui'
import { gateOpen, useGate } from './gate'

/**
 * Automate's way to the vault's new option (Domino V2 integration; spec F7 §4.1, §5.1; decisions #18, #25): "Protection
 * only", a stop-loss and a take-profit on a position without reinvesting its fees, beside the plain position the other
 * automations start from, in that card's own look (screens/Automate.tsx PlainCard). Shown only where both Robinhood
 * Chain gates it needs (the vault's and the auto-exit's) are open; it leads to Set up automation with Protection only
 * chosen, where the flow runs (up to its review while the gates are `preview`).
 */
export default function AutomateProtection() {
  const vault = useGate('vault', 4663)
  const exit = useGate('autoExit', 4663)
  if (!gateOpen(vault) || !gateOpen(exit)) return null
  return (
    <section className="dm-card dm-auto-plain animate-rise" data-feature="protection" aria-labelledby="automate-protection">
      <div className="dm-plate dm-dots-plate dm-auto-plain-plate" aria-hidden="true">
        <PlainArt />
      </div>
      <div className="dm-auto-plain-body">
        <Display as="h2" id="automate-protection" className="dm-display-card">
          Stop-loss / take-profit
        </Display>
        <p className="dm-auto-plain-line">Set price targets for an automatic exit, without reinvesting fees. The execution price can differ. 0.2% of its value, only if an exit runs.</p>
      </div>
      <LinkButton href="#/sequence/protection" variant="outline" size="lg" className="dm-auto-plain-go" data-v2in-protection="">
        Set up
        <IconChevronRight />
      </LinkButton>
    </section>
  )
}
