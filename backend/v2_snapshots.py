"""Reads that complete the V2 index, each at a block the index has committed.

Events say what happened; some facts are only in state, or only in the
transaction receipt:
- a vault's own views (pool, members, policy, limits, pause, custody, exit
  module): `paused` is not in the creation events, and exitAll pauses without
  an event, so the vault itself is read;
- a position's owner, custody, range, liquidity and fees owed, through F6's
  UniswapReader;
- a mandate's terms (triggers, conversion, slippage), which MandateRegistered
  does not carry; they never change once registered;
- token metadata (untrusted text; decimals never guessed);
- who sent a transaction and the gas it paid.

Every state read is pinned at the end block of the latest checkpoint, so a
snapshot describes the chain exactly as far as the events do, and is written
only while that checkpoint still stands (a rewind in between discards it).
Calls come from the frozen ABI exports (v2_abi), never re-declared, except the
ERC-20/721 reads tokens and burns need, which are not V2 interfaces.
"""
import re

from eth_hash.auto import keccak

from discovery import ZERO, DataError, address, bytes32, decode_result, decode_symbol, prefetched, quantity
from v2_abi import function
from v2_chains import DEX_V3
from v2_rpc import MAX_LOG_WINDOWS, batched_reads
from v2_uniswap import PositionRef, UniswapReader

VAULT_VIEWS = (('IDominoVault', 'owner'), ('IDominoVault', 'factory'), ('IDominoVault', 'pool'),
               ('IDominoVault', 'root'), ('IDominoVault', 'positions'), ('IDominoVault', 'policy'),
               ('IDominoVault', 'limits'), ('IDominoVault', 'paused'), ('IDominoVault', 'rootArmed'),
               ('IDominoVault', 'stateNonce'), ('IDominoVault', 'exitModule'),
               ('IDominoVaultLedger', 'quoteCurrency'), ('IDominoVaultLedger', 'lastExecutionAt'))
TRANSFER_TOPIC = '0x' + keccak(b'Transfer(address,address,uint256)').hex()
MAX_POSITIONS_PER_VAULT = 256
# Errors a read may meet that say nothing about the position or the vault:
# the pass stops reading and tries again later.
TRANSIENT = frozenset({'network_unavailable', 'request_budget_exhausted', 'v2_rpc_endpoints_cooling',
                       'read_deadline_exceeded', 'snapshot_reorganized', 'http_429', 'http_502', 'http_503',
                       'http_504', 'block_unavailable', 'rpc_error', 'invalid_rpc_envelope', 'missing_rpc_result'})


def _calls(rpc, block, calls):
    """[(target, Function, args)] at `block`, decoded; a refused item raises."""
    gas = hex(rpc.call_gas_limit)
    raw = batched_reads(rpc, [('eth_call', [{'to': target, 'data': fn.calldata(*args), 'gas': gas}, block.tag])
                              for target, fn, args in calls])
    return [fn.decode(prefetched(item)) for (_, fn, _), item in zip(calls, raw)]


def _pool(value):
    dex, currency0, currency1, fee, spacing, hooks = value
    return {'dex': dex, 'currency0': address(currency0), 'currency1': address(currency1), 'fee': fee,
            'tickSpacing': spacing, 'hooks': address(hooks)}


def read_vault(rpc, block, vault):
    """The vault's own views at `block`, as stored in vault_snapshots.state:
    one envelope for the views, one for each member's ledger and the reserves."""
    values = _calls(rpc, block, [(vault, function(i, name), ()) for i, name in VAULT_VIEWS])
    ((owner,), (factory,), (pool,), (root,), (members,), (policy,), (limits,), (paused,), (armed,), (nonce,),
     (module,), (quote,), (last,)) = values
    if len(members) > MAX_POSITIONS_PER_VAULT:
        raise DataError('v2_vault_state_invalid')
    tokens = [address(pool[1]), address(pool[2])]
    member, lot = function('IDominoVaultLedger', 'member'), function('IDominoVaultLedger', 'lot')
    calls = []
    for token_id in members:
        calls += [(vault, member, (token_id,)), (vault, lot, (token_id, tokens[0])), (vault, lot, (token_id, tokens[1]))]
    for token in tokens:
        calls += [(vault, function('IDominoVault', 'reserves'), (token,)),
                  (vault, function('IDominoVaultLedger', 'idleReserves'), (token,))]
    ledger = _calls(rpc, block, calls)
    states = []
    for index, token_id in enumerate(members):
        (active, parent, successor, lower, upper), = ledger[3 * index]
        lots = [ledger[3 * index + 1][0], ledger[3 * index + 2][0]]
        states.append({'tokenId': str(token_id), 'active': active, 'parent': str(parent), 'successor': str(successor),
                       'tickLower': lower, 'tickUpper': upper,
                       'lots': [{'token': token, 'uncharged': str(u), 'charged': str(c)}
                                for token, (u, c) in zip(tokens, lots)]})
    base = 3 * len(members)
    reserves = [{'token': token, 'total': str(ledger[base + 2 * i][0]), 'idle': str(ledger[base + 2 * i + 1][0])}
                for i, token in enumerate(tokens)]
    mode, trigger, overlap, interval, max_positions = policy
    slippage, impact, age, upside = limits
    dex, manager, root_id = root
    return {'owner': address(owner), 'factory': address(factory), 'pool': _pool(pool),
            'root': {'dex': dex, 'positionManager': address(manager), 'tokenId': str(root_id)},
            'members': states,
            'policy': {'mode': mode, 'triggerDistanceBps': trigger, 'maxOverlapBps': overlap,
                       'minimumIntervalSeconds': interval, 'maxPositions': max_positions},
            'limits': {'maxSlippageBps': slippage, 'maxPriceImpactBps': impact,
                       'maxObservationAgeSeconds': age, 'upsideBps': upside},
            'paused': paused, 'rootArmed': armed, 'stateNonce': str(nonce), 'exitModule': address(module),
            'quoteCurrency': address(quote), 'lastExecutionAt': str(last), 'reserves': reserves}


def _burn_proven(rpc, chain, dex, token_id, since_block, block):
    """The position manager's own Transfer to the zero address for this token,
    between its last indexed event and `block` (no Domino event can name a
    burned token, so the burn is after it): a burn is proven, never inferred.
    One bloom-indexed getLogs, split to the endpoint's window by the transport."""
    manager = chain.uniswap.v3.positionManager if dex == DEX_V3 else chain.uniswap.v4.positionManager
    # More windows than an endpoint serves in one read would fail the client
    # for the rest of the pass: decide before asking.
    limits = [e.max_log_blocks for e in rpc.endpoints.endpoints if e.max_log_blocks]
    if limits and -(-(block.number - since_block + 1) // min(limits)) > MAX_LOG_WINDOWS:
        raise DataError('v2_burn_unproven')
    logs = rpc.request('eth_getLogs', [{'address': manager, 'fromBlock': hex(since_block), 'toBlock': block.tag,
                                        'topics': [TRANSFER_TOPIC, None, '0x' + '00' * 32,
                                                   '0x' + token_id.to_bytes(32, 'big').hex()]}])
    if not isinstance(logs, list):
        raise DataError('invalid_logs_response')
    for log in logs:
        if (not isinstance(log, dict) or log.get('removed') is not False or address(log.get('address')) != manager
                or quantity(log.get('blockNumber')) > block.number):
            raise DataError('invalid_logs_response')
    return bool(logs)


def read_position(rpc, chain, block, dex, token_id, last_event_block):
    """(status, owner, state, reason) for one position at `block`;
    `last_event_block` is the last block an indexed event named it."""
    manager = chain.uniswap.v3.positionManager if dex == DEX_V3 else chain.uniswap.v4.positionManager
    try:
        position = UniswapReader(chain, rpc).position(PositionRef(dex, manager, token_id), block)
    except DataError as error:
        code = str(error)
        if code in TRANSIENT:
            raise
        # Absent info (v4) or a manager that reverts on the token (v3) is a
        # burn only when the manager's own Transfer to zero proves it.
        if code in ('v2_position_not_found', 'rpc_call_reverted', 'v2_position_has_no_owner'):
            try:
                if _burn_proven(rpc, chain, dex, token_id, last_event_block, block):
                    return 'burned', None, None, None
            except DataError as unproven:
                # Further back than one read reaches: the burn stays unproven,
                # and the pass goes on with the others.
                if str(unproven) != 'v2_burn_unproven':
                    raise
                return 'unavailable', None, None, 'v2_burn_unproven'
        return 'unavailable', None, None, code[:80] if re.fullmatch(r'[a-z0-9_]+', code) else 'v2_read_failed'
    principal = position.principal()
    pool = position.pool
    state = {'positionManager': manager, 'owner': position.owner, 'approved': position.approved,
             'subscriber': position.subscriber,
             'pool': {'dex': pool.pool.dex, 'currency0': pool.pool.currency0, 'currency1': pool.pool.currency1,
                      'fee': pool.pool.fee, 'tickSpacing': pool.pool.tick_spacing, 'hooks': pool.pool.hooks},
             'tickLower': position.tick_lower, 'tickUpper': position.tick_upper,
             'liquidity': str(position.liquidity), 'sqrtPriceX96': str(pool.sqrt_price_x96), 'tick': pool.tick,
             'inRange': position.in_range, 'feesOwed': [str(value) for value in position.fees_owed],
             'principalAtSpot': [str(value) for value in principal]}
    return 'live', position.owner, state, None


def read_mandate(rpc, block, module, mandate_hash, registered):
    """The terms of a registered mandate, checked against its MandateRegistered."""
    (record,), = _calls(rpc, block, [(module, function('IDominoAutoExitExtension', 'mandateOf'),
                                      (bytes.fromhex(mandate_hash[2:]),))])
    (owner, valid_until, slippage, mode, _status, vault, convert_to, below, above, token_id) = record
    expected = (registered['owner'], registered['vault'], registered['tokenId'], registered['validUntil'])
    if (address(owner), address(vault), str(token_id), str(valid_until)) != expected:
        raise DataError('v2_mandate_record_mismatch')
    return {'owner': address(owner), 'vault': address(vault), 'tokenId': str(token_id),
            'validUntil': str(valid_until), 'maxSlippageBps': slippage, 'receiveMode': mode,
            'convertTo': address(convert_to), 'triggerBelowSqrtPriceX96': str(below),
            'triggerAboveSqrtPriceX96': str(above)}


def read_tokens(rpc, block, tokens):
    """{address: (decimals, symbol, status, issues)}; V1's rules for both reads."""
    calls = []
    for token in tokens:
        for signature in ('decimals()', 'symbol()'):
            calls.append(('eth_call', [{'to': token, 'data': '0x' + keccak(signature.encode())[:4].hex(),
                                        'gas': hex(rpc.call_gas_limit)}, block.tag]))
    results = batched_reads(rpc, calls) if calls else []
    out = {}
    for index, token in enumerate(tokens):
        raw_decimals, raw_symbol = results[2 * index], results[2 * index + 1]
        decimals = symbol = None
        issues = {}
        try:
            decimals, = decode_result(['uint8'], prefetched(raw_decimals))
        except DataError as error:
            if str(error) in TRANSIENT:
                raise
            issues['decimals'] = str(error)
        try:
            value = decode_symbol(prefetched(raw_symbol))
            if not isinstance(value, str) or not value or len(value) > 40 or not value.isprintable():
                raise DataError('invalid_symbol_text')
            symbol = value
        except DataError as error:
            if str(error) in TRANSIENT:
                raise
            issues['symbol'] = str(error)
        status = 'available' if not issues else 'unavailable' if len(issues) == 2 else 'partial'
        out[token] = (decimals, symbol, status, issues)
    return out


def read_receipt(rpc, tx_hash, block_number, block_hash):
    """Sender, status and gas of a transaction whose events the index holds."""
    raw = rpc.request('eth_getTransactionReceipt', [tx_hash])
    if not isinstance(raw, dict):
        raise DataError('v2_receipt_unavailable')
    if (bytes32(raw.get('transactionHash')) != tx_hash or quantity(raw.get('blockNumber')) != block_number
            or bytes32(raw.get('blockHash')) != block_hash):
        raise DataError('snapshot_reorganized')
    status = quantity(raw.get('status'))
    if status not in (0, 1):
        raise DataError('v2_receipt_invalid')
    l1_fee = raw.get('l1Fee')
    return {'txHash': tx_hash, 'blockNumber': block_number, 'blockHash': block_hash,
            'from': address(raw.get('from')), 'status': status, 'gasUsed': quantity(raw.get('gasUsed')),
            'effectiveGasPrice': quantity(raw.get('effectiveGasPrice')),
            'l1Fee': None if l1_fee is None else quantity(l1_fee)}


def native_token(chain):
    """address(0) on v4 is the chain's native currency: never read, from the profile."""
    return ZERO, (18, chain.nativeSymbol, 'available', {})

