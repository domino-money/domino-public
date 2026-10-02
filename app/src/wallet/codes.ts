/**
 * Every EIP-1193 error code an error carries, wherever its wallet or viem wrapped it: MetaMask Mobile puts its 4902
 * under `data.originalError`, viem under `cause`, others under `error` or `data` (2026-10-01, audit C1). Outermost first.
 */
export function codesOf(error: unknown): number[] {
  const codes: number[] = []
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 6) return
    const node = value as { code?: unknown; cause?: unknown; data?: unknown; originalError?: unknown; error?: unknown }
    if (typeof node.code === 'number') codes.push(node.code)
    for (const next of [node.cause, node.data, node.originalError, node.error]) walk(next, depth + 1)
  }
  walk(error, 0)
  return codes
}
