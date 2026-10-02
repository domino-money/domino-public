// The screens' own styles (styles/screens.css, F8): loaded with the first screen that needs them, never on Home's first paint.
import '../../../styles/screens.css'
/**
 * The second chain's section as the app routes to it (2026-10-01, the chain2 workstream, part B): ElysiumSection with the
 * page's one admitted transport for the chain (../transport.ts) and the closed wallet signer (../signer.ts). App.tsx
 * imports this file lazily, from the #/elysium route only, so the Robinhood screens carry none of it.
 */
import ElysiumSection from './ElysiumSection'
import { addChain, elysiumSignerFor } from '../signer'
import { elysiumTransport } from '../transport'

export default function ElysiumEntry() {
  return <ElysiumSection transport={elysiumTransport} signerFor={elysiumSignerFor} addChain={addChain} />
}
