/**
 * The position NFTs this browser created, per wallet address, so Positions can
 * list them again on a later visit: no read lists positions by owner, and a
 * position created here should not need its id typed to be seen.
 *
 * Only NFT ids, which are public chain data, keyed by the lowercase address
 * the wallet reported. Nothing here proves ownership: Positions reads each id
 * from chain and shows the owner the chain reports. Storage is optional; when
 * it is unavailable nothing is remembered and nothing breaks.
 */
const KEY = 'domino.positions.created.v1'
/** The most ids kept per wallet, newest first. */
const MAX = 50
const ID = /^[1-9]\d{0,77}$/
const ADDRESS = /^0x[0-9a-f]{40}$/

function read(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw || raw.length > 65_536) return {}
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<string, string[]> = {}
    for (const [address, ids] of Object.entries(value as Record<string, unknown>)) {
      if (ADDRESS.test(address) && Array.isArray(ids)) out[address] = ids.filter((id): id is string => typeof id === 'string' && ID.test(id)).slice(0, MAX)
    }
    return out
  } catch {
    return {}
  }
}

/** Remembers a position this wallet just created. */
export function rememberCreated(address: string, tokenId: string) {
  const owner = address.toLowerCase()
  if (!ADDRESS.test(owner) || !ID.test(tokenId)) return
  const all = read()
  all[owner] = [tokenId, ...(all[owner] ?? []).filter((id) => id !== tokenId)].slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* Storage is optional: the position is on chain whether or not it is listed here. */
  }
}

/** The positions this browser created for `address`, newest first; none for no address. */
export function createdPositions(address: string | null): string[] {
  if (!address) return []
  return read()[address.toLowerCase()] ?? []
}
