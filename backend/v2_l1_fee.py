"""The L1 data fee of one V2 transaction, apart from its L2 execution gas, per rollup stack.

- OP Stack (Base): the GasPriceOracle predeploy prices the unsigned
  transaction itself. `getL1Fee(bytes)` compresses it as the sequencer does
  (FastLZ since Fjord) and is the estimate; `getL1FeeUpperBound(uint256)`
  assumes incompressible bytes and is the bound. Both are views of an ordinary
  contract, so a planner asks them inside a Multicall3 read it already makes
  (`op_reads`): no extra billed call.
- Arbitrum Nitro (Robinhood, Arbitrum One): NodeInterface (0xc8, answered by
  the node, not a contract a Multicall can reach) estimates the L1 component
  in L2 gas units, with Nitro's padding on the L1 price, and the L2 base fee
  that prices it: `gasEstimateL1Component(to, false, data)`, one eth_call
  (`nitro_estimate`). Nitro charges it as gas, on top of the execution gas a
  simulation reports.

The transaction priced is the unsigned EIP-1559 envelope a wallet would send:
the chain id, the call's target, value and data, an empty access list, and
placeholders at realistic sizes for the fields only the wallet fixes (nonce,
fees, gas limit). They move the compressed size by a few bytes at most.
Failures are reported as `unavailable`, never raised: the cost is information,
the plan stands without it.
"""
from eth_abi import decode, encode
from eth_hash.auto import keccak

from discovery import DataError

OP_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000f'
NODE_INTERFACE = '0x00000000000000000000000000000000000000c8'
SOURCES = {'op-stack': 'op_gas_price_oracle', 'arbitrum-nitro': 'nitro_node_interface'}
# The fields the wallet fixes, at realistic sizes with every bit set.
NONCE_PLACEHOLDER = 0xffff
PRIORITY_FEE_PLACEHOLDER = 0xffffff
MAX_FEE_PLACEHOLDER = 0xffffffff
GAS_PLACEHOLDER = 0xffffff
EIP1559 = 2


class _Function:
    """A view function: selector, calldata and decoded outputs (a ReadPlan entry)."""

    def __init__(self, signature, inputs, outputs):
        self.signature, self.inputs, self.outputs = signature, tuple(inputs), tuple(outputs)
        self.selector = '0x' + keccak(signature.encode())[:4].hex()

    def calldata(self, *values):
        return self.selector + encode(list(self.inputs), list(values)).hex()


GET_L1_FEE = _Function('getL1Fee(bytes)', ('bytes',), ('uint256',))
GET_L1_FEE_UPPER_BOUND = _Function('getL1FeeUpperBound(uint256)', ('uint256',), ('uint256',))
GAS_ESTIMATE_L1_COMPONENT = _Function('gasEstimateL1Component(address,bool,bytes)', ('address', 'bool', 'bytes'),
                                      ('uint64', 'uint256', 'uint256'))


# ------------------------------------------------------------------ RLP
def _length(prefix, size):
    if size <= 55:
        return bytes([prefix + size])
    encoded = size.to_bytes((size.bit_length() + 7) // 8, 'big')
    return bytes([prefix + 55 + len(encoded)]) + encoded


def rlp(item):
    """Recursive-length prefix: bytes, non-negative ints and lists of them."""
    if isinstance(item, list):
        payload = b''.join(rlp(element) for element in item)
        return _length(0xc0, len(payload)) + payload
    if isinstance(item, int):
        if item < 0:
            raise ValueError('rlp_negative')
        item = item.to_bytes((item.bit_length() + 7) // 8, 'big')
    if len(item) == 1 and item[0] < 0x80:
        return item
    return _length(0x80, len(item)) + item


def unsigned_transaction(chain_id, to, value, data, *, nonce=NONCE_PLACEHOLDER,
                         max_priority_fee=PRIORITY_FEE_PLACEHOLDER, max_fee=MAX_FEE_PLACEHOLDER,
                         gas=GAS_PLACEHOLDER):
    """0x02 ‖ rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data, accessList])."""
    payload = bytes.fromhex(data[2:]) if isinstance(data, str) else bytes(data)
    return bytes([EIP1559]) + rlp([chain_id, nonce, max_priority_fee, max_fee, gas, bytes.fromhex(to[2:]), value,
                                   payload, []])


# ------------------------------------------------------------- reports
def unavailable(chain, block):
    return {'status': 'unavailable', 'source': SOURCES[chain.stack], 'block': str(block.number), 'weiRaw': None,
            'upperBoundWeiRaw': None, 'l1GasUnits': None, 'l2BaseFeeWei': None, 'transactionBytes': None}


def op_reads(reads, transaction):
    """Add the GasPriceOracle's estimate and bound for `transaction` to a ReadPlan; returns their slots."""
    return (reads.add(OP_GAS_PRICE_ORACLE, GET_L1_FEE, transaction),
            reads.add(OP_GAS_PRICE_ORACLE, GET_L1_FEE_UPPER_BOUND, len(transaction)))


def op_result(chain, block, answers, slots, transaction):
    """The GasPriceOracle's answers as a report; `unavailable` when either failed."""
    fee, bound = (answers[slot] for slot in slots)
    if fee is None or bound is None:
        return unavailable(chain, block)
    return {'status': 'ok', 'source': SOURCES[chain.stack], 'block': str(block.number), 'weiRaw': str(fee[0]),
            'upperBoundWeiRaw': str(bound[0]), 'l1GasUnits': None, 'l2BaseFeeWei': None,
            'transactionBytes': len(transaction)}


def nitro_estimate(chain, rpc, block, to, data):
    """NodeInterface's L1 component for a call to `to` with `data`: one eth_call
    (on a client of its own: a node that refuses it ends only that client)."""
    try:
        raw = rpc.request('eth_call', [{'to': NODE_INTERFACE, 'gas': hex(10_000_000),
                                        'data': GAS_ESTIMATE_L1_COMPONENT.calldata(to, False, bytes.fromhex(data[2:]))},
                                       block.tag])
    except DataError as error:
        if str(error) == 'read_deadline_exceeded':
            raise
        return unavailable(chain, block)
    try:
        gas, base_fee, _ = decode(list(GAS_ESTIMATE_L1_COMPONENT.outputs), bytes.fromhex(raw[2:]))
    except Exception:  # no NodeInterface (an empty answer) or an undecodable one
        return unavailable(chain, block)
    return {'status': 'ok', 'source': SOURCES[chain.stack], 'block': str(block.number), 'weiRaw': str(gas * base_fee),
            'upperBoundWeiRaw': None, 'l1GasUnits': str(gas), 'l2BaseFeeWei': str(base_fee),
            'transactionBytes': None}
