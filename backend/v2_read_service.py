"""The read-v6 answers, built from one read-only snapshot of the V2 index.

The builders are pure: they take the rows v2_index_store's reader returns and
the time of the answer, and return the wire dictionary, validated against
v2_read_contract before it leaves. The exporter builds the shared fixtures
with the same functions over synthetic rows, so a fixture is always something
this producer serves.
"""
import json
import time

from discovery import DataError
from v2_chains import DEX_V3, default_registry
from v2_read_contract import (BLOCKERS, CHAIN_IDS, CONTRACT_VERSION, DISARM_REASONS, FEE_FRESH_SECONDS,
                              FEE_LIMITATIONS, HEAD_MAX_AGE_SECONDS, LIMITATIONS, MAX_CREDITS, MAX_FEE_EVENTS,
                              MAX_FEE_POINTS, MAX_FEE_TRANSFERS, MAX_ITEMS, MAX_MANDATES, MAX_POSITIONS, MAX_TOKENS,
                              MAX_VAULTS, MAX_LAG_SECONDS, NEXT_VERSION, STALE_SECONDS, WAITING_STALE_SECONDS, ZERO,
                              cursor_key, error_of, make_cursor, validate_v6_response)

ACTIONS = {1: 'create', 2: 'increase', 3: 'change_range', 4: 'exit'}
PLAN_ACTIONS = {1: 'compound', 2: 'mint'}
MODES = {1: 'simple', 2: 'domino'}
LEG_KINDS = {1: 'universal_router', 2: 'v3_pool', 3: 'v4_pool'}
FEE_KINDS = {1: 'assisted_swap', 2: 'automation', 3: 'auto_exit'}
AUTOMATION_RATE = {'simple': 200, 'domino': 400}
# RootDisarmed reasons after which a vault is done with its root: burned, left by the owner (exitAll). The auto-exit's
# end (6) is its ExitExecuted, which follows it always, and also comes alone for a root disarmed already. The other
# reasons wait for the owner's rearm in the same vault.
ENDING_DISARMS = frozenset({3, 7})


def _snapshot(number, block_hash, timestamp):
    return {'number': int(number), 'hash': block_hash, 'timestamp': int(timestamp)}


def _tx(entry):
    """A TxRef from a lifecycle or ended entry: {tx, block, hash, timestamp}."""
    return {'hash': entry['tx'], 'snapshot': _snapshot(entry['block'], entry['hash'], entry['timestamp'])}


def _opt_address(value):
    return None if value in (None, ZERO) else value


def _opt_raw(value):
    return None if value in (None, '0') else value


def _pool(value):
    return {'dex': int(value['dex']), 'currency0': value['currency0'], 'currency1': value['currency1'],
            'fee': int(value['fee']), 'tickSpacing': int(value['tickSpacing']), 'hooks': value['hooks']}


def _policy(value):
    return {'mode': MODES[int(value['mode'])], 'triggerDistanceBps': int(value['triggerDistanceBps']),
            'maxOverlapBps': int(value['maxOverlapBps']),
            'minimumIntervalSeconds': int(value['minimumIntervalSeconds']), 'maxPositions': int(value['maxPositions'])}


def _limits(value):
    return {name: int(value[name]) for name in ('maxSlippageBps', 'maxPriceImpactBps', 'maxObservationAgeSeconds',
                                                'upsideBps')}


def _manager(chain_id, dex):
    chain = default_registry().chain(chain_id)
    return chain.uniswap.v3.positionManager if dex == DEX_V3 else chain.uniswap.v4.positionManager


def _freshness(now, block_timestamp, read_at, block_number, last_event_block):
    """A read is stale once an event touched it after the read, or once it is too old."""
    stale = (last_event_block is not None and int(last_event_block) > int(block_number)) or \
        now - int(read_at) > STALE_SECONDS
    return {'ageSeconds': max(0, now - int(block_timestamp)), 'status': 'stale' if stale else 'fresh'}


# ------------------------------------------------------------------ chains
def waiting_report(report, now):
    """The chain's automation file as the indexer last read it (domino_v2.waiting_reports), or None."""
    if report is None:
        return {'status': 'not_configured', 'block': None, 'timestamp': None, 'ageSeconds': None}
    if report['status'] != 'read':
        return {'status': 'unavailable', 'block': None, 'timestamp': None, 'ageSeconds': None}
    age = max(0, now - int(report['block_timestamp']))
    return {'status': 'stale' if age > WAITING_STALE_SECONDS else 'reporting', 'block': int(report['block']),
            'timestamp': int(report['block_timestamp']), 'ageSeconds': age}


def waiting_entry(row):
    """A subject's row (domino_v2.waiting) as read-v6's `waiting`, or None."""
    if row is None:
        return None
    revert = None if row['revert'] is None else {
        'reason': row['revert'], 'error': error_of(row['revert']), 'at': int(row['revert_at']),
        'block': int(row['revert_block'])}
    return {'reason': row['reason'], 'error': error_of(row['reason']), 'since': int(row['since']),
            'sinceBlock': int(row['since_block']), 'checkedAt': int(row['at']), 'checkedBlock': int(row['block']),
            'lastRevert': revert}


def chain_status(chain_id, row, now, report=None):
    empty = {'chainId': chain_id, 'deployment': None, 'indexedThrough': None, 'finalizedThrough': None,
             'head': None, 'lagBlocks': None, 'lagSeconds': None, 'lastError': None, 'automationHalted': None,
             'operatorsAdmitted': None, 'waitingReasons': waiting_report(report, now)}
    if row is None:
        return {**empty, 'status': 'unavailable', 'reason': 'deployment_not_registered'}
    out = {**empty, 'deployment': {'manifestSha256': row['manifest_sha256'], 'startBlock': int(row['start_block'])}}
    if row['last_error'] is not None:
        out['lastError'] = {'code': row['last_error'], 'at': int(row['last_error_at'])}
    if row['head_number'] is not None:
        out['head'] = {'number': int(row['head_number']), 'timestamp': int(row['head_timestamp']),
                       'observedAt': int(row['head_observed_at'])}
    if row['finalized_number'] is not None:
        out['finalizedThrough'] = _snapshot(row['finalized_number'], row['finalized_hash'], row['finalized_timestamp'])
    if row['end_block'] is None:
        return {**out, 'status': 'unavailable', 'reason': 'never_indexed'}
    out['indexedThrough'] = _snapshot(row['end_block'], row['end_hash'], row['end_timestamp'])
    out['automationHalted'] = bool(row['halted'])
    out['operatorsAdmitted'] = int(row['operators'] or 0)
    head = out['head']
    if head is not None:
        out['lagBlocks'] = max(0, head['number'] - out['indexedThrough']['number'])
        out['lagSeconds'] = max(0, head['timestamp'] - out['indexedThrough']['timestamp'])
    if head is None or now - head['observedAt'] > HEAD_MAX_AGE_SECONDS:
        return {**out, 'status': 'stale', 'reason': 'head_not_observed_recently'}
    if out['lagSeconds'] > MAX_LAG_SECONDS:
        return {**out, 'status': 'stale', 'reason': 'indexer_behind_head'}
    return {**out, 'status': 'current', 'reason': None}


def chains(deployments, now, reports=None):
    """reports: chain id -> its waiting_reports row (absent: no automation file configured)."""
    by_chain, reports = {row['chain_id']: row for row in deployments}, reports or {}
    return [chain_status(chain_id, by_chain.get(chain_id), now, reports.get(chain_id)) for chain_id in CHAIN_IDS]


def envelope(mode, wallet, now, chain_rows, tokens):
    return {'schemaVersion': 1, 'contractVersion': CONTRACT_VERSION, 'mode': mode, 'wallet': wallet,
            'servedAt': now, 'coverage': 'complete' if all(c['status'] == 'current' for c in chain_rows)
            else 'partial', 'chains': chain_rows, 'tokens': tokens, 'limitations': list(LIMITATIONS),
            'suggested': False, 'executionAvailable': False}


def token_list(keys, rows, prices=None):
    """The answer's tokens with their metadata as the index read it and their qualified USD: `prices` takes
    [(chain id, token, decimals or None)] and gives each (price, None) or (None, reason) (v2_chain_reads.Pricer);
    without it, no token has a price."""
    chosen = sorted(set(keys))[:MAX_TOKENS]
    found = {} if prices is None else prices([(chain_id, address, (rows.get((chain_id, address)) or {}).get('decimals'))
                                              for chain_id, address in chosen])
    out = []
    for chain_id, address in chosen:
        row = rows.get((chain_id, address))
        price, reason = found.get((chain_id, address), (None, 'no_qualified_price_source'))
        entry = {'chainId': chain_id, 'address': address, 'price': price, 'priceReason': reason}
        if row is None:
            entry.update(status='not_read', decimals=None, symbol=None)
        else:
            entry.update(status=row['status'], decimals=row['decimals'], symbol=row['symbol'])
        out.append(entry)
    return out


# ---------------------------------------------------------------- portfolio
def _members(row):
    root = str(int(row['root_token_id']))
    members = {root: {'tokenId': root, 'role': 'root', 'parentTokenId': None, 'status': 'armed',
                      'disarmReason': None}}
    for entry in row['lifecycle'] or []:
        event, a = entry['event'], entry['args']
        if event == 'SuccessorCreated':
            members[a['tokenId']] = {'tokenId': a['tokenId'], 'role': 'successor', 'parentTokenId': a['parentTokenId'],
                                     'status': 'active', 'disarmReason': None}
        elif event == 'ChildWithdrawn' and a['tokenId'] in members:
            members[a['tokenId']].update(status='withdrawn')
        elif event == 'ExitExecuted' and a['tokenId'] in members:
            members[a['tokenId']].update(status='exited', disarmReason=None)
        elif event == 'RootDisarmed':
            reason = int(a['reason'])
            if reason == 6:
                members[root].update(status='exited', disarmReason=None)
            elif members[root]['status'] != 'exited':
                members[root].update(status='disarmed', disarmReason=DISARM_REASONS[reason])
        elif event == 'RootRearmed':
            members[root].update(status='armed', disarmReason=None)
    return list(members.values())


def _last(row, *events):
    found = None
    for entry in row['lifecycle'] or []:
        if entry['event'] in events:
            found = entry
    return found


def _custody(row, state):
    """The root's custody: armed as last read; the reason from the last disarm
    event after the last rearm, or from the live read alone."""
    armed = state['rootArmed'] if state is not None else None
    last = _last(row, 'RootDisarmed', 'RootRearmed')
    if last is not None and last['event'] == 'RootDisarmed' and armed is not True:
        return {'armed': armed, 'reason': DISARM_REASONS[int(last['args']['reason'])], 'source': 'event',
                'since': _tx(last)}
    if armed is False:
        return {'armed': False, 'reason': 'custody_lost', 'source': 'live_read', 'since': None}
    return {'armed': armed, 'reason': None, 'source': None, 'since': None}


def _paused_by(row, state):
    if state is None or not state['paused']:
        return None
    last = _last(row, 'AutomationPaused', 'AutomationResumed')
    if last is None or last['event'] != 'AutomationPaused':
        return 'unknown'  # paused at creation, or by exitAll, which emits no pause event
    return 'owner' if last['args']['actor'] == row['owner'] else 'operator'


def _auto_exit_enabled(row, auto_exit):
    last = _last(row, 'ExitModuleSet')
    return last is not None and last['args']['module'] not in (None, ZERO) and last['args']['module'] == auto_exit


def _member_state(member):
    return {'tokenId': member['tokenId'], 'active': member['active'],
            'parentTokenId': _opt_raw(member['parent']), 'successorTokenId': _opt_raw(member['successor']),
            'tickLower': int(member['tickLower']), 'tickUpper': int(member['tickUpper']),
            'lots': [{'token': lot['token'], 'uncharged': lot['uncharged'], 'charged': lot['charged']}
                     for lot in member['lots']]}


def vault_entry(row, now, auto_exit, waiting=None):
    created = {'hash': row['tx_hash'], 'snapshot': _snapshot(row['block_number'], row['created_hash'],
                                                             row['created_timestamp'])}
    state = None
    if row['s_status'] is None:
        view = {'status': 'not_read'}
    else:
        snapshot = _snapshot(row['s_block'], row['s_hash'], row['s_timestamp'])
        freshness = _freshness(now, row['s_timestamp'], row['s_read_at'], row['s_block'], row['last_event_block'])
        if row['s_status'] == 'unavailable':
            view = {'status': 'unavailable', 'snapshot': snapshot, 'freshness': freshness, 'reason': row['s_reason']}
        else:
            state = row['s_state']
            view = {'status': 'read', 'snapshot': snapshot, 'freshness': freshness, 'pool': _pool(state['pool']),
                    'quoteCurrency': state['quoteCurrency'], 'policy': _policy(state['policy']),
                    'limits': _limits(state['limits']), 'paused': state['paused'], 'rootArmed': state['rootArmed'],
                    'stateNonce': state['stateNonce'], 'exitModule': _opt_address(state['exitModule']),
                    'lastExecutionAt': state['lastExecutionAt'],
                    'members': [_member_state(m) for m in state['members']],
                    'reserves': [{'token': r['token'], 'total': r['total'], 'idle': r['idle']}
                                 for r in state['reserves']]}
    last = row['last_execution']
    compounded = row['compounded'] or {}
    return {'chainId': int(row['chain_id']), 'address': row['vault'], 'factory': row['factory'], 'dex': int(row['dex']),
            'owner': row['owner'], 'rootTokenId': str(int(row['root_token_id'])),
            'ownerNonce': str(int(row['owner_nonce'])), 'created': created, 'state': view,
            'custody': _custody(row, state), 'pausedBy': _paused_by(row, state), 'members': _members(row),
            'autoExitEnabled': _auto_exit_enabled(row, auto_exit),
            'lastExecution': None if last is None else {'tx': _tx(last), 'planHash': last['planHash'],
                                                        'action': PLAN_ACTIONS[int(last['action'])]},
            'totals': {'executions': int(row['executions']), 'compounds': int(compounded.get('compounds', 0)),
                       'feesCompounded': [compounded.get('fees0', '0'), compounded.get('fees1', '0')],
                       'serviceFees': [compounded.get('serviceFee0', '0'), compounded.get('serviceFee1', '0')]},
            'waiting': waiting_entry(waiting)}


def position_entry(row, now):
    chain_id, dex = int(row['chain_id']), int(row['dex'])
    if row['s_status'] is None:
        state = {'status': 'not_read'}
    else:
        snapshot = _snapshot(row['s_block'], row['s_hash'], row['s_timestamp'])
        freshness = _freshness(now, row['s_timestamp'], row['s_read_at'], row['s_block'], row['last_event_block'])
        if row['s_status'] == 'unavailable':
            state = {'status': 'unavailable', 'snapshot': snapshot, 'freshness': freshness, 'reason': row['s_reason']}
        else:
            s = row['s_state']
            state = {'status': 'live', 'snapshot': snapshot, 'freshness': freshness, 'owner': s['owner'],
                     'custody': {'approved': _opt_address(s['approved']), 'subscriber': _opt_address(s['subscriber'])},
                     'pool': _pool(s['pool']), 'tickLower': int(s['tickLower']), 'tickUpper': int(s['tickUpper']),
                     'liquidity': s['liquidity'], 'sqrtPriceX96': s['sqrtPriceX96'], 'tick': int(s['tick']),
                     'inRange': s['inRange'], 'feesOwed': list(s['feesOwed']),
                     'principalAtSpot': list(s['principalAtSpot'])}
    return {'chainId': chain_id, 'dex': dex, 'positionManager': _manager(chain_id, dex),
            'tokenId': str(int(row['token_id'])), 'vault': vault_link(row), 'firstSeenBlock': int(row['first_block']),
            'state': state}


def vault_link(row):
    """The vault the position belongs to now, as read-v6's `vault`, or None.

    The reader gives the vault that took the position last (v2_index_store's
    positions: link_vault, link_role, link_owner) and that vault's events
    since then that may end the link (link_events), oldest first. It ends when
    the vault lets the position go:
    - a successor withdrawn to the wallet (ChildWithdrawn: withdrawChild,
      exitAll, or the auto-exit of that successor);
    - a root the owner left (RootDisarmed exit_all), that the auto-exit closed
      (ExitExecuted, after RootDisarmed auto_exit or alone when it was
      disarmed already) or that was burned (RootDisarmed burned).
    An exit needs the root's approval alone, so turning the vault's Auto-exit
    back on after that (ExitModuleSet to the module) makes the root the
    vault's again, until the module is off again ("Turn off", or a second
    exitAll, which then disarms nothing). A root disarmed for another reason
    (unsubscribed, changed outside Domino, custody, checkpoint) stays the
    vault's: its owner rearms it there. A position another wallet holds, as
    last read, is no vault's: a vault acts on its root only while the vault's
    owner holds it.
    """
    vault, role = row['link_vault'], row['link_role']
    if vault is None:
        return None
    if row['s_status'] == 'live' and row['s_owner'] not in (row['link_owner'], vault):
        return None
    state = 'held'
    for entry in row['link_events'] or []:
        event, a = entry['event'], entry['args']
        if role == 'successor':
            if event == 'ChildWithdrawn':
                state = 'left'
        elif event == 'ExitExecuted' or (event == 'RootDisarmed' and int(a['reason']) in ENDING_DISARMS):
            state = 'left'
        elif event == 'ExitModuleSet':
            enabled = a['module'] not in (None, ZERO)
            if enabled and state == 'left':
                state = 'protected'
            elif not enabled and state == 'protected':
                state = 'left'
    return None if state == 'left' else {'address': vault, 'role': role}


def mandate_entry(row, now, *, halted, vaults, positions, waiting=None):
    """One mandate, with what blocks it now (F4 "Execution", app spec §4.5).
    vaults: (chain, vault) -> vault entry; positions: (chain, dex, token id) ->
    position entry, both from the same answer."""
    a, chain_id = row['args'], int(row['chain_id'])
    ended = row['ended']
    status = 'active' if ended is None else 'revoked' if ended['event'] == 'MandateRevoked' else 'executed'
    terms = row['terms']
    if terms is not None:
        terms = {'triggerBelowSqrtPriceX96': _opt_raw(terms['triggerBelowSqrtPriceX96']),
                 'triggerAboveSqrtPriceX96': _opt_raw(terms['triggerAboveSqrtPriceX96']),
                 'receive': 'converted' if int(terms['receiveMode']) == 1 else 'both',
                 'convertTo': _opt_address(terms['convertTo']), 'maxSlippageBps': int(terms['maxSlippageBps'])}
    valid_until, known = int(a['validUntil']), bool(row['vault_known'])
    vault = vaults.get((chain_id, a['vault']))
    position = 'unknown'
    member = None
    if known and vault is not None:
        member = next((m for m in vault['members'] if m['tokenId'] == a['tokenId']), None)
        position = member['role'] if member is not None else 'unknown'
    module_enabled = (row['exit_module'] == row['address']) if known else None
    # The automation decided its row at a block before the vault's latest ExitModuleSet: the module it saw is not the
    # module now (a "Turn back on", or a turn-off, since), so its reason no longer holds until its next pass.
    changed = row.get('exit_module_block')
    if waiting is not None and changed is not None and int(changed) > int(waiting['block']):
        waiting = None
    blocked = []
    if status == 'active':
        if valid_until < now:
            blocked.append('expired')
        if not known:
            blocked.append('vault_not_domino')
        else:
            if module_enabled is False:
                blocked.append('module_disabled')
            if halted.get(chain_id) is True:
                blocked.append('automation_halted')
            if vault is None:
                blocked.append('custody_unread')  # the vault is past this answer's bound
            elif position == 'root':
                held = positions.get((chain_id, vault['dex'], a['tokenId']))
                live = held is not None and held['state']['status'] == 'live'
                if not live:
                    blocked.append('custody_unread')
                elif held['state']['owner'] != a['owner'] or held['state']['custody']['approved'] != a['vault']:
                    blocked.append('custody_lost')
            elif position == 'unknown' or member['status'] != 'active':
                blocked.append('not_in_vault')
        blocked = [b for b in BLOCKERS if b in blocked]
    return {'chainId': chain_id, 'mandateHash': row['mandate_hash'], 'module': row['address'], 'owner': a['owner'],
            'vault': a['vault'], 'vaultIsDomino': known, 'tokenId': a['tokenId'],
            'position': position if known else 'unknown', 'validUntil': valid_until,
            'registered': {'hash': row['tx_hash'], 'snapshot': _snapshot(row['block_number'], row['block_hash'],
                                                                         row['block_timestamp'])},
            'status': status, 'expired': status == 'active' and valid_until < now, 'moduleEnabled': module_enabled,
            'blockedBy': blocked, 'terms': terms,
            'revoked': _tx(ended) if status == 'revoked' else None,
            'executed': None if status != 'executed' else {
                'tx': _tx(ended), 'anchorSqrtPriceX96': ended['args']['anchorSqrtPriceX96'],
                'delivered': [ended['args']['amount0'], ended['args']['amount1']]},
            'waiting': waiting_entry(waiting) if status == 'active' else None}


def waiting_keys(vaults, mandates):
    """The (chain, kind, subject) whose automation rows an answer may show."""
    return ([(int(row['chain_id']), 'vault', row['vault']) for row in vaults[:MAX_VAULTS]]
            + [(int(row['chain_id']), 'mandate', row['mandate_hash']) for row in mandates[:MAX_MANDATES]])


def build_portfolio(wallet, now, *, deployments, vaults, positions, mandates, credits, tokens, waiting_reports=None,
                    waiting=None, prices=None):
    """waiting_reports: chain id -> its waiting_reports row; waiting: (chain, kind,
    subject) -> its waiting row. A row is shown only while its chain's file was read."""
    reports, rows = waiting_reports or {}, waiting or {}
    read = {chain for chain, report in reports.items() if report['status'] == 'read'}

    def row_of(chain_id, kind, subject):
        return rows.get((chain_id, kind, subject)) if chain_id in read else None
    autos = {row['chain_id']: row['auto_exit'] for row in deployments}
    chain_rows = chains(deployments, now, reports)
    halted = {c['chainId']: c['automationHalted'] for c in chain_rows}
    vault_entries = [vault_entry(row, now, autos.get(row['chain_id']), row_of(int(row['chain_id']), 'vault',
                                                                              row['vault']))
                     for row in vaults[:MAX_VAULTS]]
    position_entries = [position_entry(row, now) for row in positions[:MAX_POSITIONS]]
    by_vault = {(v['chainId'], v['address']): v for v in vault_entries}
    by_position = {(p['chainId'], p['dex'], p['tokenId']): p for p in position_entries}
    mandate_entries = [mandate_entry(row, now, halted=halted, vaults=by_vault, positions=by_position,
                                     waiting=row_of(int(row['chain_id']), 'mandate', row['mandate_hash']))
                       for row in mandates[:MAX_MANDATES]]
    credit_entries = [{'chainId': int(row['chain_id']), 'module': row['module'], 'token': row['token'],
                       'unclaimed': str(int(row['unclaimed']))} for row in credits if int(row['unclaimed']) > 0]
    keys = []
    for vault in vault_entries:
        if vault['state']['status'] == 'read':
            pool = vault['state']['pool']
            keys += [(vault['chainId'], pool['currency0']), (vault['chainId'], pool['currency1'])]
    for position in position_entries:
        if position['state']['status'] == 'live':
            pool = position['state']['pool']
            keys += [(position['chainId'], pool['currency0']), (position['chainId'], pool['currency1'])]
    for mandate in mandate_entries:
        if mandate['terms'] is not None and mandate['terms']['convertTo'] is not None:
            keys.append((mandate['chainId'], mandate['terms']['convertTo']))
    keys += [(credit['chainId'], credit['token']) for credit in credit_entries[:MAX_CREDITS]]
    body = envelope('stored_v2_portfolio', wallet, now, chain_rows, token_list(keys, tokens(keys), prices))
    body.update(vaults=vault_entries, positions=position_entries, mandates=mandate_entries,
                credits=credit_entries[:MAX_CREDITS],
                truncated={'vaults': len(vaults) > MAX_VAULTS, 'positions': len(positions) > MAX_POSITIONS,
                           'mandates': len(mandates) > MAX_MANDATES})
    return validate_v6_response('portfolio', body)


# ---------------------------------------------------------------- activity
def _leg(a):
    return {'kind': LEG_KINDS[int(a['kind'])], 'tokenIn': a['tokenIn'], 'tokenOut': a['tokenOut'],
            'venue': a['venue'], 'amountIn': a['amountIn'], 'amountOut': a['amountOut']}


def _tariffs(logs, rate=None):
    out = []
    for log in logs:
        a = log['args']
        if log['event'] == 'FeeCharged':
            kind = FEE_KINDS[int(a['kind'])]
            out.append({'kind': kind, 'rateBps': {'assisted_swap': 65, 'auto_exit': 20}.get(kind, rate),
                        'token': a['token'], 'amount': a['amount'], 'deferred': '0'})
        elif log['event'] == 'FeeDeferred':
            for tariff in reversed(out):
                if tariff['token'] == a['token']:
                    tariff['deferred'] = a['amount']
                    break
            else:
                raise DataError('v2_receipt_unanchored')
    return out


def _of(logs, *events):
    return [log for log in logs if log['event'] in events]


def _vault_event(log):
    a, event = log['args'], log['event']
    entry = {'event': event, 'stateNonce': a.get('stateNonce')}
    if event == 'PolicyChanged':
        entry['policy'] = _policy(a['policy'])
    elif event == 'LimitsChanged':
        entry['limits'] = _limits(a['limits'])
    elif event == 'AutomationPaused':
        entry['actor'] = a['actor']
    elif event == 'RootDisarmed':
        entry['reason'] = DISARM_REASONS[int(a['reason'])]
    elif event == 'RootCheckpointed':
        entry['liquidity'] = a['checkpoint']['liquidity']
    elif event in ('ReservesWithdrawn', 'TokenRecovered'):
        entry.update(token=a['token'], amount=a['amount'])
    elif event in ('ChildWithdrawn', 'PositionRecovered'):
        entry['tokenId'] = a['tokenId']
    elif event == 'ExitModuleSet':
        entry['module'] = _opt_address(a['module'])
    return entry


def _returned(row, events, transaction, operators):
    """A vault_event that is a returnReserves() the owner did not send, as reserves_returned, or None. Only
    returnReserves pays reserves on a sender other than the owner's (withdrawReserves and exitAll are the owner's),
    and it pays each token once, at one nonce. `operators`: the sender's OperatorSet changes, oldest first."""
    sender = None if transaction is None else transaction['sender']
    tokens = [event.get('token') for event in events]
    if (sender is None or sender == row['wallet'] or any(event['event'] != 'ReservesWithdrawn' for event in events)
            or len(set(tokens)) != len(tokens) or len({event['stateNonce'] for event in events}) != 1):
        return None
    at = (int(row['block_number']), int(row['log_index']))
    admitted = False
    for block, index, allowed in operators.get((int(row['chain_id']), sender), ()):
        if (block, index) < at:
            admitted = allowed
    return {'kind': 'reserves_returned', 'vault': row['vault'], 'returnedBy': sender, 'byOperator': admitted,
            'stateNonce': events[0]['stateNonce'],
            'reservesReturned': [{'token': event['token'], 'amount': event['amount']} for event in events]}


def activity_item(row, logs, transaction, automation_mode, finalized, operators=None):
    """One item from its activity row, its logs (log order) and its transaction;
    `finalized` is the chain's finalized block number, or None; `operators`:
    (chain id, address) -> its OperatorSet changes, oldest first."""
    anchor = next(log for log in logs if log['log_index'] == row['log_index'])
    chain_id, number = int(row['chain_id']), int(row['block_number'])
    gas = None
    if transaction is not None:
        gas = {'sender': transaction['sender'], 'status': 'success', 'gasUsed': str(int(transaction['gas_used'])),
               'effectiveGasPriceWei': str(int(transaction['effective_gas_price'])),
               'l1FeeWei': None if transaction['l1_fee'] is None else str(int(transaction['l1_fee']))}
    item = {'id': f"{chain_id}:{number}:{int(row['log_index'])}", 'chainId': chain_id,
            'tx': {'hash': row['tx_hash'], 'snapshot': _snapshot(number, anchor['block_hash'], row['block_timestamp']),
                   'gas': gas, 'finality': 'finalized' if finalized is not None and number <= finalized
                   else 'unfinalized'},
            'kind': row['kind']}
    a, kind = anchor['args'], row['kind']
    if kind == 's1_action':
        steps = _of(logs, 'PositionLiquidityChanged')
        owner = next((log['args']['owner'] for log in steps + _of(logs, 'InputPulled')), None)
        owner = owner or next((log['args']['payer'] for log in _of(logs, 'FeeCharged')), a['recipient'])
        item.update(zap=row['address'], intentHash=a['intentHash'], action=ACTIONS[int(a['action'])], owner=owner,
                    recipient=a['recipient'], tokenId=a['tokenId'],
                    previousTokenId=None if int(a['action']) == 1 else a['previousTokenId'],
                    liquidity=a['liquidity'],
                    inputs=[{'token': log['args']['token'], 'amount': log['args']['amount']}
                            for log in _of(logs, 'InputPulled')],
                    legs=[_leg(log['args']) for log in _of(logs, 'SwapLegExecuted')],
                    steps=[{'tokenId': log['args']['tokenId'], 'pool': _pool(log['args']['pool']),
                            'liquidityDelta': log['args']['liquidityDelta'], 'amount0': log['args']['amount0'],
                            'amount1': log['args']['amount1']} for log in steps],
                    refunds=[{'recipient': log['args']['recipient'], 'token': log['args']['token'],
                              'amount': log['args']['amount']} for log in _of(logs, 'Refunded')],
                    tariffs=_tariffs(logs))
    elif kind == 'vault_execution':
        compounded, = _of(logs, 'Compounded')
        successor = _of(logs, 'SuccessorCreated')
        rate = AUTOMATION_RATE.get(automation_mode)
        item.update(vault=row['vault'], planHash=a['planHash'], action=PLAN_ACTIONS[int(a['action'])],
                    stateNonce=a['stateNonce'],
                    feesCollected=[{'tokenId': log['args']['tokenId'], 'amount0': log['args']['amount0'],
                                    'amount1': log['args']['amount1']} for log in _of(logs, 'FeesCollected')],
                    swaps=[{'source': log['args']['source'], 'zeroForOne': log['args']['zeroForOne'],
                            'amountIn': log['args']['amountIn'], 'amountOut': log['args']['amountOut']}
                           for log in _of(logs, 'Swapped')],
                    legs=[_leg(log['args']) for log in _of(logs, 'SwapLegExecuted')],
                    compounded={name: compounded['args'][name] for name in
                                ('tokenId', 'liquidityAdded', 'fees0', 'fees1', 'serviceFee0', 'serviceFee1')},
                    successor=None if not successor else {'parentTokenId': successor[0]['args']['parentTokenId'],
                                                          'tokenId': successor[0]['args']['tokenId']},
                    tariffs=_tariffs(logs, rate))
    elif kind == 'auto_exit':
        exited, = _of(logs, 'ExitExecuted')
        module_logs = [log for log in logs if log['address'] == row['address']]
        vault_logs = [log for log in logs if log['address'] == row['vault']]
        item.update(module=row['address'], mandateHash=a['mandateHash'], vault=row['vault'],
                    tokenId=exited['args']['tokenId'],
                    member='successor' if _of(vault_logs, 'ChildWithdrawn') else 'root',
                    anchorSqrtPriceX96=a['anchorSqrtPriceX96'], recipient=a['recipient'],
                    withdrawn=[exited['args']['amount0'], exited['args']['amount1']],
                    delivered=[a['amount0'], a['amount1']],
                    deferred=[{'token': log['args']['token'], 'amount': log['args']['amount']}
                              for log in _of(module_logs, 'DeliveryDeferred')],
                    reservesReturned=[{'token': log['args']['token'], 'amount': log['args']['amount']}
                                      for log in _of(vault_logs, 'ReservesWithdrawn')],
                    legs=[_leg(log['args']) for log in _of(module_logs, 'SwapLegExecuted')],
                    tariffs=_tariffs(module_logs))
    elif kind == 'vault_created':
        policy, = _of(logs, 'PolicyChanged')
        limits, = _of(logs, 'LimitsChanged')
        item.update(vault=a['vault'], factory=row['address'], dex=int(a['dex']), owner=a['owner'],
                    rootTokenId=a['rootTokenId'], ownerNonce=a['ownerNonce'], policy=_policy(policy['args']['policy']),
                    limits=_limits(limits['args']['limits']))
    elif kind == 'vault_event':
        events = [_vault_event(log) for log in logs]
        item.update(_returned(row, events, transaction, operators or {}) or {'vault': row['vault'], 'events': events})
    elif kind == 'auto_exit_event':
        event = anchor['event']
        fields = dict.fromkeys(('mandateHash', 'vault', 'tokenId', 'validUntil', 'nonce', 'token', 'recipient',
                                'amount'))
        if event == 'MandateRegistered':
            fields.update(mandateHash=a['mandateHash'], vault=a['vault'], tokenId=a['tokenId'],
                          validUntil=int(a['validUntil']))
        elif event == 'MandateRevoked':
            fields.update(mandateHash=a['mandateHash'], vault=row['vault'])
        elif event == 'NonceCancelled':
            fields['nonce'] = a['nonce']
        else:
            fields.update(token=a['token'], recipient=a['recipient'], amount=a['amount'])
        item.update(module=row['address'], event=event, **fields)
    elif kind == 'zap_event':
        item.update(zap=row['address'], event=anchor['event'], owner=a['owner'], word=a['word'], mask=a['mask'])
    else:
        raise DataError('v2_activity_kind_unknown')
    return item


def _item_tokens(item):
    chain_id, keys = item['chainId'], []
    for field in ('inputs', 'refunds', 'tariffs', 'deferred', 'reservesReturned'):
        keys += [(chain_id, line['token']) for line in item.get(field, [])]
    for leg in item.get('legs', []):
        keys += [(chain_id, leg['tokenIn']), (chain_id, leg['tokenOut'])]
    for step in item.get('steps', []):
        keys += [(chain_id, step['pool']['currency0']), (chain_id, step['pool']['currency1'])]
    for event in item.get('events', []):
        if 'token' in event:
            keys.append((chain_id, event['token']))
    if item.get('token'):
        keys.append((chain_id, item['token']))
    return keys


def build_activity(wallet, now, limit, *, deployments, rows, logs, transactions, modes, tokens, waiting_reports=None,
                   operators=None, prices=None):
    """rows: activity rows newest first (limit + 1 at most); logs: (chain, block,
    log index) -> log row; transactions: (chain, tx) -> row; modes: (chain,
    vault, block, log index) -> the vault's mode at that execution; operators:
    (chain, address) -> the registry's OperatorSet changes for it, oldest first."""
    page = rows[:limit]
    chain_rows = chains(deployments, now, waiting_reports)
    finalized = {c['chainId']: None if c['finalizedThrough'] is None else c['finalizedThrough']['number']
                 for c in chain_rows}
    items = []
    for row in page:
        chain_id = int(row['chain_id'])
        item_logs = [logs[(chain_id, int(row['block_number']), index)] for index in row['log_indexes']]
        items.append(activity_item(row, item_logs, transactions.get((chain_id, row['tx_hash'])),
                                   modes.get((chain_id, row['vault'], int(row['block_number']), int(row['log_index']))),
                                   finalized.get(chain_id), operators))
    keys = [key for item in items for key in _item_tokens(item)]
    last = page[-1] if page else None
    body = envelope('stored_v2_activity', wallet, now, chain_rows, token_list(keys, tokens(keys), prices))
    body.update(items=items, nextCursor=make_cursor(int(last['block_timestamp']), int(last['chain_id']),
                                                    int(last['block_number']), int(last['log_index']))
                if len(rows) > limit else None)
    return validate_v6_response('activity', body)


# ------------------------------------------------------------ position fees
# What a position-fees answer may weigh: under the gateway's and the read Worker's 1 MiB with room. Its counts are
# bounded by the contract; its amounts' digits are not, so the oldest events and points go first beyond this.
FEE_ANSWER_BYTES = 900_000


def _pair(row, a, b):
    return None if row[a] is None else [str(int(row[a])), str(int(row[b]))]


def fee_follower(cursor, latest):
    """The chain's fee follower against the index's newest checkpoint (read-v6 FeeFollower)."""
    indexed = None if latest is None else _snapshot(latest['end_block'], latest['end_hash'], latest['end_timestamp'])
    if cursor is None:
        return {'status': 'unavailable', 'reason': 'fees_not_followed', 'through': None, 'indexedThrough': indexed,
                'lagSeconds': None, 'lastError': None}
    through = _snapshot(cursor['block_number'], cursor['block_hash'], cursor['block_timestamp'])
    lag = None if indexed is None else max(0, indexed['timestamp'] - through['timestamp'])
    out = {'through': through, 'indexedThrough': indexed, 'lagSeconds': lag,
           'lastError': None if cursor['last_error'] is None else {'code': cursor['last_error'],
                                                                   'at': int(cursor['last_error_at'])}}
    if not cursor['caught_up']:
        return {**out, 'status': 'stale', 'reason': 'reading_back'}
    if lag is not None and lag > MAX_LAG_SECONDS:
        return {**out, 'status': 'stale', 'reason': 'behind_index'}
    return {**out, 'status': 'current', 'reason': None}


def _settlement(row):
    return {'kind': row['kind'], 'block': _snapshot(row['block_number'], row['block_hash'], row['block_timestamp']),
            'logIndex': int(row['log_index']), 'logIndexes': [int(i) for i in row['log_indexes']],
            'tx': row['tx_hash'], 'liquidityDelta': str(int(row['liquidity_delta'])),
            'liquidity': str(int(row['liquidity'])), 'fees': _pair(row, 'fees0', 'fees1'),
            'settled': _pair(row, 'settled0', 'settled1'), 'why': row['why'], 'auto': bool(row['auto']),
            'serviceFee': _pair(row, 'service_fee0', 'service_fee1')}


def _transfer(row):
    return {'block': _snapshot(row['block_number'], row['block_hash'], row['block_timestamp']),
            'logIndex': int(row['log_index']), 'tx': row['tx_hash'], 'fromAddress': row['from_address'],
            'toAddress': row['to_address']}


def _point(row):
    return {'block': int(row['block_number']), 'timestamp': int(row['block_timestamp']), 'hour': int(row['hour']),
            'kind': row['kind'], 'earned': _pair(row, 'earned0', 'earned1'),
            'settled': _pair(row, 'settled0', 'settled1')}


def _fee_now(row, position):
    s, pool = row['state'], position['pool']
    v4 = int(pool['dex']) == 4
    return {'snapshot': _snapshot(row['block_number'], row['block_hash'], row['block_timestamp']), 'owner': s['owner'],
            'pool': _pool(pool), 'poolId': position['pool_key'] if v4 else None,
            'poolAddress': None if v4 else position['pool_key'], 'tickLower': int(position['tick_lower']),
            'tickUpper': int(position['tick_upper']), 'liquidity': s['liquidity'], 'sqrtPriceX96': s['sqrtPriceX96'],
            'tick': int(s['tick']), 'inRange': int(position['tick_lower']) <= int(s['tick']) < int(position['tick_upper']),
            'protocolFee': int(s['protocolFee']), 'feeGrowthInsideX128': s['feeGrowthInsideX128'],
            'feeGrowthInsideLastX128': s['feeGrowthInsideLastX128'], 'tokensOwed': s['tokensOwed'],
            'collectable': s['collectable'], 'unsettled': s['unsettled'], 'earned': s['earned'],
            'settled': s['settled'], 'principalAtSpot': s['principalAtSpot']}


def position_fees_entry(chain_id, dex, token_id, found, follower, now):
    """One position of a position-fees answer from what fee_position read."""
    base = {'dex': dex, 'tokenId': str(token_id), 'positionManager': _manager(chain_id, dex), 'since': None,
            'through': None, 'freshness': None, 'exact': False, 'why': None, 'now': None, 'events': [],
            'transfers': [], 'points': [], 'truncated': False}
    row = found['row']
    if follower['status'] == 'unavailable' or (row is None and not found['known']):
        return {**base, 'status': 'not_followed'}
    if row is None:
        return {**base, 'status': 'reading', 'why': 'reading'}
    through = _snapshot(row['through_block'], row['through_hash'], row['through_timestamp'])
    age = max(0, now - through['timestamp'])
    since = None if row['since_kind'] is None else {
        'kind': row['since_kind'], 'block': _snapshot(row['since_block'], row['since_hash'], row['since_timestamp'])}
    out = {**base, 'since': since, 'through': through,
           'freshness': {'ageSeconds': age, 'status': 'fresh' if age <= FEE_FRESH_SECONDS else 'stale'},
           'events': [_settlement(r) for r in found['events']], 'transfers': [_transfer(r) for r in found['transfers']],
           'points': [_point(r) for r in found['points']], 'truncated': found['truncated']}
    state = found['now']
    if row['status'] == 'burned':
        status = 'burned'
    elif (row['status'] == 'following' and follower['status'] != 'unavailable' and state is not None
          and int(state['block_number']) == through['number'] and since is not None):
        status = 'following'
        out['now'] = _fee_now(state, row)
    else:
        status = 'reading'
    if status == 'reading':
        return {**out, 'status': status, 'why': 'reading'}
    if found['why'] is not None:
        return {**out, 'status': status, 'why': found['why']}
    return {**out, 'status': status, 'exact': True, 'why': 'before_floor' if since['kind'] == 'floor' else None}


def build_position_fees(chain_id, positions, now, *, follower, read):
    """position-fees: each position asked, in order, read by `read(dex, token id, events=, points=, transfers=)`
    with its share of the answer's events and points."""
    events, points = MAX_FEE_EVENTS // len(positions), MAX_FEE_POINTS // len(positions)
    body = {'schemaVersion': 1, 'contractVersion': NEXT_VERSION, 'mode': 'stored_v2_position_fees',
            'chainId': chain_id, 'servedAt': now, 'follower': follower,
            'positions': [position_fees_entry(chain_id, dex, token_id, read(dex, token_id, events=events, points=points,
                                                                            transfers=MAX_FEE_TRANSFERS),
                                              follower, now) for dex, token_id in positions],
            'limitations': list(FEE_LIMITATIONS), 'executionAvailable': False}
    while len(json.dumps(body, separators=(',', ':')).encode()) > FEE_ANSWER_BYTES:
        cut = False
        for entry in body['positions']:
            for name in ('events', 'points'):
                if len(entry[name]) > 1:
                    entry[name] = entry[name][len(entry[name]) // 2:]
                    entry['truncated'] = cut = True
        if not cut:
            break
    return validate_v6_response('position-fees', body)


class V2ReadService:
    """The two read-v6 routes over the V2 index, through the catalogue reader:
    one read-only snapshot per answer, the automation's waiting reasons included
    (the indexer keeps them, v2_waiting)."""
    def __init__(self, store, clock=time.time, pricer=None):
        self.store, self.clock = store, clock
        self.prices = None if pricer is None else pricer.prices

    def portfolio(self, wallet):
        with self.store.reader() as reader:
            now = int(self.clock())
            vaults = reader.vaults(wallet, MAX_VAULTS + 1)
            mandates = reader.mandates(wallet, MAX_MANDATES + 1)
            return build_portfolio(wallet, now, deployments=reader.deployments(), vaults=vaults,
                                   positions=reader.positions(wallet, MAX_POSITIONS + 1), mandates=mandates,
                                   credits=reader.credits(wallet), tokens=reader.tokens,
                                   waiting_reports=reader.waiting_reports(),
                                   waiting=reader.waiting(waiting_keys(vaults, mandates)), prices=self.prices)

    def position_fees(self, chain_id, positions):
        """read-v6 1.2.0-rc.1: what the chain's fee follower stored for each (dex, token id), one snapshot."""
        with self.store.reader() as reader:
            now = int(self.clock())
            follower = fee_follower(*reader.fee_follower(chain_id))
            return build_position_fees(chain_id, positions, now, follower=follower,
                                       read=lambda dex, token, **limits: reader.fee_position(chain_id, dex, token,
                                                                                             **limits))

    def activity(self, wallet, limit=20, cursor=None):
        if type(limit) is not int or not 1 <= limit <= MAX_ITEMS:
            raise DataError('invalid_request')
        try:
            before = None if cursor is None else cursor_key(cursor)
        except ValueError:
            raise DataError('invalid_request') from None
        with self.store.reader() as reader:
            now = int(self.clock())
            rows = reader.activity(wallet, limit + 1, before)
            page = rows[:limit]
            return build_activity(wallet, now, limit, deployments=reader.deployments(), rows=rows,
                                  logs=reader.item_logs(page),
                                  transactions=reader.transactions({(int(r['chain_id']), r['tx_hash']) for r in page}),
                                  modes=reader.execution_modes([r for r in page if r['kind'] == 'vault_execution']),
                                  tokens=reader.tokens, waiting_reports=reader.waiting_reports(),
                                  operators=reader.operator_changes({int(r['chain_id']) for r in page
                                                                     if r['kind'] == 'vault_event'}),
                                  prices=self.prices)
