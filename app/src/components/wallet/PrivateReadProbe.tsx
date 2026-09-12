import { useSyncExternalStore } from 'react'
import { privateScope } from '../../session/controller'
import { privateKey, usePrivateQuery } from '../../session/privateQuery'
import { probeReads } from '../../session/testProbe'
import { useSession } from '../../wallet/session'

/**
 * Test builds only. A private read through the real usePrivateQuery hook,
 * started once a browser test arms it, under whatever scope the session has.
 * Its answer is rendered, hidden, so a test can check that an answer landing
 * after a switch is never shown to the next account or session.
 */
export function PrivateReadProbe() {
  const armed = useSyncExternalStore(probeReads.subscribe, probeReads.isArmed)
  return armed ? <ArmedRead /> : null
}

function ArmedRead() {
  const scope = privateScope(useSession())
  const read = usePrivateQuery<string>(scope, ['probe-read'], (signal) =>
    probeReads.start(scope ? privateKey(scope, 'probe-read').join('|') : 'signed-out', signal),
  )
  return (
    <output hidden data-testid="private-probe">
      {read.data ?? ''}
    </output>
  )
}
