/** Fixed, bounded public receipt reads. Uses the existing node transport and secret; no RPC configuration changes. */
import { RPC_URL, type ChainInit } from './owned'

const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/
const DATA = /^0x(?:[0-9a-f]{2})*$/
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export type ConfirmationRequest = { hash: string } | { finality: true }
export function confirmationRequestOf(body: Record<string, unknown>): ConfirmationRequest | null {
  if (Object.keys(body).length !== 1) return null
  if (typeof body.hash === 'string' && HASH.test(body.hash)) return { hash: body.hash }
  return body.finality === true ? { finality: true } : null
}

function blockOf(raw: unknown): { number: string; hash: string } | null {
  if (raw === null) return null
  if (!object(raw) || typeof raw.number !== 'string' || !QUANTITY.test(raw.number) || typeof raw.hash !== 'string' || !HASH.test(raw.hash)) throw new Error('invalid_confirmation')
  return { number: raw.number, hash: raw.hash }
}

/** Only the fields the closed transaction clients verify; no upstream URLs, errors, or unrelated block data. */
export async function confirmationOnNode(fetchChain: (input: string, init: RequestInit) => Promise<Response>, asked: ConfirmationRequest): Promise<Response> {
  const read = async (method: string, params: unknown[]) => {
    const init: ChainInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), replyBytes: 262_144 }
    const response = await fetchChain(RPC_URL, init)
    if (response.status !== 200) throw response
    const body: unknown = await response.json()
    if (!object(body) || body.id !== 1 || body.jsonrpc !== '2.0' || !('result' in body) || body.error) throw new Error('confirmation_unavailable')
    return body.result
  }
  try {
    let result: unknown
    if ('finality' in asked) result = { finalized: blockOf(await read('eth_getBlockByNumber', ['finalized', false])) }
    else {
      const tx = await read('eth_getTransactionByHash', [asked.hash])
      const receipt = await read('eth_getTransactionReceipt', [asked.hash])
      let transaction: Record<string, unknown> | null = null
      let included: Record<string, unknown> | null = null
      let block: ReturnType<typeof blockOf> = null
      if (tx !== null) {
        if (!object(tx) || tx.hash !== asked.hash || typeof tx.from !== 'string' || !ADDRESS.test(tx.from) || typeof tx.to !== 'string' || !ADDRESS.test(tx.to) || typeof tx.input !== 'string' || !DATA.test(tx.input) || tx.input.length > 65_538 || ![tx.value, tx.nonce].every(v=>typeof v === 'string' && QUANTITY.test(v))) throw new Error('invalid_confirmation')
        transaction = { hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, value: tx.value, nonce: tx.nonce, chainId: tx.chainId }
      }
      if (receipt !== null) {
        if (!object(receipt) || receipt.transactionHash !== asked.hash || typeof receipt.blockHash !== 'string' || !HASH.test(receipt.blockHash) || ![receipt.blockNumber, receipt.gasUsed, receipt.effectiveGasPrice].every(v=>typeof v === 'string' && QUANTITY.test(v)) || !['0x0','0x1'].includes(String(receipt.status)) || typeof receipt.from !== 'string' || !ADDRESS.test(receipt.from) || !Array.isArray(receipt.logs) || receipt.logs.length > 512) throw new Error('invalid_confirmation')
        const logs = receipt.logs.map((log: unknown) => {
          if (!object(log) || typeof log.address !== 'string' || !ADDRESS.test(log.address) || !Array.isArray(log.topics) || log.topics.length > 4 || !log.topics.every(t=>typeof t==='string'&&HASH.test(t)) || typeof log.data !== 'string' || !DATA.test(log.data) || log.data.length > 32_770 || typeof log.logIndex !== 'string' || !QUANTITY.test(log.logIndex) || (log.removed !== undefined && log.removed !== false)) throw new Error('invalid_confirmation')
          return { address: log.address, topics: log.topics, data: log.data, logIndex: log.logIndex }
        })
        included = { transactionHash: receipt.transactionHash, from: receipt.from, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, status: receipt.status, logs }
        block = blockOf(await read('eth_getBlockByNumber', [receipt.blockNumber, false]))
      }
      result = { transaction, receipt: included, block }
    }
    const text = JSON.stringify({ v: 1, ...result as Record<string, unknown> })
    if (new TextEncoder().encode(text).byteLength > 262_144) throw new Error('invalid_confirmation')
    return new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (!(error instanceof Response) || error.status !== 429) throw error
    const askedSeconds = Number(error.headers.get('Retry-After') ?? Number.NaN)
    const seconds = Number.isFinite(askedSeconds) && askedSeconds >= 0 ? Math.max(1, Math.min(300, Math.ceil(askedSeconds))) : 5
    await error.body?.cancel().catch(() => undefined)
    return new Response(JSON.stringify({ v: 1, error: 'rate_limited' }), { status: 429,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': String(seconds) } })
  }
}
