import { IconChevronRight } from '../../components/icons'
import { Button, LinkButton } from '../../components/ui'
import { gateOpen, useGate } from './gate'

/**
 * Automate's way to Auto-exit (Domino V2 integration; spec F7 §4.1, §5.1; decisions #18, #25), beside the plain position
 * the other automations start from, in that card's own look (screens/Automate.tsx PlainCard).
 *
 * Changed on purpose 2026-10-06 (the owner's point 5; rugged97: "this stop loss-take profit product was named wrong. It is
 * AUTO-EXIT. When the price hits the edge of the range we close the position automatically and send the tokens to the
 * wallet"): its name and one line, and shown wherever Domino's automation and auto-exit are open on any of its three
 * networks. The dedicated picker uses those same networks and opens the existing V2 Auto-exit dialog.
 */
export default function AutomateProtection() {
  const vault4663 = useGate('vault', 4663)
  const exit4663 = useGate('autoExit', 4663)
  const vault8453 = useGate('vault', 8453)
  const exit8453 = useGate('autoExit', 8453)
  const vault42161 = useGate('vault', 42161)
  const exit42161 = useGate('autoExit', 42161)
  const anywhere = (gateOpen(vault4663) && gateOpen(exit4663)) || (gateOpen(vault8453) && gateOpen(exit8453)) || (gateOpen(vault42161) && gateOpen(exit42161))
  const pending = [vault4663, exit4663, vault8453, exit8453, vault42161, exit42161].some((gate) => gate === null)
  return (
    <>
      {anywhere ? <LinkButton href="#/sequence/protection" variant="outline" data-v2in-protection="">
        Choose a position
        <IconChevronRight />
      </LinkButton> : <Button disabled>{pending ? 'Checking availability…' : 'Unavailable right now'}</Button>}
      {/* Kept on purpose 2026-10-15 (pack 7): a gate that says why an action can't be taken stays (the coordinator's rule);
          this disabled button's own words are that gate, on Automate, as its setup gates. */}
    </>
  )
}
