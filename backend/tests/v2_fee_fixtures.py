"""TEST FIXTURE: a chain where Uniswap v3 and v4 positions settle their fees as Uniswap computes them.

The fee follower (v2_fees) reads a position's own events and its state at the end of their blocks; this
fake serves both from one model, so a test states what Uniswap would pay and checks the follower found it:
- v4: a position's liquidity and feeGrowthInsideLast in the PoolManager (StateView.getPositionInfo), its
  growth inside now (getFeeGrowthInside), the PositionManager's info, owner and Transfer; every settlement
  pays liquidity x (growth inside - last) / 2^128 at once (Position.update) and emits ModifyLiquidity with the
  PositionManager as sender and the token id as salt.
- v3: the manager's per-token checkpoint and tokensOwed (NonfungiblePositionManager), credited at every
  increase, decrease and collect (a collect of a position with liquidity first settles it, as burn(0) does),
  cut to 128 bits; the pool in range with its ticks' outside growth at zero, so the growth inside is the
  global one.
Growth is scripted per block (`accrue`): what a block's swaps add, before that block's settlements.

The fake enforces what it stands for: eth_getLogs honours the address and every topic position, and refuses
a range wider than the endpoint's maxLogBlocks, as Chainstack refuses past 10,000; aggregate3 refuses more
than MULTICALL_READS reads in one call or a call that may not fail alone; state is answered only at a block
the chain has; eth_chainId and the head are never asked by the follower, so they are refused here.
"""
import copy
from pathlib import Path
import sys

from eth_abi import decode, encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from v2_abi import function  # noqa: E402
from v2_fees import (COLLECT, DECREASE, INCREASE, MODIFY_LIQUIDITY, MULTICALL_READS, TRANSFER, V3_FACTORY,  # noqa: E402
                     V3_MANAGER, V3_POOL, V4_MANAGER, V4_STATE, word)
from v2_fixtures import synthetic_code  # noqa: E402
from v2_quotes import AGGREGATE3  # noqa: E402
from v2_uniswap import PoolRef, v3_pool_address  # noqa: E402

Q128 = 1 << 128
U128, U256 = (1 << 128) - 1, (1 << 256) - 1
ZERO = '0x' + '00' * 20


def block_hash(number, branch=0):
    return '0x' + keccak(f'fee-block:{number}:{branch}'.encode()).hex()


def tx_hash(label):
    return '0x' + keccak(f'fee-tx:{label}'.encode()).hex()


class Revert(Exception):
    pass


class FeeChain:
    def __init__(self, chain, *, head, timestamp0=1_790_000_000, block_time=60, max_log_blocks=500):
        self.chain, self.head, self.timestamp0, self.block_time = chain, head, timestamp0, block_time
        self.max_log_blocks = max_log_blocks
        u = chain.uniswap
        self.npm, self.posm, self.pool_manager = u.v3.positionManager, u.v4.positionManager, u.v4.poolManager
        self.state_view, self.factory, self.multicall3 = u.v4.stateView, u.v3.factory, chain.multicall3
        self.branch = {}
        self.logs = []  # (block, branch, raw)
        self.growth = {}  # range key -> [(block, d0, d1)]
        self.positions = {}  # (dex, token) -> model
        self.log, self.drop = [], set()  # every request; (block, log index) a provider forgets
        self.calls_per_aggregate = []

    # ---------------------------------------------------------- chain
    def hash(self, number):
        return block_hash(number, self.branch.get(number, 0))

    def timestamp(self, number):
        return self.timestamp0 + number * self.block_time

    def header(self, number):
        if not 0 <= number <= self.head:
            return None
        return {'number': hex(number), 'hash': self.hash(number), 'timestamp': hex(self.timestamp(number)),
                'parentHash': self.hash(number - 1) if number else '0x' + '00' * 32}

    def reorg(self, number):
        """Every block from `number` on moves to a new branch, its logs dropped and its state forgotten."""
        branch = max([0, *self.branch.values()]) + 1
        for n in range(number, self.head + 1):
            self.branch[n] = branch
        self.logs = [entry for entry in self.logs if entry[0] < number]
        for model in self.positions.values():
            model['history'] = [entry for entry in model['history'] if entry[0] < number]
            model['owners'] = [entry for entry in model['owners'] if entry[0] < number]
            model['paid'] = [entry for entry in model['paid'] if entry[0] < number]
        for key in self.growth:
            self.growth[key] = [entry for entry in self.growth[key] if entry[0] < number]

    def emit(self, number, address, topics, data=b'', tx='tx'):
        index = sum(1 for entry in self.logs if entry[0] == number)
        raw = {'address': address, 'topics': topics, 'data': '0x' + data.hex(), 'blockNumber': hex(number),
               'blockHash': '0x' + '00' * 32, 'transactionHash': tx_hash(f'{tx}:{number}'),
               'transactionIndex': '0x0', 'logIndex': hex(index), 'removed': False}
        self.logs.append((number, self.branch.get(number, 0), raw))
        return index

    # ---------------------------------------------------------- growth
    def range_key(self, model):
        return (model['pool_key'], model['lower'], model['upper'])

    def accrue(self, number, model_key, d0, d1):
        """A block's swaps add (d0, d1) to the growth inside of that position's range, before its settlements."""
        self.growth.setdefault(self.range_key(self.positions[model_key]), []).append((number, d0, d1))

    def inside(self, key, number):
        entries = [e for e in self.growth.get(key, []) if e[0] <= number]
        return (sum(e[1] for e in entries) & U256, sum(e[2] for e in entries) & U256)

    # ------------------------------------------------------- positions
    def state_at(self, model, number):
        found = None
        for entry in model['history']:
            if entry[0] <= number:
                found = entry
        return found

    def owner_at(self, model, number):
        found = None
        for block, owner in model['owners']:
            if block <= number:
                found = owner
        return found

    def mint(self, dex, token, number, *, owner, liquidity, pool=None, lower=-600, upper=600, tx=None):
        """A position minted at `number` with `liquidity`: its Transfer from zero and its first settlement."""
        pool = pool or PoolRef(dex, '0x' + '0a' * 20, '0x' + '0b' * 20, 3000 if dex == 3 else 500,
                               60 if dex == 3 else 10)
        key = pool.pool_id if dex == 4 else v3_pool_address(self.chain, pool.currency0, pool.currency1, pool.fee)
        model = {'dex': dex, 'token': token, 'pool': pool, 'pool_key': key, 'lower': lower, 'upper': upper,
                 'history': [(number, 0, (0, 0), (0, 0))], 'owners': [(number, owner)], 'paid': [], 'burned': None}
        self.positions[(dex, token)] = model
        tx = tx or f'mint:{token}'
        manager = self.npm if dex == 3 else self.posm
        self.emit(number, manager, [TRANSFER, word(ZERO), word(owner), word(token)], tx=tx)
        self.settle((dex, token), number, liquidity, amounts=(1000, 2000), tx=tx)
        return model

    def settle(self, model_key, number, delta, *, amounts=(0, 0), collect=None, tx='settle'):
        """One settlement in block `number`: an increase (delta > 0), a decrease, or a collect (delta 0; on v3
        `collect` is what it asks, all by default). Returns the fees it credited (v3) or paid (v4)."""
        model = self.positions[model_key]
        block, liquidity, last, owed = self.state_at(model, number)
        inside = self.inside(self.range_key(model), number)
        dex = model['dex']
        fees = tuple(((a - b) & U256) * liquidity // Q128 for a, b in zip(inside, last))
        if dex == 3:
            fees = tuple(f & U128 for f in fees)
            if delta == 0 and liquidity == 0:
                fees, inside = (0, 0), last  # collect() settles only a position with liquidity
            owed = tuple((o + f) & U128 for o, f in zip(owed, fees))
            if delta < 0:
                owed = tuple((o + a) & U128 for o, a in zip(owed, amounts))
            paid = (0, 0)
            if delta == 0:
                asked = collect or owed
                paid = tuple(min(a, o) for a, o in zip(asked, owed))
                owed = tuple(o - p for o, p in zip(owed, paid))
            topics = {1: [INCREASE], -1: [DECREASE], 0: [COLLECT]}[(delta > 0) - (delta < 0)]
            topics = topics + [word(model['token'])]
            data = (encode(['address', 'uint256', 'uint256'], [model['owners'][-1][1], *paid]) if delta == 0
                    else encode(['uint128', 'uint256', 'uint256'], [abs(delta), *amounts]))
            self.emit(number, self.npm, topics, data, tx=tx)
        else:
            owed = None
            data = encode(['int24', 'int24', 'int256', 'bytes32'],
                          [model['lower'], model['upper'], delta, model['token'].to_bytes(32, 'big')])
            self.emit(number, self.pool_manager, [MODIFY_LIQUIDITY, model['pool_key'], word(self.posm)], data, tx=tx)
        model['history'].append((number, liquidity + delta, inside, owed if dex == 3 else (0, 0)))
        model['paid'].append((number, fees))
        return fees

    def transfer(self, model_key, number, to, tx='transfer'):
        model = self.positions[model_key]
        sender = self.owner_at(model, number)
        manager = self.npm if model['dex'] == 3 else self.posm
        self.emit(number, manager, [TRANSFER, word(sender), word(to), word(model['token'])], tx=tx)
        model['owners'].append((number, to))
        if to == ZERO:
            model['burned'] = number

    def earned(self, model_key, number):
        """What Uniswap credited (v3) or paid (v4) the position through `number`, plus what accrued since its last
        settlement there: the truth Fees earned must equal."""
        model = self.positions[model_key]
        paid = [sum(f[i] for b, f in model['paid'] if b <= number) for i in (0, 1)]
        _, liquidity, last, _ = self.state_at(model, number)
        inside = self.inside(self.range_key(model), number)
        accrued = [((a - b) & U256) * liquidity // Q128 for a, b in zip(inside, last)]
        if model['dex'] == 3:
            accrued = [a & U128 for a in accrued]
        return paid[0] + accrued[0], paid[1] + accrued[1]

    # ------------------------------------------------------- transport
    def __call__(self, url, body):
        if isinstance(body, list):
            return [self.answer(item) for item in body]
        return self.answer(body)

    def answer(self, body):
        method, params = body['method'], body['params']
        self.log.append((method, copy.deepcopy(params)))
        reply = {'jsonrpc': '2.0', 'id': body['id']}
        try:
            if method == 'eth_getBlockByNumber':
                if params[0] in ('latest', 'pending', 'safe', 'finalized'):
                    raise AssertionError('the fee follower never reads the head')
                reply['result'] = self.header(int(params[0], 16))
            elif method == 'eth_getLogs':
                reply['result'] = self.get_logs(params[0])
            elif method == 'eth_getCode':
                self.at(params[1])
                reply['result'] = synthetic_code(params[0])
            elif method == 'eth_call':
                number = self.at(params[1])
                if params[0]['to'] != self.multicall3:
                    raise AssertionError('state is read through Multicall3 only')
                reply['result'] = self.aggregate(params[0], number)
            else:
                raise AssertionError(method)
        except Revert:
            reply['error'] = {'code': 3, 'message': 'execution reverted', 'data': '0x'}
        return reply

    def at(self, tag):
        number = int(tag, 16)
        if number > self.head:
            raise AssertionError('state above the head')
        return number

    def get_logs(self, query):
        low, high = int(query['fromBlock'], 16), int(query['toBlock'], 16)
        if high > self.head or high - low + 1 > self.max_log_blocks:
            raise AssertionError(f'log range {low}-{high} past the endpoint limit')
        addresses = query['address'] if isinstance(query['address'], list) else [query['address']]
        out = []
        for number, branch, raw in self.logs:
            if not low <= number <= high or branch != self.branch.get(number, 0) or raw['address'] not in addresses:
                continue
            if (number, int(raw['logIndex'], 16)) in self.drop:
                continue
            if all(want is None or raw['topics'][i] in (want if isinstance(want, list) else [want])
                   for i, want in enumerate(query['topics'])) and len(raw['topics']) >= len(query['topics']):
                out.append(dict(raw, blockHash=self.hash(number)))
        return sorted(out, key=lambda r: (int(r['blockNumber'], 16), int(r['logIndex'], 16)))

    def aggregate(self, call, number):
        if int(call['gas'], 16) > 50_000_000:
            raise AssertionError('above a provider eth_call gas cap')
        (calls,) = decode(['(address,bool,bytes)[]'], bytes.fromhex(call['data'][10:]))
        if call['data'][:10] != AGGREGATE3.selector or not 1 <= len(calls) <= MULTICALL_READS:
            raise AssertionError('aggregate3 of 1 to MULTICALL_READS reads')
        self.calls_per_aggregate.append(len(calls))
        rows = []
        for target, allow, data in calls:
            if not allow:
                raise AssertionError('every read may fail alone')
            try:
                rows.append((True, self.read(target, data, number)))
            except Revert:
                rows.append((False, b''))
        return '0x' + encode(['(bool,bytes)[]'], [rows]).hex()

    def read(self, target, data, number):
        selector = '0x' + data[:4].hex()
        args = data[4:]

        def is_(interface, name, contract):
            fn = function(interface, name)
            return target == contract and selector == fn.selector

        def out(interface, name, values):
            return encode(list(function(interface, name).outputs), list(values))

        def model_of(dex, token):
            model = self.positions.get((dex, token))
            if model is None or model['history'][0][0] > number or (model['burned'] is not None
                                                                    and model['burned'] <= number):
                raise Revert()
            return model

        if is_(V3_MANAGER, 'positions', self.npm):
            (token,) = decode(['uint256'], args)
            model = model_of(3, token)
            _, liquidity, last, owed = self.state_at(model, number)
            p = model['pool']
            return out(V3_MANAGER, 'positions', (0, ZERO, p.currency0, p.currency1, p.fee, model['lower'],
                                                 model['upper'], liquidity, *last, *owed))
        if is_(V3_MANAGER, 'ownerOf', self.npm) or is_(V4_MANAGER, 'ownerOf', self.posm):
            (token,) = decode(['uint256'], args)
            model = model_of(3 if target == self.npm else 4, token)
            return out(V3_MANAGER, 'ownerOf', (self.owner_at(model, number),))
        if is_(V4_MANAGER, 'getPoolAndPositionInfo', self.posm):
            (token,) = decode(['uint256'], args)
            model = self.positions.get((4, token))
            p = model and model['pool']
            key = (ZERO, ZERO, 0, 0, ZERO) if model is None else (p.currency0, p.currency1, p.fee, p.tick_spacing,
                                                                 p.hooks)
            alive = model is not None and model['history'][0][0] <= number and (
                model['burned'] is None or model['burned'] > number)
            info = 0 if not alive else ((int(model['pool_key'], 16) >> 56) << 56 | (model['upper'] & 0xffffff) << 32
                                        | (model['lower'] & 0xffffff) << 8)
            return out(V4_MANAGER, 'getPoolAndPositionInfo', (key, info))
        if is_(V4_STATE, 'getPositionInfo', self.state_view):
            pool_id, owner, lower, upper, salt = decode(['bytes32', 'address', 'int24', 'int24', 'bytes32'], args)
            if owner != self.posm:
                raise AssertionError('PositionManager positions only')
            model = self.positions.get((4, int.from_bytes(salt, 'big')))
            if model is None or model['history'][0][0] > number:
                return out(V4_STATE, 'getPositionInfo', (0, 0, 0))
            if ('0x' + pool_id.hex(), lower, upper) != self.range_key(model):
                return out(V4_STATE, 'getPositionInfo', (0, 0, 0))
            _, liquidity, last, _ = self.state_at(model, number)
            return out(V4_STATE, 'getPositionInfo', (liquidity, *last))
        if is_(V4_STATE, 'getFeeGrowthInside', self.state_view):
            pool_id, lower, upper = decode(['bytes32', 'int24', 'int24'], args)
            return out(V4_STATE, 'getFeeGrowthInside', self.inside(('0x' + pool_id.hex(), lower, upper), number))
        if is_(V4_STATE, 'getSlot0', self.state_view):
            return out(V4_STATE, 'getSlot0', (2 ** 96, 0, 0, 500))
        if is_(V3_FACTORY, 'feeAmountTickSpacing', self.factory):
            (fee,) = decode(['uint24'], args)
            return out(V3_FACTORY, 'feeAmountTickSpacing', ({100: 1, 500: 10, 3000: 60, 10000: 200, 2500: 50}[fee],))
        for (dex, _), model in self.positions.items():
            if dex == 3 and target == model['pool_key']:
                key = self.range_key(model)
                if selector == function(V3_POOL, 'slot0').selector:
                    return out(V3_POOL, 'slot0', (2 ** 96, 0, 0, 1, 1, 0, True))
                if selector in (function(V3_POOL, 'feeGrowthGlobal0X128').selector,
                                function(V3_POOL, 'feeGrowthGlobal1X128').selector):
                    index = 0 if selector == function(V3_POOL, 'feeGrowthGlobal0X128').selector else 1
                    return out(V3_POOL, 'feeGrowthGlobal0X128', (self.inside(key, number)[index],))
                if selector == function(V3_POOL, 'ticks').selector:
                    return out(V3_POOL, 'ticks', (1, 0, 0, 0, 0, 0, 0, True))
        raise AssertionError(f'unexpected read {target} {selector}')

    def count(self, method):
        return sum(1 for entry in self.log if entry[0] == method)
