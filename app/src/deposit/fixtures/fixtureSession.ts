/**
 * A synthetic signed-in session for the deposit fixture lab. Imported only by
 * the lab screen and the tests (tests/consumer.guard.test.mjs).
 *
 * The fixtures' owner is 0xabab…abab, an address with no key, so the lab
 * cannot sign in as it through the real session, and rewriting the fixtures
 * would mean re-encoding mint calldata. This port is always signed in as that
 * owner instead. It cannot make a real private request: the lab's transport
 * is the fixture transport, and the CSRF it lends is a constant that says it
 * is not a session. Denials are only recorded, for the tests to read.
 */
import type { DenialCode, Lower, SessionPort, SessionSnapshot } from '../../session/port'

export const FIXTURE_OWNER: Lower = '0xabababababababababababababababababababab'
export const FIXTURE_CSRF = 'fixture-csrf-not-a-session'
/** The synthetic session's connector instance: there is no wallet behind it. */
export const FIXTURE_CONNECTOR = 'fixture-connector-not-a-wallet'

export interface FixtureSessionPort extends SessionPort {
  denials(): ReadonlyArray<{ code: DenialCode; epoch: number }>
}

export function createFixtureSessionPort(owner: Lower = FIXTURE_OWNER): FixtureSessionPort {
  const snapshot: SessionSnapshot = { kind: 'signed_in', owner, chainId: 4663, epoch: 1, connectorUid: FIXTURE_CONNECTOR }
  const denials: Array<{ code: DenialCode; epoch: number }> = []
  return {
    csrfAccess: true,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    withCsrf: (_epoch, fn) => fn(FIXTURE_CSRF),
    reportDenial(code, epoch) {
      denials.push({ code, epoch })
    },
    denials: () => denials,
  }
}
