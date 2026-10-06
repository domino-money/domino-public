import { ExitThumb } from '../../components/home/Vignettes'
import { IconChevronRight } from '../../components/icons'
import { Display, LinkButton } from '../../components/ui'
import { gateOpen, useGate } from './gate'

/**
 * Automate's way to Auto-exit (Domino V2 integration; spec F7 §4.1, §5.1; decisions #18, #25), beside the plain position
 * the other automations start from, in that card's own look (screens/Automate.tsx PlainCard).
 *
 * Changed on purpose 2026-10-06 (the owner's point 5; rugged97: "this stop loss-take profit product was named wrong. It is
 * AUTO-EXIT. When the price hits the edge of the range we close the position automatically and send the tokens to the
 * wallet"): its name and one line, and shown wherever Domino's automation and auto-exit are open on any of its three
 * networks (it was Robinhood Chain's alone). Changed on purpose 2026-10-06 (the review of point 5): it leads to Positions,
 * where every network's position has its own Auto-exit on its page, and no longer to Set up automation, which lists
 * Robinhood Chain's positions alone and depends on V1's automation release.
 */
export default function AutomateProtection() {
  const vault4663 = useGate('vault', 4663)
  const exit4663 = useGate('autoExit', 4663)
  const vault8453 = useGate('vault', 8453)
  const exit8453 = useGate('autoExit', 8453)
  const vault42161 = useGate('vault', 42161)
  const exit42161 = useGate('autoExit', 42161)
  const anywhere = (gateOpen(vault4663) && gateOpen(exit4663)) || (gateOpen(vault8453) && gateOpen(exit8453)) || (gateOpen(vault42161) && gateOpen(exit42161))
  if (!anywhere) return null
  return (
    <section className="dm-card dm-auto-plain animate-rise" data-feature="protection" aria-labelledby="automate-protection">
      <div className="dm-plate dm-dots-plate dm-auto-plain-plate" aria-hidden="true">
        <ExitThumb />
      </div>
      <div className="dm-auto-plain-body">
        <Display as="h2" id="automate-protection" className="dm-display-card">
          Auto-exit
        </Display>
        <p className="dm-auto-plain-line">When the price reaches the end of your range, Domino closes the position and sends the tokens to your wallet. 0.2% only if it closes.</p>
      </div>
      <LinkButton href="#/positions" variant="outline" size="lg" className="dm-auto-plain-go" data-v2in-protection="">
        Choose a position
        <IconChevronRight />
      </LinkButton>
    </section>
  )
}
