// Executable-shape fixture only, never a public price/quote source. The producer
// contract fixtures deliberately carry dummy command inputs; the financial SDK
// independently admits the inner commands before simulating the whole sequence.
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters } from 'viem';

const ZERO = '0x' + '0'.repeat(40), SELF = '0x' + '0'.repeat(39) + '2';
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const ROUTER = '0x204faca1764b154221e35c0d20abb3c525710498';
export function routeTransactions(preview) {
  const p = preview, r = p.request, q = p.uniswap, k = r.poolKey;
  const deadline = p.requestedAt + 1800, gross = BigInt(r.amountRaw);
  const tuple = [[k.currency0, k.currency1, k.fee_pips, k.tick_spacing, k.hooks], r.tokenIn === k.currency0, gross,
    BigInt(q.minimumAmountOutRaw) + BigInt(q.minimumFeeRaw), 0n, '0x'];
  const swap = encodeAbiParameters(parseAbiParameters('((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)'), [tuple]);
  const settle = encodeAbiParameters(parseAbiParameters('address,uint256,bool'), [r.tokenIn, gross, true]);
  const take = encodeAbiParameters(parseAbiParameters('address,address,uint256'), [p.tokenOut, SELF, 0n]);
  const v4 = encodeAbiParameters(parseAbiParameters('bytes,bytes[]'), ['0x060b0e', [swap, settle, take]]);
  const fee = encodeAbiParameters(parseAbiParameters('address,address,uint256'), [p.tokenOut, p.feeRecipient, 65n * 10n ** 14n]);
  const receive = encodeAbiParameters(parseAbiParameters('address,address,uint256'), [p.tokenOut, r.owner, BigInt(q.minimumAmountOutRaw)]);
  const refund = encodeAbiParameters(parseAbiParameters('address,address,uint256'), [r.tokenIn, r.owner, 0n]);
  return {
    approval: r.tokenIn === ZERO ? null : { token: r.tokenIn, spender: PERMIT2, amountRaw: r.amountRaw },
    permitTransaction: r.tokenIn === ZERO ? null : { to: PERMIT2, valueRaw: '0',
      data: encodeFunctionData({ abi: parseAbi(['function approve(address,address,uint160,uint48)']), functionName: 'approve', args: [r.tokenIn, ROUTER, gross, deadline] }) },
    swapTransaction: { to: ROUTER, valueRaw: r.tokenIn === ZERO ? r.amountRaw : '0',
      data: encodeFunctionData({ abi: parseAbi(['function execute(bytes,bytes[],uint256) payable']), functionName: 'execute', args: ['0x10070404', [v4, fee, receive, refund], BigInt(deadline)] }) },
  };
}
