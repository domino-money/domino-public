import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, zeroAddress, type Address, type Hex } from 'viem'
import type { PoolKey } from './setup.js'
import type { BatchCall } from './batch.js'
import { ROUTE_FEE_RECIPIENT, ROUTE_PERMIT2, UNIVERSAL_ROUTER } from './pin.js'

/** Structural SDK boundary: the caller validates the complete producer contract.
 * Keep this SDK independently compilable for the EVM acceptance harness. */
interface RoutedPreview {
  decision: string; chainId: number; tokenOut: string; feeRecipient: string; requestedAt: number; expiresAt: number
  request: {
    owner: string; chainId: number; tokenIn: string; amountRaw: string; slippageBps: number; poolId: string
    poolKey: { currency0: string; currency1: string; fee_pips: number; tick_spacing: number; hooks: string }
  }
  uniswap: {
    amountOutRaw: string; minimumAmountOutRaw: string; feeRaw: string
    swapTransaction: { to: string; data: string; valueRaw: string } | null
    permitTransaction: { to: string; data: string; valueRaw: string } | null
    approval: { token: string; spender: string; amountRaw: string } | null
  } | null
}
/** The page supplies the reviewed quote, never an arbitrary list of prefix calls. */
export interface RoutedSwapInput { preview: RoutedPreview; totalInput: bigint }
export interface CheckedRoutedSwap {
  tokenIn: Address; tokenOut: Address; gross: bigint; minimum: bigint; fee: bigint; expiresAt: number; deadline: bigint
  permit: BatchCall | null; swap: BatchCall
}
export const routePermitAbi = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint160' }, { type: 'uint48' }], outputs: [] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }] },
] as const
export const routeExecuteAbi = [{ name: 'execute', type: 'function', stateMutability: 'payable', inputs: [{ type: 'bytes' }, { type: 'bytes[]' }, { type: 'uint256' }], outputs: [] }] as const
function fail(): never { throw new Error('invalid_routed_swap') }
const lower = (address: string) => address.toLowerCase() as Address
const pair = [{ type: 'bytes' }, { type: 'bytes[]' }] as const
const payment = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] as const
const amount = [{ type: 'address' }, { type: 'uint256' }] as const
const sender = '0x0000000000000000000000000000000000000001', self = '0x0000000000000000000000000000000000000002'

/**
 * Closed command admission, independently of the producer's selector validation.
 * Sources: Uniswap universal-router Dispatcher/Payments and v4-periphery V4Router.
 * Only exact-input swaps and their payments are admitted. Position-manager calls,
 * arbitrary permits, subplans and allow-revert flags fall back to the pool lane.
 * All owner-funded payments name this input; all output pays this owner, with one
 * 65-bps fee and an on-chain floor AFTER that fee. Existing unrelated allowances
 * cannot be reached. Intermediate pool currencies/hooks stay generic.
 */
function commandsSafe(commands: Hex, inputs: readonly Hex[], owner: Address, tokenIn: Address, tokenOut: Address, gross: bigint, minimum: bigint) {
  const codes = commands.slice(2).match(/.{2}/g)?.map(value => parseInt(value, 16)) ?? []
  if (!codes.length || codes.length !== inputs.length || codes.length > 32) fail()
  const isOwner = (value: string) => [owner, sender].includes(lower(value))
  const isSelf = (value: string) => [UNIVERSAL_ROUTER, self].includes(lower(value))
  let fees = 0, floor = false, swaps = 0
  const fee = (token: string, recipient: string, bps: bigint, expected: bigint) => {
    if (!swaps || lower(token) !== tokenOut || lower(recipient) !== ROUTE_FEE_RECIPIENT || bps !== expected || ++fees !== 1 || floor) fail()
  }
  const paid = (token: string, recipient: string, min: bigint) => {
    if (!isOwner(recipient)) fail()
    if (lower(token) === tokenOut && fees !== 1) fail()
    if (lower(token) === tokenOut && min >= minimum && fees === 1) floor = true
  }
  const ownerPay = (token: string, value: bigint, open = false) => {
    if (lower(token) !== tokenIn || value > gross || (!open && value === 0n)) fail()
  }
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index], input = inputs[index]
    if (code === 0x00 || code === 0x08) {
      // The current router includes a sixth minHopPrice array; older encodings
      // use five words. Decode the shared identity/payment fields only.
      const values = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: code === 0 ? 'bytes' : 'address[]' }, { type: 'bool' }], input)
      const [recipient, value, , path, user] = values
      if (!isSelf(recipient) || floor || fees) fail()
      let start: string
      if (typeof path === 'string') {
        if (path.length < 88 || (path.length - 42) % 46 !== 0) fail()
        start = path.slice(0, 42)
      } else { if (!Array.isArray(path) || path.length < 2 || path.length > 16) fail(); start = path[0] }
      if (user) ownerPay(start, value)
      swaps++
    } else if (code === 0x02) {
      const [token, recipient, value] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint160' }], input)
      ownerPay(token, value); if (!isSelf(recipient) || floor) fail()
    } else if (code === 0x04) {
      const [token, recipient, min] = decodeAbiParameters(payment, input)
      paid(token, recipient, min)
    } else if (code === 0x06 || code === 0x07) {
      const [token, recipient, portion] = decodeAbiParameters(payment, input)
      fee(token, recipient, portion, code === 6 ? 65n : 65n * 10n ** 14n)
    } else if (code === 0x0b || code === 0x0c) {
      const [recipient, value] = decodeAbiParameters(amount, input)
      if (code === 0x0b) {
        if (tokenIn !== zeroAddress || !isSelf(recipient) || (value > gross && value !== 2n ** 255n) || floor) fail()
      } else if (!isSelf(recipient)) {
        if (tokenOut !== zeroAddress) fail()
        paid(zeroAddress, recipient, value)
      }
    } else if (code === 0x10) {
      if (floor || fees) fail()
      const [actions, values] = decodeAbiParameters(pair, input)
      const actionCodes = actions.slice(2).match(/.{2}/g)?.map(value => parseInt(value, 16)) ?? []
      if (!actionCodes.length || actionCodes.length !== values.length || values.length > 32) fail()
      for (let j = 0; j < values.length; j++) {
        const action = actionCodes[j], data = values[j]
        if (action === 0x06 || action === 0x07) {
          // Exact-input pool swaps do not pull wallet assets; settlement below
          // is the only owner-funded leg. Hooks may affect the pool result,
          // never the admitted recipient or token allowance.
          if (floor || fees) fail(); swaps++
        } else if (action === 0x0b) {
          const [token, value, user] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], data)
          if (user) ownerPay(token, value, true)
        } else if (action === 0x0c) {
          const [token, value] = decodeAbiParameters(amount, data); ownerPay(token, value)
        } else if (action === 0x0e) {
          const [token, recipient] = decodeAbiParameters(payment, data)
          if (!isSelf(recipient)) { if (!isOwner(recipient) || lower(token) === tokenOut) fail() }
        } else if (action === 0x0f) {
          const [token, min] = decodeAbiParameters(amount, data); paid(token, owner, min)
        } else if (action === 0x10) {
          const [token, recipient, bps] = decodeAbiParameters(payment, data); fee(token, recipient, bps, 65n)
        } else fail()
      }
    } else fail()
  }
  if (!swaps || fees !== 1 || !floor) fail()
}

export function checkRoutedSwap(input: RoutedSwapInput, key: PoolKey, amount0: bigint, amount1: bigint, owner: Address,
  feeRecipient: Address, now: number, validate: ((value: unknown) => boolean) | undefined, expired = false): CheckedRoutedSwap {
  try {
    const p = input.preview, request = p.request, route = p.uniswap
    if (!validate?.({ contractVersion: '1.1.0', preview: p }) || p.decision !== 'uniswap' || !route || !route.swapTransaction
      || request.owner !== owner || request.chainId !== 4663 || p.chainId !== 4663 || p.feeRecipient !== feeRecipient || p.feeRecipient !== ROUTE_FEE_RECIPIENT
      || (!expired && (p.expiresAt <= now || p.requestedAt > now + 5))) fail()
    const expected = { currency0: key.currency0, currency1: key.currency1, fee_pips: key.fee, tick_spacing: key.tickSpacing, hooks: key.hooks }
    if (Object.entries(expected).some(([field, value]) => request.poolKey[field as keyof typeof expected] !== value)) fail()
    const components = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
    if (request.poolId !== keccak256(encodeAbiParameters(components, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]))) fail()
    const tokenIn = lower(request.tokenIn), tokenOut = lower(p.tokenOut), gross = BigInt(request.amountRaw), minimum = BigInt(route.minimumAmountOutRaw)
    if (input.totalInput < gross || input.totalInput >= 2n ** 128n || minimum <= 0n || minimum >= 2n ** 128n
      || minimum < BigInt(route.amountOutRaw) * BigInt(10000 - request.slippageBps) / 10000n
      || ![key.currency0, key.currency1].includes(tokenIn) || tokenOut !== (tokenIn === key.currency0 ? key.currency1 : key.currency0)
      || amount0 !== (tokenIn === key.currency0 ? input.totalInput - gross : minimum)
      || amount1 !== (tokenIn === key.currency1 ? input.totalInput - gross : minimum)) fail()
    const swap = route.swapTransaction
    if (swap.to !== UNIVERSAL_ROUTER || BigInt(swap.valueRaw) !== (tokenIn === zeroAddress ? gross : 0n)) fail()
    const decoded = decodeFunctionData({ abi: routeExecuteAbi, data: swap.data as Hex })
    const [commands, inputs, deadline] = decoded.args
    if (deadline <= BigInt(p.requestedAt) || deadline > BigInt(p.requestedAt + 3600) || (!expired && deadline <= BigInt(Math.floor(now)))) fail()
    // Require canonical ABI as well: no hidden/trailing arguments accepted.
    if (encodeFunctionData({ abi: routeExecuteAbi, functionName: 'execute', args: decoded.args }).toLowerCase() !== swap.data.toLowerCase()) fail()
    commandsSafe(commands, inputs, owner, tokenIn, tokenOut, gross, minimum)
    let permit: BatchCall | null = null
    if (tokenIn !== zeroAddress) {
      const approval = route.approval, transaction = route.permitTransaction
      if (!approval || approval.token !== tokenIn || approval.spender !== ROUTE_PERMIT2 || BigInt(approval.amountRaw) !== gross || !transaction
        || transaction.to !== ROUTE_PERMIT2 || transaction.valueRaw !== '0') fail()
      const data = encodeFunctionData({ abi: routePermitAbi, functionName: 'approve', args: [tokenIn, UNIVERSAL_ROUTER, gross, Number(deadline)] })
      if (transaction.data.toLowerCase() !== data) fail()
      permit = Object.freeze({ to: ROUTE_PERMIT2, data, value: '0x0' })
    } else if (route.approval || route.permitTransaction) fail()
    return Object.freeze({ tokenIn, tokenOut, gross, minimum, fee: BigInt(route.feeRaw), expiresAt: p.expiresAt, deadline, permit,
      swap: Object.freeze({ to: UNIVERSAL_ROUTER, data: swap.data as Hex, value: numberToHex(BigInt(swap.valueRaw)) }) })
  } catch { return fail() }
}
