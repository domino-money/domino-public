/** Public confirmation through the existing same-origin gate and Rugged node. No wallet methods or RPC URL. */
import { postRoute } from './chainRoutes'
export interface ConfirmationRead {
  read(hash: string): Promise<{ transaction: unknown; receipt: unknown; block: unknown }>
  finalized(): Promise<unknown>
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export function createConfirmationReads(): ConfirmationRead {
  const pending = new Map<string, Promise<Record<string, unknown>>>()
  let final: { at: number; value: unknown } | null = null
  const deferUntil = new Map<string, number>()
  const read = (key: string, body: unknown, timeout: number) => {
    const existing = pending.get(key)
    if (existing) return existing
    const now = Date.now()
    const lane = key === 'finality' ? 'finality' : 'receipt'
    const deferred = deferUntil.get(lane) ?? 0
    if (now < deferred) return Promise.reject(Object.assign(new Error('confirmation_unavailable'), { retryAfterMs: deferred - now }))
    if (pending.size >= 32) return Promise.reject(new Error('confirmation_busy'))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const work = postRoute('confirmation', body, { signal: controller.signal }).then(answer => {
      if (!answer.ok) {
        deferUntil.set(lane, Math.max(deferUntil.get(lane) ?? 0, Date.now() + answer.retryAfterMs))
        throw Object.assign(new Error('confirmation_unavailable'), { retryAfterMs: answer.retryAfterMs })
      }
      if (!object(answer.value) || answer.value.v !== 1) throw new Error('invalid_confirmation')
      return answer.value
    }).finally(() => { clearTimeout(timer); pending.delete(key) })
    pending.set(key, work)
    return work
  }
  return {
    async read(hash) {
      if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('invalid_confirmation_hash')
      const answer = await read(hash, { hash }, 10_000)
      if (!('transaction' in answer) || !('receipt' in answer) || !('block' in answer)) throw new Error('invalid_confirmation')
      return { transaction: answer.transaction, receipt: answer.receipt, block: answer.block }
    },
    async finalized() {
      if (final && Date.now() - final.at < 2000) return final.value
      const answer = await read('finality', { finality: true }, 2000)
      if (!('finalized' in answer)) throw new Error('invalid_confirmation')
      final = { at: Date.now(), value: answer.finalized }
      return final.value
    },
  }
}
export const confirmationReads = createConfirmationReads()
