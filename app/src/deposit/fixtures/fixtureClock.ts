/**
 * A clock the lab and the tests move by hand. The deposit fixtures are dated
 * 2027-01-15; nothing in the lab compares them with the device's time, so the
 * lab renders the same whenever it runs. Wall time here is display-only.
 */
import type { Clock } from '../../lib/clock'

export interface FixtureClock extends Clock {
  /** Moves the monotonic clock forward, firing any timer that falls due. */
  advance(ms: number): void
  /** Sets the monotonic clock (forward or back); timers due by then fire. */
  setMono(ms: number): void
}

export function createFixtureClock({ monoStartMs = 0, wallMs }: { monoStartMs?: number; wallMs: number }): FixtureClock {
  let mono = monoStartMs
  let timers: Array<{ at: number; callback: () => void; live: boolean }> = []
  const fireDue = () => {
    for (;;) {
      const due = timers.filter((timer) => timer.live && timer.at <= mono).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      due.live = false
      due.callback()
    }
    timers = timers.filter((timer) => timer.live)
  }
  return {
    monoMs: () => mono,
    wallMs: () => wallMs + (mono - monoStartMs),
    setTimer(callback, ms) {
      const timer = { at: mono + Math.max(0, ms), callback, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    },
    advance(ms) {
      mono += ms
      fireDue()
    },
    setMono(ms) {
      mono = ms
      fireDue()
    },
  }
}
