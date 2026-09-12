/**
 * Test builds only (`__DOMINO_TEST_HOOKS__`): a private read the browser tests
 * control, so they can prove what happens to one that is still in flight when
 * the account, network or session changes. Nothing here runs, or is bundled,
 * in any other build: every caller sits behind the build flag.
 *
 * The read deliberately ignores its AbortSignal and resolves only when the test
 * says so, like a server answer that arrives after the switch no matter what.
 * Whatever keeps that late answer out of view is the app's, not this probe's.
 */
export interface ProbeRead {
  /** The private key the read was started under, joined with '|'. */
  key: string
  aborted: boolean
  settled: boolean
}

interface Pending extends ProbeRead {
  resolve(value: string): void
}

const listeners = new Set<() => void>()
const reads: Pending[] = []
let armed = false

export const probeReads = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  isArmed: () => armed,
  arm() {
    armed = true
    for (const listener of listeners) listener()
  },
  /** The query function the probe component passes to usePrivateQuery. */
  start(key: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve) => {
      const read: Pending = { key, aborted: signal.aborted, settled: false, resolve }
      signal.addEventListener('abort', () => {
        read.aborted = true
      })
      reads.push(read)
    })
  },
  /** Answers every read not yet answered whose key contains `match`. */
  resolve(match: string, value: string) {
    let count = 0
    for (const read of reads) {
      if (read.settled || !read.key.includes(match)) continue
      read.settled = true
      read.resolve(value)
      count += 1
    }
    return count
  },
  log: (): ProbeRead[] => reads.map(({ key, aborted, settled }) => ({ key, aborted, settled })),
}
