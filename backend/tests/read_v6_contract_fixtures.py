"""read-v6 fixtures: answers the producer builds, and answers with one defect each.

The activity answers are built the way the indexer builds them: real event
logs (encoded from the frozen ABIs and decoded strictly), cut into items by
v2_activity.derive_transaction, stored as the store's rows would be, then
answered by v2_read_service.build_activity. The portfolio answers come from
rows shaped exactly as v2_index_store's reader returns them. Every valid
answer passes the producer's own validation; every invalid one fails it.
"""
import copy
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from v2_activity import Context, derive_transaction  # noqa: E402
from v2_events import catalog, decode_log, event_keys, json_args  # noqa: E402
from v2_index_fixtures import block_hash, encode_log, tx_hash  # noqa: E402
from v2_read_contract import CONTRACT_VERSION, ROUTES, validate_v6_response  # noqa: E402
from v2_read_service import build_activity, build_portfolio  # noqa: E402

NOW = 1_790_431_234
WALLET = '0x' + 'b1' * 20
OTHER = '0x' + 'b2' * 20
OPERATOR = '0x' + '64' * 20
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
MANY = '0x' + '7a' * 20
ZERO = '0x' + '00' * 20
T0, T1 = sorted((USDG, MANY))
POOL = {'dex': 4, 'currency0': T0, 'currency1': T1, 'fee': 3000, 'tickSpacing': 60, 'hooks': ZERO}
POOL_JSON = {key: str(value) if isinstance(value, int) else value for key, value in POOL.items()}
ZAP, VAULT, VAULT2, FACTORY, MODULE = ('0x' + 'a1' * 20, '0x' + 'a2' * 20, '0x' + 'a5' * 20, '0x' + 'a3' * 20,
                                       '0x' + 'a4' * 20)
ROUTER = '0x204faca1764b154221e35c0d20abb3c525710498'
POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
POLICY = {'mode': 2, 'triggerDistanceBps': 150, 'maxOverlapBps': 100, 'minimumIntervalSeconds': 3600,
          'maxPositions': 4}
LIMITS = {'maxSlippageBps': 100, 'maxPriceImpactBps': 150, 'maxObservationAgeSeconds': 300, 'upsideBps': 2000}
KINDS = {ZAP: 'zap', VAULT: 'vault', VAULT2: 'vault', FACTORY: 'vault_factory', MODULE: 'auto_exit'}
INTENT, PLAN, MANDATE = '0x' + 'c1' * 32, '0x' + 'c2' * 32, '0x' + 'c3' * 32
CHAIN = 4663
BASE_TIME = NOW - 7200


def jsonify(value):
    return json_args(value)


# ------------------------------------------------------------------ chains
def deployment(chain_id, *, through, head, observed_at, last_error=None, halted=None, auto_exit=MODULE,
               finalized=None, operators=1):
    return {'chain_id': chain_id, 'manifest_sha256': ('%064x' % chain_id), 'start_block': 100,
            'finalized_number': None if finalized is None else finalized[0],
            'finalized_hash': None if finalized is None else block_hash(finalized[0]),
            'finalized_timestamp': None if finalized is None else finalized[1],
            'operators': None if through is None else operators,
            'next_block': None if through is None else through[0] + 1,
            'head_number': None if head is None else head[0], 'head_hash': None if head is None else block_hash(head[0]),
            'head_timestamp': None if head is None else head[1], 'head_observed_at': observed_at,
            'last_error': None if last_error is None else last_error[0],
            'last_error_at': None if last_error is None else last_error[1],
            'end_block': None if through is None else through[0],
            'end_hash': None if through is None else block_hash(through[0]),
            'end_timestamp': None if through is None else through[1], 'auto_exit': auto_exit, 'halted': halted}


def deployments():
    return [deployment(CHAIN, through=(73_400_000, NOW - 12), head=(73_400_100, NOW - 2), observed_at=NOW - 3,
                       halted=False, finalized=(73_395_500, NOW - 460)),
            # Base: the head was last observed six minutes ago, and the last pass failed.
            deployment(8453, through=(52_100_000, NOW - 400), head=(52_100_010, NOW - 380), observed_at=NOW - 360,
                       last_error=('http_429', NOW - 30), halted=True)]


# ------------------------------------------------------------------ vaults
def member_state(token_id, parent='0', successor='0', lots=(('1200', '0'), ('0', '990'))):
    return {'tokenId': token_id, 'active': True, 'parent': parent, 'successor': successor, 'tickLower': -600,
            'tickUpper': 600, 'lots': [{'token': token, 'uncharged': u, 'charged': c}
                                       for token, (u, c) in zip((T0, T1), lots)]}


def vault_state(paused=False, armed=True, module=MODULE):
    return {'owner': WALLET, 'factory': FACTORY, 'pool': POOL_JSON,
            'root': {'dex': '4', 'positionManager': '0x58daec3116aae6d93017baaea7749052e8a04fa7', 'tokenId': '7'},
            'members': [member_state('7', successor='8'), member_state('8', parent='7', lots=(('0', '0'), ('0', '0')))],
            'policy': {k: v for k, v in POLICY.items()},
            'limits': {k: v for k, v in LIMITS.items()}, 'paused': paused, 'rootArmed': armed,
            'stateNonce': '6', 'exitModule': module, 'quoteCurrency': USDG, 'lastExecutionAt': str(NOW - 900),
            'reserves': [{'token': T0, 'total': '1202', 'idle': '2'}, {'token': T1, 'total': '990', 'idle': '0'}]}


def lifecycle(*entries, start=73_390_000):
    return [{'event': name, 'args': jsonify(args), 'block': start + 10 * i, 'hash': block_hash(start + 10 * i),
             'timestamp': BASE_TIME + 10 * i, 'tx': tx_hash(f'{name}:{i}')} for i, (name, args) in enumerate(entries)]


def vault_row(address, *, state='read', root=7, number=73_390_000, executions=2, last_execution=True,
              events=None, snapshot=None):
    row = {'chain_id': CHAIN, 'vault': address, 'factory': FACTORY, 'dex': 4, 'owner': WALLET,
           'root_token_id': root, 'owner_nonce': 0, 'block_number': number, 'log_index': 4,
           'tx_hash': tx_hash(f'create:{address}'), 'created_hash': block_hash(number),
           'created_timestamp': BASE_TIME, 'last_event_block': 73_399_000, 'executions': executions,
           'last_execution': None if not last_execution else {
               'block': 73_399_000, 'hash': block_hash(73_399_000), 'timestamp': NOW - 900, 'tx': tx_hash('exec'),
               'planHash': PLAN, 'action': '2'},
           'compounded': {'fees0': '1200', 'fees1': '3400000000000000000', 'serviceFee0': '48',
                          'serviceFee1': '136000000000000000', 'compounds': executions},
           'lifecycle': events if events is not None else lifecycle(
               ('Initialized', {'owner': WALLET, 'dex': 4, 'rootTokenId': root, 'mode': 2}),
               ('ExitModuleSet', {'module': MODULE, 'stateNonce': 2}),
               ('SuccessorCreated', {'parentTokenId': root, 'tokenId': 8, 'stateNonce': 4}))}
    if state == 'read':
        row.update(s_block=73_399_500, s_hash=block_hash(73_399_500), s_timestamp=NOW - 600, s_status='read',
                   s_state=snapshot or vault_state(), s_reason=None, s_read_at=NOW - 500)
    elif state == 'unavailable':
        row.update(s_block=73_399_500, s_hash=block_hash(73_399_500), s_timestamp=NOW - 600, s_status='unavailable',
                   s_state=None, s_reason='rpc_call_reverted', s_read_at=NOW - 500)
    else:
        row.update(s_block=None, s_hash=None, s_timestamp=None, s_status=None, s_state=None, s_reason=None,
                   s_read_at=None)
    return row


def vaults():
    exited = lifecycle(('Initialized', {'owner': WALLET, 'dex': 4, 'rootTokenId': 21, 'mode': 1}),
                       ('RootDisarmed', {'reason': 2, 'stateNonce': 3}), ('RootRearmed', {'stateNonce': 4}),
                       ('ExitModuleSet', {'module': MODULE, 'stateNonce': 5}),
                       ('RootDisarmed', {'reason': 6, 'stateNonce': 6}),
                       ('ExitExecuted', {'module': MODULE, 'tokenId': 21, 'amount0': 5, 'amount1': 6,
                                         'stateNonce': 6}))
    disarmed = lifecycle(('Initialized', {'owner': WALLET, 'dex': 4, 'rootTokenId': 31, 'mode': 1}),
                         ('RootDisarmed', {'reason': 1, 'stateNonce': 2}),
                         ('SuccessorCreated', {'parentTokenId': 31, 'tokenId': 32, 'stateNonce': 3}),
                         ('ChildWithdrawn', {'tokenId': 32, 'stateNonce': 4}),
                         ('ExitModuleSet', {'module': MODULE, 'stateNonce': 5}),
                         ('ExitModuleSet', {'module': ZERO, 'stateNonce': 6}))
    return [vault_row(VAULT),
            vault_row(VAULT2, state='unavailable', root=21, executions=0, last_execution=False, events=exited),
            vault_row('0x' + 'a6' * 20, state='not_read', root=31, executions=0, last_execution=False,
                      events=disarmed)]


# --------------------------------------------------------------- positions
def position_state(owner=WALLET, *, tick=60, lower=-600, upper=600, subscriber=VAULT, approved=VAULT):
    return {'positionManager': '0x58daec3116aae6d93017baaea7749052e8a04fa7', 'owner': owner, 'approved': approved,
            'subscriber': subscriber, 'pool': POOL_JSON, 'tickLower': lower, 'tickUpper': upper,
            'liquidity': '1000000000000000000', 'sqrtPriceX96': str(79466191966197645195421774833),
            'tick': tick, 'inRange': lower <= tick < upper, 'feesOwed': ['1200', '0'],
            'principalAtSpot': ['29551', '30447000000000000000']}


def position_row(token_id, source, vault, *, status='live', owner=WALLET, state=None, dex=4, first=73_390_000,
                 last_event=73_399_000, read_at=NOW - 500):
    row = {'chain_id': CHAIN, 'dex': dex, 'token_id': token_id, 'source': source, 'vault': vault, 'wallet': WALLET,
           'first_block': first, 'last_event_block': last_event}
    if status is None:
        row.update(s_block=None, s_hash=None, s_timestamp=None, s_status=None, s_owner=None, s_state=None,
                   s_reason=None, s_read_at=None)
    elif status == 'unavailable':
        row.update(s_block=73_399_500, s_hash=block_hash(73_399_500), s_timestamp=NOW - 600, s_status='unavailable',
                   s_owner=None, s_state=None, s_reason='v2_deployment_code_mismatch', s_read_at=read_at)
    else:
        row.update(s_block=73_399_500, s_hash=block_hash(73_399_500), s_timestamp=NOW - 600, s_status='live',
                   s_owner=owner, s_state=state or position_state(owner), s_reason=None, s_read_at=read_at)
    return row


def positions():
    return [position_row(7, 'vault_root', VAULT),
            # Held by the vault, out of range, and an event touched it after the read: stale.
            position_row(8, 'vault_successor', VAULT, owner=VAULT, last_event=73_399_900,
                         state=position_state(VAULT, tick=900, lower=-600, upper=600, subscriber=None,
                                              approved=None)),
            position_row(9, 's1', None, state=position_state(subscriber=None, approved=None)),
            position_row(12, 's1', None, status='unavailable'),
            position_row(13, 's1', None, status=None)]


# ---------------------------------------------------------------- mandates
def mandate_row(mandate_hash, *, ended=None, terms=True, valid_until=NOW + 86400, vault=VAULT, known=True,
                module=MODULE, token_id='7'):
    registered = {'mandateHash': mandate_hash, 'owner': WALLET, 'vault': vault, 'tokenId': token_id,
                  'validUntil': str(valid_until)}
    return {'chain_id': CHAIN, 'address': MODULE, 'mandate_hash': mandate_hash, 'args': registered,
            'block_number': 73_395_000, 'block_hash': block_hash(73_395_000), 'block_timestamp': NOW - 3600,
            'tx_hash': tx_hash(f'mandate:{mandate_hash}'),
            'terms': None if not terms else {'owner': WALLET, 'vault': vault, 'tokenId': token_id,
                                             'validUntil': str(valid_until), 'maxSlippageBps': 150,
                                             'receiveMode': 1, 'convertTo': USDG,
                                             'triggerBelowSqrtPriceX96': str(2**95), 'triggerAboveSqrtPriceX96': '0'},
            'ended': None if ended is None else {'event': ended, 'args': {} if ended == 'MandateRevoked' else {
                'mandateHash': mandate_hash, 'anchorSqrtPriceX96': str(2**95), 'recipient': WALLET,
                'amount0': '29641', 'amount1': '0'}, 'block': 73_398_000,
                                                 'hash': block_hash(73_398_000), 'timestamp': NOW - 1800,
                                                 'tx': tx_hash(f'end:{mandate_hash}')},
            'exit_module': module if known else None, 'vault_known': known}


def mandates():
    return [mandate_row(MANDATE),
            mandate_row('0x' + 'd2' * 32, valid_until=NOW - 60),
            mandate_row('0x' + 'd3' * 32, ended='MandateRevoked', terms=False),
            mandate_row('0x' + 'd4' * 32, ended='MandateExecuted', module=ZERO),
            mandate_row('0x' + 'd5' * 32, vault='0x' + 'ee' * 20, known=False),
            # On the successor the vault holds: nothing blocks it, it waits for its trigger.
            mandate_row('0x' + 'd6' * 32, token_id='8'),
            # On a vault whose module was turned off, and whose root was never read.
            mandate_row('0x' + 'd7' * 32, vault='0x' + 'a6' * 20, token_id='31', module=ZERO),
            # On a successor withdrawn from that vault.
            mandate_row('0x' + 'd8' * 32, vault='0x' + 'a6' * 20, token_id='32')]


def credits():
    return [{'chain_id': CHAIN, 'module': MODULE, 'token': USDG, 'unclaimed': '294'},
            {'chain_id': CHAIN, 'module': MODULE, 'token': MANY, 'unclaimed': '0'}]


TOKENS = {(CHAIN, USDG): {'chain_id': CHAIN, 'address': USDG, 'decimals': 6, 'symbol': 'USDG', 'status': 'available'},
          (CHAIN, MANY): {'chain_id': CHAIN, 'address': MANY, 'decimals': None, 'symbol': 'MANY', 'status': 'partial'}}


def tokens(keys):
    return {key: TOKENS[key] for key in keys if key in TOKENS}


ROBINHOOD_FEED, ROBINHOOD_WETH = '0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9', '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
PRICE_SNAPSHOT = {'number': 73_400_100, 'hash': block_hash(73_400_100), 'timestamp': NOW - 2}


def prices(asked):
    """v2_chain_reads.Pricer's answer on Robinhood: USDG at US$ 1, ETH and WETH at the feed, MANY at the USDG/MANY pool."""
    eth = {'feed': ROBINHOOD_FEED, 'usd': '4000.123456780000000000', 'roundId': '18446744073709552117',
           'updatedAt': NOW - 1800}
    out = {}
    for chain_id, token, _ in asked:
        if chain_id == CHAIN and token == USDG:
            out[(chain_id, token)] = ({'usd': '1.000000000000000000', 'source': 'chain_stable', 'snapshot': None,
                                       'ethUsd': None, 'pool': None, 'depthUsd': None}, None)
        elif chain_id == CHAIN and token in (ZERO, ROBINHOOD_WETH):
            out[(chain_id, token)] = ({'usd': eth['usd'], 'source': 'chainlink_eth_usd', 'snapshot': PRICE_SNAPSHOT,
                                       'ethUsd': eth, 'pool': None, 'depthUsd': None}, None)
        elif chain_id == CHAIN and token == MANY:
            out[(chain_id, token)] = ({'usd': '0.000000000000981234', 'source': 'pool', 'snapshot': PRICE_SNAPSHOT,
                                       'ethUsd': None, 'pool': dict(POOL), 'depthUsd': '25300.415000'}, None)
        else:
            out[(chain_id, token)] = (None, 'no_pool')
    return out


# ------------------------------------------------------------------ waiting
def waiting_row(reason, *, at, since, block=73_400_090, revert=None):
    """A domino_v2.waiting row as the store reads it; `since` seconds before `at`, one block a second."""
    return {'reason': reason, 'since': since, 'since_block': block - (at - since), 'at': at, 'block': block,
            'revert': None if revert is None else revert[0], 'revert_at': None if revert is None else revert[1],
            'revert_block': None if revert is None else revert[2]}


def waiting_reports(age=40):
    """Each chain's last automation file read (domino_v2.waiting_reports): Robinhood's
    automation reports, Base's file could not be read, Arbitrum's indexer reads none."""
    return {CHAIN: {'chain_id': CHAIN, 'status': 'read', 'block': 73_400_090, 'block_timestamp': NOW - age,
                    'reason': None, 'read_at': NOW - 5},
            8453: {'chain_id': 8453, 'status': 'unavailable', 'block': None, 'block_timestamp': None,
                   'reason': 'v2_waiting_file_unreadable', 'read_at': NOW - 5}}


def waiting(age=40):
    """(chain, kind, subject) -> the rows the indexer kept from that file."""
    at = NOW - age
    return {(CHAIN, 'vault', VAULT): waiting_row('gas_not_covered', at=at, since=at - 600),
            (CHAIN, 'vault', VAULT2): waiting_row('root_disarmed', at=at, since=at - 1800),
            (CHAIN, 'mandate', MANDATE): waiting_row('trigger_not_reached', at=at, since=at - 3500,
                                                     revert=('reverted_spot_outside_band', at - 900, 73_399_200)),
            (CHAIN, 'mandate', '0x' + 'd6' * 32): waiting_row('reverted_twap_unavailable', at=at, since=at - 300,
                                                              revert=('reverted_twap_unavailable', at, 73_400_090)),
            # An ended mandate keeps the automation's last row; the answer drops it.
            (CHAIN, 'mandate', '0x' + 'd3' * 32): waiting_row('eligible', at=NOW - 7000, since=NOW - 7000,
                                                              block=73_393_000)}


def portfolio(**overrides):
    rows = dict(deployments=deployments(), vaults=vaults(), positions=positions(), mandates=mandates(),
                credits=credits(), tokens=tokens, waiting_reports=waiting_reports(), waiting=waiting(), prices=prices)
    rows.update(overrides)
    return build_portfolio(WALLET, NOW, **rows)


# ---------------------------------------------------------------- activity
class Ledger:
    """Transactions as the indexer stores them: logs, and their activity items."""
    def __init__(self):
        self.logs, self.rows, self.transactions, self.block = {}, [], {}, 73_390_000

    def tx(self, label, entries, *, seconds_ago, gas=True, l1_fee=None, sender=WALLET):
        self.block += 1000
        number, decoded = self.block, []
        for index, (address, name, args) in enumerate(entries):
            raw = encode_log(KINDS[address], name, args, address=address, block_number=number,
                             block_hash=block_hash(number), tx_hash=tx_hash(label), log_index=index)
            decoded.append(decode_log(catalog(), raw, KINDS.get))
        ctx = Context(vault=lambda a: (WALLET, 4, 7) if a in (VAULT, VAULT2) else None,
                      mandate=lambda h: (WALLET, VAULT), auto_exit=MODULE, zap_dex={ZAP: 4})
        for log in decoded:
            owner, vault, token_id, ref = event_keys(log)
            self.logs[(CHAIN, number, log.log_index)] = {
                'chain_id': CHAIN, 'block_number': number, 'log_index': log.log_index, 'block_hash': log.block_hash,
                'block_timestamp': NOW - seconds_ago, 'tx_hash': log.tx_hash, 'address': log.address,
                'emitter': log.emitter, 'event': log.event, 'args': json_args(log.args), 'owner': owner,
                'vault': vault, 'token_id': token_id, 'ref': ref}
        for item in derive_transaction(decoded, ctx):
            if WALLET in item.wallets:
                self.rows.append({'chain_id': CHAIN, 'block_number': number, 'log_index': item.anchor.log_index,
                                  'wallet': WALLET, 'kind': item.kind, 'block_timestamp': NOW - seconds_ago,
                                  'tx_hash': tx_hash(label), 'address': item.address, 'vault': item.vault,
                                  'ref': item.ref, 'log_indexes': [log.log_index for log in item.logs]})
        if gas:
            self.transactions[(CHAIN, tx_hash(label))] = {'sender': sender, 'gas_used': 412345,
                                                          'effective_gas_price': 20_000_000, 'l1_fee': l1_fee}

    def newest_first(self):
        return sorted(self.rows, key=lambda r: (r['block_timestamp'], r['chain_id'], r['block_number'],
                                                r['log_index']), reverse=True)


def ledger():
    book = Ledger()
    book.tx('create-vault', [
        (VAULT, 'Initialized', {'owner': WALLET, 'dex': 4, 'rootTokenId': 7, 'mode': 2}),
        (VAULT, 'PolicyChanged', {'policy': POLICY, 'stateNonce': 1}),
        (VAULT, 'LimitsChanged', {'limits': LIMITS, 'stateNonce': 1}),
        (VAULT, 'RootRearmed', {'stateNonce': 1}),
        (FACTORY, 'VaultCreated', {'owner': WALLET, 'vault': VAULT, 'rootTokenId': 7, 'dex': 4, 'ownerNonce': 0})],
        seconds_ago=7000)
    book.tx('s1-create', [
        (ZAP, 'InputPulled', {'intentHash': INTENT, 'owner': WALLET, 'token': USDG, 'amount': 100_000_000}),
        (ZAP, 'SwapLegExecuted', {'kind': 1, 'tokenIn': USDG, 'tokenOut': MANY, 'venue': ROUTER,
                                  'amountIn': 50_000_000, 'amountOut': 49_500_000_000_000_000_000}),
        (ZAP, 'FeeCharged', {'kind': 1, 'token': USDG, 'payer': WALLET, 'amount': 325_000, 'ref': INTENT}),
        (ZAP, 'PositionLiquidityChanged', {'intentHash': INTENT, 'owner': WALLET, 'tokenId': 9, 'pool': POOL,
                                           'liquidityDelta': 10**18, 'amount0': -49_400_000_000_000_000_000,
                                           'amount1': -49_675_000}),
        (ZAP, 'Refunded', {'recipient': WALLET, 'token': USDG, 'amount': 0}),
        (ZAP, 'Refunded', {'recipient': WALLET, 'token': MANY, 'amount': 100_000_000_000_000_000}),
        (ZAP, 'PositionActionExecuted', {'action': 1, 'recipient': WALLET, 'tokenId': 9, 'previousTokenId': 0,
                                         'liquidity': 10**18, 'intentHash': INTENT})], seconds_ago=6000, l1_fee=None)
    book.tx('s1-exit', [
        (ZAP, 'PositionLiquidityChanged', {'intentHash': '0x' + 'c4' * 32, 'owner': WALLET, 'tokenId': 9,
                                           'pool': POOL, 'liquidityDelta': -10**18, 'amount0': 49_000,
                                           'amount1': 50_000_000}),
        (ZAP, 'Refunded', {'recipient': WALLET, 'token': T0, 'amount': 49_000}),
        (ZAP, 'Refunded', {'recipient': WALLET, 'token': T1, 'amount': 50_000_000}),
        (ZAP, 'PositionActionExecuted', {'action': 4, 'recipient': WALLET, 'tokenId': 9, 'previousTokenId': 9,
                                         'liquidity': 10**18, 'intentHash': '0x' + 'c4' * 32})],
        seconds_ago=5500, gas=False)
    book.tx('execute', [
        (VAULT, 'FeesCollected', {'tokenId': 7, 'amount0': 1200, 'amount1': 3_400_000_000_000_000_000}),
        (VAULT, 'SwapLegExecuted', {'kind': 3, 'tokenIn': T1, 'tokenOut': T0, 'venue': POOL_MANAGER,
                                    'amountIn': 1_000_000_000_000_000_000, 'amountOut': 990}),
        (VAULT, 'Swapped', {'source': 7, 'zeroForOne': False, 'amountIn': 1_000_000_000_000_000_000,
                            'amountOut': 990}),
        (VAULT, 'FeeCharged', {'kind': 2, 'token': T0, 'payer': WALLET, 'amount': 48, 'ref': PLAN}),
        (VAULT, 'FeeCharged', {'kind': 2, 'token': T1, 'payer': WALLET, 'amount': 136_000_000_000_000_000,
                               'ref': PLAN}),
        (VAULT, 'FeeDeferred', {'token': T1, 'amount': 136_000_000_000_000_000,
                                'totalOwed': 136_000_000_000_000_000}),
        (VAULT, 'SuccessorCreated', {'parentTokenId': 7, 'tokenId': 8, 'stateNonce': 4}),
        (VAULT, 'Compounded', {'tokenId': 8, 'liquidityAdded': 5 * 10**17, 'fees0': 1200,
                               'fees1': 3_400_000_000_000_000_000, 'serviceFee0': 48,
                               'serviceFee1': 136_000_000_000_000_000, 'stateNonce': 4}),
        (VAULT, 'Executed', {'planHash': PLAN, 'action': 2, 'stateNonce': 4})], seconds_ago=4000)
    book.tx('owner', [
        (VAULT, 'PolicyChanged', {'policy': dict(POLICY, triggerDistanceBps=200), 'stateNonce': 5}),
        (VAULT, 'AutomationPaused', {'actor': WALLET, 'stateNonce': 6}),
        (VAULT, 'ExitModuleSet', {'module': MODULE, 'stateNonce': 7})], seconds_ago=3500)
    book.tx('custody', [(VAULT, 'RootDisarmed', {'reason': 2, 'stateNonce': 8})], seconds_ago=3200)
    book.tx('mandate', [(MODULE, 'MandateRegistered', {'mandateHash': MANDATE, 'owner': WALLET, 'vault': VAULT,
                                                       'tokenId': 8, 'validUntil': NOW + 86400})], seconds_ago=3000)
    book.tx('exit', [
        (VAULT, 'ReservesWithdrawn', {'token': T0, 'amount': 2, 'stateNonce': 9}),
        (VAULT, 'ChildWithdrawn', {'tokenId': 8, 'stateNonce': 9}),
        (VAULT, 'ExitExecuted', {'module': MODULE, 'tokenId': 8, 'amount0': 10_000,
                                 'amount1': 20_000_000_000_000_000_000, 'stateNonce': 9}),
        (MODULE, 'SwapLegExecuted', {'kind': 3, 'tokenIn': T1, 'tokenOut': T0, 'venue': POOL_MANAGER,
                                     'amountIn': 20_000_000_000_000_000_000, 'amountOut': 19_700}),
        (MODULE, 'FeeCharged', {'kind': 3, 'token': T0, 'payer': WALLET, 'amount': 59, 'ref': MANDATE}),
        (MODULE, 'DeliveryDeferred', {'owner': WALLET, 'token': T0, 'amount': 29_641, 'totalUnclaimed': 29_641}),
        (MODULE, 'MandateExecuted', {'mandateHash': MANDATE, 'anchorSqrtPriceX96': 2**95, 'recipient': WALLET,
                                     'amount0': 29_641, 'amount1': 0})], seconds_ago=2000)
    book.tx('claim', [(MODULE, 'Claimed', {'owner': WALLET, 'token': T0, 'recipient': OTHER, 'amount': 29_641})],
            seconds_ago=1500)
    book.tx('revoke', [(MODULE, 'MandateRevoked', {'mandateHash': '0x' + 'd2' * 32}),
                       (MODULE, 'NonceCancelled', {'owner': WALLET, 'nonce': 77})], seconds_ago=1000)
    book.tx('nonces', [(ZAP, 'NoncesInvalidated', {'owner': WALLET, 'word': 0, 'mask': 6})], seconds_ago=500,
            l1_fee=150_000_000)
    # The owner's own withdrawal stays a vault event; the operator's returnReserves() after the owner closed the
    # root is reserves_returned.
    book.tx('withdraw', [(VAULT, 'ReservesWithdrawn', {'token': T1, 'amount': 5_000, 'stateNonce': 10})],
            seconds_ago=400)
    book.tx('return', [(VAULT, 'ReservesWithdrawn', {'token': T0, 'amount': 1_200, 'stateNonce': 11}),
                       (VAULT, 'ReservesWithdrawn', {'token': T1, 'amount': 3_000, 'stateNonce': 11})],
            seconds_ago=300, sender=OPERATOR)
    return book


# The registry admitted the operator before any item.
OPERATORS = {(CHAIN, OPERATOR): [(73_380_000, 0, True)]}


def activity(limit=50, rows=None, book=None):
    book = book or ledger()
    rows = book.newest_first() if rows is None else rows
    return build_activity(WALLET, NOW, limit, deployments=deployments(), rows=rows[:limit + 1], logs=book.logs,
                          transactions=book.transactions, modes={(CHAIN, VAULT, r['block_number'], r['log_index']):
                                                                 'domino' for r in rows
                                                                 if r['kind'] == 'vault_execution'},
                          tokens=tokens, waiting_reports=waiting_reports(), operators=OPERATORS, prices=prices)


# ------------------------------------------------------------ chain reads
# The live routes' answers, built by v2_chain_reads.ChainReads over a scripted Multicall3 (v2_chain_reads tests).
LIVE_TOKEN = '0x' + '5e' * 20
BASE_USDC, BASE_WETH = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x4200000000000000000000000000000000000006'
LIVE_BLOCK = (52_214_620, '0x' + 'de' * 32, NOW - 4)
# ETH at US$ 4,000.12345678 (the feed's 8 decimals); the v3 WETH/LIVE pool deep enough to price LIVE.
LIVE_ETH_USD, LIVE_ROUND, LIVE_V3_LIQUIDITY = 400_012_345_678, 110_680_464_442_257_320_001, 10**21
# A token the wallet holds none of, its decimals unreadable: no price, and none needed for a total.
ZERO_BALANCE = '0x' + '6f' * 20


class LiveChain:
    """Multicall3 over scripted answers by (target, selector, arguments); anything else is an address without code."""

    def __init__(self, answers):
        self.answers = answers

    def request(self, method, params):
        from eth_abi import decode, encode
        calls, = decode(['(address,bool,bytes)[]'], bytes.fromhex(params[0]['data'][10:]))
        rows = [self.answers.get((target.lower(), bytes(data[:4]).hex(), bytes(data[4:])), (True, b''))
                for target, _, data in calls]
        return '0x' + encode(['(bool,bytes)[]'], [rows]).hex()


def live_reads(answers, *, chains=(8453,)):
    from discovery import Block
    import v2_chain_reads as reads
    from v2_chains import default_registry
    registry = default_registry()

    class Follower:
        def head(self):
            return type('Head', (), {'block': Block(*LIVE_BLOCK)})()

    class Endpoints:
        endpoints = ()

        def read_rpc(self, *, anchor, max_requests):
            return LiveChain(answers)
    sources = {chain: reads.ChainSource(registry.chain(chain), Endpoints(), Follower()) for chain in chains}
    listed = ({'name': 'Uniswap Labs Default', 'version': '22.24.0', 'sha256': '5b' * 32},
              {8453: [('0x' + '22' * 20, 'AERO', 'Aerodrome Finance', 18), (BASE_USDC, 'USDC', 'USD Coin', 6),
                      ('0x' + '33' * 20, 'cbBTC', 'Coinbase Wrapped BTC', 8)], 42161: []})
    learned = reads.LearnedTokens()
    learned.learn(8453, '0x' + '44' * 20, 'AEROX', None, 18)
    return reads.ChainReads(sources, token_list=listed, learned=learned, registry=registry,
                            clock=lambda: NOW, monotonic=lambda: 0.0)


def live_answers():
    from eth_abi import encode
    from eth_hash.auto import keccak
    from v2_chains import default_registry
    from v2_uniswap import PoolRef, v3_pool_address
    base = default_registry().chain(8453)

    def selector(signature):
        return keccak(signature.encode())[:4].hex()
    v4 = PoolRef(4, ZERO, LIVE_TOKEN, 3000, 60)
    view = base.uniswap.v4.stateView
    v3_low, v3_high = sorted((LIVE_TOKEN, BASE_WETH))
    v3 = v3_pool_address(base, v3_low, v3_high, 500)
    pool_id = bytes.fromhex(v4.pool_id[2:])
    wallet = encode(['address'], [WALLET])
    return {
        (view, selector('getSlot0(bytes32)'), pool_id): (True, encode(['uint160', 'int24', 'uint24', 'uint24'],
                                                                      [2**96 * 3, 21_972, (250 << 12) | 125, 3000])),
        (view, selector('getLiquidity(bytes32)'), pool_id): (True, encode(['uint128'], [4_200_000])),
        (v3, selector('slot0()'), b''): (True, encode(['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'],
                                                      [2**96 * 2, 13_863, 0, 1, 1, 68, True])),
        (v3, selector('liquidity()'), b''): (True, encode(['uint128'], [LIVE_V3_LIQUIDITY])),
        (base.uniswap.v3.factory, selector('feeAmountTickSpacing(uint24)'), encode(['uint24'], [500])):
            (True, encode(['int24'], [10])),
        (LIVE_TOKEN, selector('decimals()'), b''): (True, encode(['uint8'], [18])),
        (LIVE_TOKEN, selector('symbol()'), b''): (True, encode(['string'], ['LIVE'])),
        (LIVE_TOKEN, selector('name()'), b''): (True, encode(['string'], ['Live Token'])),
        (base.multicall3, selector('getEthBalance(address)'), wallet): (True, encode(['uint256'], [10**17])),
        (BASE_USDC, selector('balanceOf(address)'), wallet): (True, encode(['uint256'], [2_500_000])),
        (LIVE_TOKEN, selector('balanceOf(address)'), wallet): (True, encode(['uint256'], [7 * 10**18])),
        (ZERO_BALANCE, selector('balanceOf(address)'), wallet): (True, encode(['uint256'], [0])),
        **price_answers(base, selector),
    }


def price_answers(base, selector):
    """Base's Chainlink ETH/USD a minute old, its sequencer up for a day, and the two pools' bitmap words within the
    band: no initialized tick there, so each pool's depth is its active liquidity's."""
    from eth_abi import encode
    import v2_chain_reads as reads
    from v2_uniswap import PoolRef, v3_pool_address
    feed = base.gasPrice.chainlinkEthUsd
    rounds = ['uint80', 'int256', 'uint256', 'uint256', 'uint80']
    answers = {(feed.proxy.lower(), selector('latestRoundData()'), b''):
               (True, encode(rounds, [LIVE_ROUND, LIVE_ETH_USD, NOW - 64, NOW - 64, LIVE_ROUND])),
               (feed.sequencerUptimeFeed.lower(), selector('latestRoundData()'), b''):
               (True, encode(rounds, [7, 0, NOW - 86_400, NOW - 86_400, 7]))}
    v4 = PoolRef(4, ZERO, LIVE_TOKEN, 3000, 60)
    v3 = PoolRef(3, *sorted((LIVE_TOKEN, BASE_WETH)), 500, 10)
    for ref, sqrt, tick in ((v4, 2**96 * 3, 21_972), (v3, 2**96 * 2, 13_863)):
        # LIVE is currency1 in both: sold into the pool, the price rises.
        low, high = reads.band_ticks(sqrt, tick, ref.tick_spacing, False)
        for position in reads.band_words(low, high):
            if ref.dex == 4:
                key = (base.uniswap.v4.stateView, selector('getTickBitmap(bytes32,int16)'),
                       encode(['bytes32', 'int16'], [bytes.fromhex(ref.pool_id[2:]), position]))
            else:
                key = (v3_pool_address(base, ref.currency0, ref.currency1, ref.fee), selector('tickBitmap(int16)'),
                       encode(['int16'], [position]))
            answers[key] = (True, encode(['uint256'], [0]))
    return answers


def live_fixtures():
    reads = live_reads(live_answers())
    return {
        'chain-pools': reads.pools(8453, LIVE_TOKEN),
        'chain-pools-paired': reads.pools(8453, LIVE_TOKEN, BASE_WETH),
        'chain-pools-none': live_reads({}).pools(8453, '0x' + '6f' * 20, BASE_USDC),
        'chain-balances': reads.balances(WALLET),
        'chain-balances-asked': reads.balances(WALLET, [(8453, LIVE_TOKEN), (8453, ZERO), (8453, ZERO_BALANCE)]),
        'chain-tokens': reads.tokens(8453, 'aero', 20),
        'chain-tokens-usdc': reads.tokens(8453, 'USDC', 5),
        'chain-tokens-none': reads.tokens(42161, 'nothing', 20),
    }


def pool_of(body, dex):
    return next(item for item in body['pools'] if item['pool']['dex'] == dex)


def refee(item, **fields):
    """A pool changed, its swap fees recomputed from the fees it then states: the defect breaks one rule alone."""
    from v2_chain_reads import swap_fees
    item.update(fields)
    zero_for_one, one_for_zero = swap_fees(item['pool']['dex'], item['lpFeePips'], item['protocolFee'])
    item['swapFeePips'] = {'zeroForOne': zero_for_one, 'oneForZero': one_for_zero}


def route_of(name):
    """The route a fixture answers: the longest route its file name starts with, then `.` or `-`."""
    return max((route for route in ROUTES if name == route or name[len(route):len(route) + 1] in ('.', '-')
                and name.startswith(route)), key=len)


def valid():
    book = ledger()
    rows = book.newest_first()
    all_chains = [deployment(c, through=(100 + c, NOW - 5), head=(105 + c, NOW - 1), observed_at=NOW - 2,
                             halted=False) for c in (4663, 8453, 42161)]
    return {
        'portfolio': portfolio(),
        'portfolio-empty': portfolio(deployments=[], vaults=[], positions=[], mandates=[], credits=[],
                                     waiting_reports={}, waiting={}),
        # The automation stopped writing ten minutes ago: its last reasons, marked stale.
        'portfolio-waiting-stale': portfolio(vaults=vaults()[:1], positions=positions()[:2],
                                             mandates=mandates()[:1], credits=[],
                                             waiting_reports=waiting_reports(age=660), waiting=waiting(age=660)),
        'portfolio-complete': portfolio(deployments=all_chains, vaults=[], positions=[], mandates=[], credits=[]),
        'portfolio-behind': portfolio(deployments=[
            deployment(CHAIN, through=(73_000_000, NOW - 900), head=(73_400_100, NOW - 2), observed_at=NOW - 3,
                       halted=False),
            deployment(8453, through=None, head=(52_100_010, NOW - 4), observed_at=NOW - 5)],
            vaults=vaults()[:1], positions=positions()[:1], mandates=[], credits=[]),
        # The root approved to another app: its mandate is blocked until custody returns.
        'portfolio-custody-lost': portfolio(vaults=vaults()[:1], positions=[position_row(
            7, 'vault_root', VAULT, state=position_state(approved=OTHER))], mandates=[mandate_row(MANDATE)], credits=[]),
        # Automation halted on Robinhood: every active mandate there waits.
        'portfolio-halted': portfolio(deployments=[deployment(
            CHAIN, through=(73_400_000, NOW - 12), head=(73_400_100, NOW - 2), observed_at=NOW - 3, halted=True)],
            vaults=vaults()[:1], positions=positions()[:2], mandates=mandates()[:1] + mandates()[5:6], credits=[]),
        'activity': activity(),
        'activity-page': activity(limit=3, rows=rows, book=book),
        'activity-empty': activity(rows=[]),
        **live_fixtures(),
    }


REQUESTS = {'portfolio': {'wallet': WALLET},
            'activity': {'wallet': WALLET, 'limit': 3, 'cursor': '1790425234.4663.73391000.4'},
            'chain-pools': {'chainId': 8453, 'token': LIVE_TOKEN, 'pairedToken': None},
            'chain-balances': {'wallet': WALLET, 'tokens': [{'chainId': 8453, 'address': LIVE_TOKEN},
                                                       {'chainId': 8453, 'address': ZERO},
                                                       {'chainId': 8453, 'address': ZERO_BALANCE}]},
            'chain-tokens': {'chainId': 8453, 'query': 'aero', 'limit': 20}}


def invalid():
    """The base answers with exactly one defect each, named by the file."""
    answers = live_fixtures()
    base = {'portfolio': portfolio(), 'activity': activity(), 'chain-pools': answers['chain-pools'],
            'chain-balances': answers['chain-balances'], 'chain-tokens': answers['chain-tokens']}

    def defect(route, change):
        body = copy.deepcopy(base[route])
        change(body)
        return route, body

    def item(kind):
        return lambda body: next(i for i in body['items'] if i['kind'] == kind)

    def asked(change):
        """A defect of chain-balances' answer for the tokens asked: Base alone, every balance valued, both totals."""
        body = copy.deepcopy(answers['chain-balances-asked'])
        change(body)
        return 'chain-balances', body

    def token(body, address):
        return next(entry for entry in body['tokens'] if entry['address'] == address)

    def plus(text, units=1):
        whole, part = text.split('.')
        value = int(whole + part) + units
        return f'{value // 10 ** len(part)}.{value % 10 ** len(part):0{len(part)}d}'

    execution, exit_, returned = item('vault_execution'), item('auto_exit'), item('reserves_returned')
    s1 = lambda b: next(i for i in b['items'] if i['kind'] == 's1_action' and i['action'] == 'create')  # noqa: E731
    vault = lambda b: b['vaults'][0]  # noqa: E731
    read = lambda b: b['vaults'][0]['state']  # noqa: E731
    live = lambda b: b['positions'][0]['state']  # noqa: E731
    mandate = lambda b, i=0: b['mandates'][i]  # noqa: E731
    return {
        'portfolio.extra-key': defect('portfolio', lambda b: b.update(cached=True)),
        # Qualified USD on Robinhood: USDG at 1, MANY at the USDG/MANY pool.
        'portfolio.price-and-a-reason': defect('portfolio', lambda b: token(b, USDG).update(priceReason='no_pool')),
        'portfolio.neither-price-nor-reason': defect('portfolio', lambda b: token(b, MANY).update(price=None)),
        'portfolio.stable-not-one': defect('portfolio', lambda b: token(b, USDG)['price'].update(
            usd='0.999000000000000000')),
        'portfolio.stable-from-a-pool': defect('portfolio', lambda b: token(b, USDG).update(
            price=copy.deepcopy(token(b, MANY)['price']))),
        'portfolio.pool-below-the-floor': defect('portfolio', lambda b: token(b, MANY)['price'].update(
            depthUsd='9999.999999')),
        'portfolio.pool-without-the-token': defect('portfolio', lambda b: token(b, MANY)['price']['pool'].update(
            currency0=ZERO, currency1=USDG)),
        'portfolio.pool-against-another-token': defect('portfolio', lambda b: token(b, MANY)['price']['pool'].update(
            currency0=MANY, currency1='0x' + '99' * 20)),
        'portfolio.pool-against-the-stable-with-a-round': defect('portfolio', lambda b: token(b, MANY)['price'].update(
            ethUsd={'feed': ROBINHOOD_FEED, 'usd': '4000.000000000000000000', 'roundId': '1',
                    'updatedAt': PRICE_SNAPSHOT['timestamp']})),
        'portfolio.hooked-price-pool': defect('portfolio', lambda b: token(b, MANY)['price']['pool'].update(
            hooks='0x' + '40' * 20)),
        'portfolio.price-of-zero': defect('portfolio', lambda b: token(b, MANY)['price'].update(
            usd='0.000000000000000000')),
        'portfolio.chain-stable-for-another-token': defect('portfolio', lambda b: token(b, MANY).update(
            price=copy.deepcopy(token(b, USDG)['price']))),
        'portfolio.wrong-version': defect('portfolio', lambda b: b.update(contractVersion='1.0.0-rc.2')),
        'portfolio.wrong-mode': defect('portfolio', lambda b: b.update(mode='stored_v2_activity')),
        'portfolio.complete-with-a-stale-chain': defect('portfolio', lambda b: b.update(coverage='complete')),
        'portfolio.chains-out-of-order': defect('portfolio', lambda b: b['chains'].reverse()),
        'portfolio.missing-chain': defect('portfolio', lambda b: b['chains'].pop()),
        'portfolio.current-with-a-reason': defect('portfolio', lambda b: b['chains'][0].update(
            reason='indexer_behind_head')),
        'portfolio.stale-without-a-reason': defect('portfolio', lambda b: b['chains'][1].update(reason=None)),
        'portfolio.unregistered-with-a-deployment': defect('portfolio', lambda b: b['chains'][2].update(
            deployment={'manifestSha256': 'a' * 64, 'startBlock': 1})),
        'portfolio.lag-without-a-head': defect('portfolio', lambda b: b['chains'][0].update(head=None)),
        'portfolio.halt-unknown-when-indexed': defect('portfolio', lambda b: b['chains'][0].update(
            automationHalted=None)),
        'portfolio.operators-unknown-when-indexed': defect('portfolio', lambda b: b['chains'][0].update(
            operatorsAdmitted=None)),
        'portfolio.finality-without-a-deployment': defect('portfolio', lambda b: b['chains'][2].update(
            finalizedThrough=b['chains'][0]['finalizedThrough'])),
        'portfolio.unknown-limitation': defect('portfolio', lambda b: b['limitations'].append('audited')),
        'portfolio.suggested': defect('portfolio', lambda b: b.update(suggested=True)),
        'portfolio.execution-available': defect('portfolio', lambda b: b.update(executionAvailable=True)),
        'portfolio.vault-of-another-owner': defect('portfolio', lambda b: vault(b).update(owner=OTHER)),
        'portfolio.uppercase-address': defect('portfolio', lambda b: vault(b).update(address=VAULT.upper()
                                                                                       .replace('0X', '0x'))),
        'portfolio.numeric-raw': defect('portfolio', lambda b: vault(b).update(rootTokenId=7)),
        'portfolio.raw-above-uint256': defect('portfolio', lambda b: vault(b)['totals'].update(
            feesCompounded=[str(2**256), '0'])),
        'portfolio.leading-zero-raw': defect('portfolio', lambda b: vault(b)['totals'].update(
            serviceFees=['048', '0'])),
        'portfolio.member-root-with-a-parent': defect('portfolio', lambda b: vault(b)['members'][0].update(
            parentTokenId='1')),
        'portfolio.member-disarmed-without-a-reason': defect('portfolio', lambda b: vault(b)['members'][0].update(
            status='disarmed')),
        'portfolio.unknown-vault-state': defect('portfolio', lambda b: read(b).update(status='cached')),
        'portfolio.vault-mode-numeric': defect('portfolio', lambda b: read(b)['policy'].update(mode=2)),
        'portfolio.pool-currencies-unsorted': defect('portfolio', lambda b: read(b)['pool'].update(
            currency0=T1, currency1=T0)),
        'portfolio.reserve-idle-above-total': defect('portfolio', lambda b: read(b)['reserves'][0].update(
            idle='1203')),
        'portfolio.lot-of-another-token': defect('portfolio', lambda b: read(b)['members'][0]['lots'][0].update(
            token=WETH)),
        'portfolio.freshness-unknown-status': defect('portfolio', lambda b: read(b)['freshness'].update(
            status='old')),
        'portfolio.custody-armed-against-the-read': defect('portfolio', lambda b: vault(b)['custody'].update(
            armed=False)),
        'portfolio.custody-reason-without-source': defect('portfolio', lambda b: b['vaults'][1]['custody'].update(
            source=None)),
        'portfolio.paused-by-while-running': defect('portfolio', lambda b: vault(b).update(pausedBy='owner')),
        'portfolio.in-range-mismatch': defect('portfolio', lambda b: live(b).update(inRange=False)),
        'portfolio.fees-owed-one-side': defect('portfolio', lambda b: live(b).update(feesOwed=['1'])),
        'portfolio.position-pool-of-another-dex': defect('portfolio', lambda b: b['positions'][0].update(dex=3)),
        'portfolio.position-vault-role': defect('portfolio', lambda b: b['positions'][0]['vault'].update(
            role='child')),
        'portfolio.mandate-of-another-owner': defect('portfolio', lambda b: mandate(b).update(owner=OTHER)),
        'portfolio.mandate-expired-unflagged': defect('portfolio', lambda b: mandate(b, 1).update(expired=False)),
        'portfolio.mandate-revoked-without-its-tx': defect('portfolio', lambda b: mandate(b, 2).update(revoked=None)),
        'portfolio.mandate-blocked-when-ended': defect('portfolio', lambda b: mandate(b, 3).update(
            blockedBy=['custody_lost'])),
        'portfolio.mandate-blockers-out-of-order': defect('portfolio', lambda b: mandate(b, 6).update(
            blockedBy=['custody_unread', 'module_disabled'])),
        'portfolio.mandate-module-off-not-blocking': defect('portfolio', lambda b: mandate(b, 6).update(
            blockedBy=['custody_unread'])),
        'portfolio.mandate-halt-not-blocking': defect('portfolio', lambda b: mandate(b).update(
            blockedBy=['automation_halted'])),
        'portfolio.mandate-without-a-trigger': defect('portfolio', lambda b: mandate(b)['terms'].update(
            triggerBelowSqrtPriceX96=None)),
        'portfolio.mandate-converting-to-nothing': defect('portfolio', lambda b: mandate(b)['terms'].update(
            convertTo=None)),
        'portfolio.mandate-module-of-a-foreign-vault': defect('portfolio', lambda b: mandate(b, 4).update(
            moduleEnabled=False)),
        'portfolio.waiting-error-of-another-reason': defect('portfolio', lambda b: vault(b)['waiting'].update(
            error='TooSoon')),
        'portfolio.waiting-revert-unnamed': defect('portfolio', lambda b: mandate(b)['waiting']['lastRevert'].update(
            error=None)),
        'portfolio.waiting-unknown-error-name': defect('portfolio', lambda b: mandate(b)['waiting'].update(
            reason='reverted_out_of_luck', error='OutOfLuck')),
        'portfolio.waiting-reason-not-a-code': defect('portfolio', lambda b: vault(b)['waiting'].update(
            reason='Gas not covered')),
        'portfolio.waiting-since-after-the-check': defect('portfolio', lambda b: mandate(b)['waiting'].update(
            since=NOW)),
        'portfolio.waiting-since-unknown': defect('portfolio', lambda b: vault(b)['waiting'].update(since=None)),
        'portfolio.waiting-since-block-after-the-check': defect('portfolio', lambda b: vault(b)['waiting'].update(
            sinceBlock=vault(b)['waiting']['checkedBlock'] + 1)),
        'portfolio.waiting-on-an-ended-mandate': defect('portfolio', lambda b: mandate(b, 2).update(
            waiting=mandate(b)['waiting'])),
        'portfolio.waiting-without-a-report': defect('portfolio', lambda b: b['chains'][0].update(
            waitingReasons={'status': 'not_configured', 'block': None, 'timestamp': None, 'ageSeconds': None})),
        'portfolio.waiting-report-without-its-pass': defect('portfolio', lambda b: b['chains'][0]['waitingReasons']
                                                            .update(block=None)),
        'portfolio.waiting-report-current-when-old': defect('portfolio', lambda b: b['chains'][0]['waitingReasons']
                                                            .update(ageSeconds=601)),
        'portfolio.waiting-report-unknown-status': defect('portfolio', lambda b: b['chains'][1]['waitingReasons']
                                                          .update(status='down')),
        'portfolio.token-available-without-decimals': defect('portfolio', lambda b: b['tokens'][1].update(
            status='available')),
        'portfolio.token-unread-with-a-symbol': defect('portfolio', lambda b: b['tokens'][1].update(
            status='not_read', decimals=None)),
        'portfolio.price-as-a-bare-number': defect('portfolio', lambda b: b['tokens'][0].update(price='1.00')),
        'portfolio.control-symbol': defect('portfolio', lambda b: b['tokens'][0].update(symbol='US\u0007DG')),
        'portfolio.tokens-unsorted': defect('portfolio', lambda b: b['tokens'].reverse()),
        'portfolio.too-many-vaults': defect('portfolio', lambda b: b.update(vaults=b['vaults'] * 17)),
        'activity.wrong-mode': defect('activity', lambda b: b.update(mode='stored_v2_portfolio')),
        'activity.items-out-of-order': defect('activity', lambda b: b['items'].reverse()),
        'activity.duplicate-item': defect('activity', lambda b: b['items'].insert(1, b['items'][0])),
        'activity.id-of-another-block': defect('activity', lambda b: b['items'][0].update(id='4663:1:0')),
        'activity.unknown-kind': defect('activity', lambda b: b['items'][0].update(kind='vault_note')),
        'activity.bad-cursor': defect('activity', lambda b: b.update(nextCursor='after-this')),
        'activity.final-above-the-finalized-block': defect('activity', lambda b: b['items'][0]['tx'].update(
            finality='finalized')),
        'activity.gas-failed-status': defect('activity', lambda b: b['items'][0]['tx']['gas'].update(
            status='failed')),
        'activity.s1-fee-without-a-swap': defect('activity', lambda b: s1(b).update(legs=[])),
        'activity.s1-automation-tariff': defect('activity', lambda b: s1(b)['tariffs'][0].update(kind='automation')),
        'activity.s1-tariff-rate': defect('activity', lambda b: s1(b)['tariffs'][0].update(rateBps=200)),
        'activity.s1-unknown-action': defect('activity', lambda b: s1(b).update(action='migrate')),
        'activity.s1-create-with-a-previous-position': defect('activity', lambda b: s1(b).update(
            previousTokenId='3')),
        'activity.s1-without-steps': defect('activity', lambda b: s1(b).update(steps=[])),
        'activity.s1-signed-amount-out-of-range': defect('activity', lambda b: s1(b)['steps'][0].update(
            amount0=str(-2**255 - 1))),
        'activity.s1-unknown-leg-kind': defect('activity', lambda b: s1(b)['legs'][0].update(kind='v2_pool')),
        'activity.deferred-above-tariff': defect('activity', lambda b: execution(b)['tariffs'][1].update(
            deferred=str(int(execution(b)['tariffs'][1]['amount']) + 1))),
        'activity.mint-without-successor': defect('activity', lambda b: execution(b).update(successor=None)),
        'activity.exit-tariff-kind': defect('activity', lambda b: exit_(b)['tariffs'][0].update(kind='assisted_swap')),
        'activity.exit-one-sided-withdrawal': defect('activity', lambda b: exit_(b).update(withdrawn=['1'])),
        'activity.vault-event-unknown-reason': defect('activity', lambda b: next(
            i for i in b['items'] if i['kind'] == 'vault_event' and i['events'][0]['event'] == 'RootDisarmed'
        )['events'][0].update(reason='forgot')),
        'activity.mandate-event-extra-field': defect('activity', lambda b: next(
            i for i in b['items'] if i['kind'] == 'auto_exit_event' and i['event'] == 'MandateRegistered'
        ).update(amount='1')),
        'activity.too-many-items': defect('activity', lambda b: b.update(items=b['items'] * 5)),
        # reserves_returned: the operator's returnReserves(), both tokens at one nonce.
        'activity.returned-by-the-owner': defect('activity', lambda b: (
            returned(b).update(returnedBy=WALLET), returned(b)['tx']['gas'].update(sender=WALLET))),
        'activity.returned-by-another-sender': defect('activity', lambda b: returned(b).update(returnedBy=OTHER)),
        'activity.returned-without-gas': defect('activity', lambda b: returned(b)['tx'].update(gas=None)),
        'activity.returned-twice-the-token': defect('activity', lambda b: returned(b)['reservesReturned'][1].update(
            token=returned(b)['reservesReturned'][0]['token'])),
        'activity.returned-nothing': defect('activity', lambda b: returned(b).update(reservesReturned=[])),
        'activity.returned-three-tokens': defect('activity', lambda b: returned(b)['reservesReturned'].append(
            {'token': WETH, 'amount': '1'})),
        # chain-pools: a v4 pool (ETH/LIVE, a protocol fee each way) and a v3 one (LIVE/WETH).
        'chain-pools.tokens-unsorted': defect('chain-pools', lambda b: b['tokens'].reverse()),
        # Without its pools, which would name the token too.
        'chain-pools.token-not-listed': defect('chain-pools', lambda b: b.update(pools=[], tokens=[
            t for t in b['tokens'] if t['address'] != LIVE_TOKEN])),
        'chain-pools.paired-not-listed': defect('chain-pools', lambda b: b.update(pairedToken=BASE_WETH, pools=[], tokens=[
            t for t in b['tokens'] if t['address'] != BASE_WETH])),
        'chain-pools.paired-is-the-token': defect('chain-pools', lambda b: b.update(pairedToken=LIVE_TOKEN)),
        'chain-pools.pool-without-the-token': defect('chain-pools', lambda b: pool_of(b, 3)['pool'].update(
            currency0=BASE_WETH, currency1=BASE_USDC)),
        # Paired with WETH, yet the v4 pool is ETH's.
        'chain-pools.pool-without-the-paired-token': defect('chain-pools', lambda b: b.update(pairedToken=BASE_WETH)),
        'chain-pools.pool-currency-not-listed': defect('chain-pools', lambda b: b.update(tokens=[
            t for t in b['tokens'] if t['address'] != BASE_WETH])),
        'chain-pools.v4-with-an-address': defect('chain-pools', lambda b: pool_of(b, 4).update(address=BASE_WETH)),
        'chain-pools.v3-with-an-id': defect('chain-pools', lambda b: pool_of(b, 3).update(id='0x' + 'ab' * 32)),
        'chain-pools.hooked-pool': defect('chain-pools', lambda b: pool_of(b, 4)['pool'].update(hooks='0x' + '40' * 20)),
        'chain-pools.lp-fee-not-the-tier': defect('chain-pools', lambda b: refee(pool_of(b, 4), lpFeePips=2999)),
        'chain-pools.swap-fee-off-by-one': defect('chain-pools', lambda b: pool_of(b, 4)['swapFeePips'].update(
            zeroForOne=pool_of(b, 4)['swapFeePips']['zeroForOne'] + 1)),
        'chain-pools.v3-swap-fee-plus-protocol': defect('chain-pools', lambda b: pool_of(b, 3)['swapFeePips'].update(
            zeroForOne=pool_of(b, 3)['lpFeePips'] + 1)),
        'chain-pools.protocol-fee-out-of-range': defect('chain-pools', lambda b: refee(pool_of(b, 4),
                                                                                       protocolFee=(1001 << 12) | 125)),
        'chain-pools.v3-protocol-fee-over-a-byte': defect('chain-pools', lambda b: pool_of(b, 3).update(protocolFee=256)),
        'chain-pools.empty-pool': defect('chain-pools', lambda b: pool_of(b, 3).update(liquidity='0')),
        'chain-pools.unpriced-pool': defect('chain-pools', lambda b: pool_of(b, 3).update(sqrtPriceX96='0')),
        'chain-pools.duplicate-pool': defect('chain-pools', lambda b: b['pools'].append(copy.deepcopy(pool_of(b, 4)))),
        'chain-pools.market-with-a-price': defect('chain-pools', lambda b: pool_of(b, 4)['market'].update(tvlUsd='1')),
        'chain-pools.stale-called-fresh': defect('chain-pools', lambda b: b.update(servedAt=b['snapshot']['timestamp'] + 61,
                                                                                    freshness={'ageSeconds': 61, 'status': 'fresh'})),
        'chain-pools.wrong-age': defect('chain-pools', lambda b: b['freshness'].update(ageSeconds=b['freshness']['ageSeconds'] + 1)),
        'chain-pools.limitations-reordered': defect('chain-pools', lambda b: b['limitations'].reverse()),
        'chain-pools.partial-with-both': defect('chain-pools', lambda b: next(
            t for t in b['tokens'] if t['address'] == LIVE_TOKEN).update(status='partial')),
        'chain-pools.unsafe-symbol': defect('chain-pools', lambda b: next(
            t for t in b['tokens'] if t['address'] == LIVE_TOKEN).update(symbol='LI\u202eVE')),
        'chain-pools.execution-available': defect('chain-pools', lambda b: b.update(executionAvailable=True)),
        'chain-pools.limitations-of-rc1': defect('chain-pools', lambda b: b['limitations'].__setitem__(
            0, 'raw_amounts_no_usd_valuation')),
        # Qualified USD on chain-pools: ETH and WETH at the feed, LIVE at the v3 pool against WETH, USDC at 1.
        'chain-pools.eth-usd-older-than-its-heartbeat': defect('chain-pools', lambda b: token(b, ZERO)['price'][
            'ethUsd'].update(updatedAt=b['snapshot']['timestamp'] - 1201)),
        'chain-pools.eth-usd-from-another-feed': defect('chain-pools', lambda b: token(b, ZERO)['price'][
            'ethUsd'].update(feed='0x' + '99' * 20)),
        'chain-pools.eth-usd-after-its-block': defect('chain-pools', lambda b: token(b, ZERO)['price'][
            'ethUsd'].update(updatedAt=b['snapshot']['timestamp'] + 1)),
        'chain-pools.eth-price-not-its-round': defect('chain-pools', lambda b: token(b, ZERO)['price'].update(
            usd=plus(token(b, ZERO)['price']['usd']))),
        'chain-pools.price-against-weth-without-its-round': defect('chain-pools', lambda b: token(
            b, LIVE_TOKEN)['price'].update(ethUsd=None)),
        'chain-pools.stable-with-a-block': defect('chain-pools', lambda b: token(b, BASE_USDC)['price'].update(
            snapshot=dict(b['snapshot']))),
        'chain-pools.measured-without-a-depth': defect('chain-pools', lambda b: pool_of(b, 3)['market'].update(
            depthUsd=None)),
        'chain-pools.unmeasured-with-a-reference': defect('chain-pools', lambda b: pool_of(b, 4).update(market={
            'status': 'unavailable', 'reference': ZERO, 'depthUsd': None, 'reason': 'no_qualified_reference'})),
        'chain-pools.reference-outside-the-pool': defect('chain-pools', lambda b: pool_of(b, 3)['market'].update(
            reference=BASE_USDC)),
        'chain-pools.reference-is-the-token': defect('chain-pools', lambda b: (
            b.update(token=BASE_WETH, pools=[pool_of(b, 3)]), pool_of(b, 3)['market'].update(reference=BASE_WETH))),
        # chain-balances: Robinhood unconfigured (unavailable), then Base, then Arbitrum unconfigured.
        'chain-balances.read-without-an-amount': defect('chain-balances', lambda b: b['chains'][1]['balances'][0].update(
            balanceRaw=None, valueUsd=None)),
        'chain-balances.amount-unread': defect('chain-balances', lambda b: b['chains'][1]['balances'][0].update(
            status='unavailable')),
        'chain-balances.unavailable-with-a-block': defect('chain-balances', lambda b: b['chains'][0].update(
            snapshot={'number': 1, 'hash': '0x' + 'ab' * 32, 'timestamp': NOW})),
        'chain-balances.unavailable-without-a-reason': defect('chain-balances', lambda b: b['chains'][0].update(reason=None)),
        'chain-balances.current-with-a-reason': defect('chain-balances', lambda b: b['chains'][1].update(
            reason='chain_read_failed')),
        'chain-balances.unavailable-with-a-balance': defect('chain-balances', lambda b: b['chains'][0]['balances'][0].update(
            balanceRaw='1', status='read')),
        'chain-balances.chains-unsorted': defect('chain-balances', lambda b: b['chains'].reverse()),
        'chain-balances.complete-but-unavailable': defect('chain-balances', lambda b: b.update(coverage='complete')),
        'chain-balances.duplicate-token': defect('chain-balances', lambda b: b['chains'][1]['balances'].append(
            copy.deepcopy(b['chains'][1]['balances'][0]))),
        'chain-balances.negative-amount': defect('chain-balances', lambda b: b['chains'][1]['balances'][0].update(
            balanceRaw='-1')),
        'chain-balances.unknown-reason': defect('chain-balances', lambda b: b['chains'][0].update(reason='rpc_down')),
        # Values and totals: Base's USDC and ETH valued, its WETH unread, the other chains not configured.
        'chain-balances.value-without-a-price': defect('chain-balances', lambda b: b['chains'][1]['balances'][
            1].update(price=None, priceReason='eth_usd_stale')),
        'chain-balances.priced-but-not-valued': defect('chain-balances', lambda b: b['chains'][1]['balances'][
            0].update(valueUsd=None)),
        'chain-balances.total-over-an-unread-balance': defect('chain-balances', lambda b: b['chains'][1].update(
            totalUsd='402.512345')),
        'chain-balances.total-without-every-chain': defect('chain-balances', lambda b: b.update(totalUsd='402.512345')),
        'chain-balances.value-off-by-a-micro-dollar': asked(lambda b: (
            b['chains'][0]['balances'][0].update(valueUsd=plus(b['chains'][0]['balances'][0]['valueUsd'])),
            b['chains'][0].update(totalUsd=plus(b['chains'][0]['totalUsd'])), b.update(totalUsd=plus(b['totalUsd'])))),
        'chain-balances.chain-total-off': asked(lambda b: (
            b['chains'][0].update(totalUsd=plus(b['chains'][0]['totalUsd'])), b.update(totalUsd=plus(b['totalUsd'])))),
        'chain-balances.total-off': asked(lambda b: b.update(totalUsd=plus(b['totalUsd']))),
        'chain-balances.price-and-a-reason': asked(lambda b: b['chains'][0]['balances'][0].update(priceReason='no_pool')),
        # Base's total right, but Arbitrum read nothing: no answer-wide total.
        'chain-balances.total-over-an-unavailable-chain': asked(lambda b: (b.update(coverage='partial'), b['chains'].append({
            'chainId': 42161, 'status': 'unavailable', 'reason': 'chain_not_configured', 'snapshot': None,
            'totalUsd': None, 'balances': [{'address': ZERO, 'symbol': None, 'decimals': None, 'balanceRaw': None,
                                            'status': 'unavailable', 'price': None,
                                            'priceReason': 'no_qualified_price_source', 'valueUsd': None}]}))),
        # chain-tokens: AERO from the list, AEROX looked up.
        'chain-tokens.sources-unordered': defect('chain-tokens', lambda b: b['tokens'][0].update(
            sources=['looked_up', 'uniswap_default_list'])),
        'chain-tokens.unknown-source': defect('chain-tokens', lambda b: b['tokens'][0].update(sources=['coingecko'])),
        'chain-tokens.no-source': defect('chain-tokens', lambda b: b['tokens'][0].update(sources=[])),
        'chain-tokens.robinhood': defect('chain-tokens', lambda b: b.update(chainId=4663)),
        'chain-tokens.duplicate-token': defect('chain-tokens', lambda b: b['tokens'].append(copy.deepcopy(b['tokens'][0]))),
        'chain-tokens.list-hash-short': defect('chain-tokens', lambda b: b['tokenList'].update(sha256='5b' * 31)),
        'chain-tokens.too-many': defect('chain-tokens', lambda b: b.update(tokens=[
            {**b['tokens'][0], 'address': '0x' + f'{index:040x}'} for index in range(25)])),
        'chain-tokens.unsafe-name': defect('chain-tokens', lambda b: b['tokens'][0].update(name='Aero\tdrome')),
        'chain-tokens.symbol-null': defect('chain-tokens', lambda b: b['tokens'][0].update(symbol=None)),
        'chain-tokens.empty-query': defect('chain-tokens', lambda b: b.update(query='')),
    }


def errors():
    from read_contract import ERROR_STATUS_BY_CODE
    return {code: {'status': status, 'body': {'error': code}} for code, status in sorted(ERROR_STATUS_BY_CODE.items())
            if code in ('invalid_request', 'read_capacity_busy', 'upstream_unavailable',
                        'upstream_contract_mismatch', 'read_deadline_exceeded', 'catalogue_database_unavailable')}


def check():
    for name, body in valid().items():
        validate_v6_response(route_of(name), body)
    for name, (route, body) in invalid().items():
        try:
            validate_v6_response(route, body)
        except ValueError:
            continue
        raise AssertionError(f'invalid fixture {name} is accepted by the producer')


__all__ = ['valid', 'invalid', 'errors', 'REQUESTS', 'CONTRACT_VERSION', 'check', 'route_of']
