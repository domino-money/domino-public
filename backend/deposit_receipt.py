"""Bounded, read-only reconciliation of an already persisted wallet transaction.

A reported hash is a hint, never evidence of success. Canonical receipts and the
RPC finalized tag are checked independently. No code here issues, signs, retries
or frees a wallet nonce. Transfer amounts are event observations for the trusted
standard-token admission policy; native net spend/refunds stay unavailable.

References: EIP-20/EIP-721 events; v4-core 46c6834698c48bc4a463a86d8420f4eb1d7f3b75
IPoolManager.sol; v4-periphery dce236d4e2057422d0791d9a973a58765eb46f65
PositionManager.sol and PositionInfoLibrary.sol; permit2
cc56ad0f3439c502c246fc5cfcc3db92bb8b7219/src/interfaces/IAllowanceTransfer.sol.
"""
from copy import deepcopy
from dataclasses import asdict
import re

from eth_abi import decode, encode
from eth_hash.auto import keccak

from deposit_models import DepositSelection, PreparedArtifact
from discovery import CHAIN_ID, KEY_TYPES, POOL_MANAGER, POSITION_MANAGER, ZERO, DataError, PoolKey, address, bytes32, quantity
from lp_mint_inspection import inspect_mint
from nft_ownership import signed_tick
from read_deadline import check_read_deadline, read_deadline

PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
MAX_BLOCKS = 16
MAX_TRANSACTIONS = 1024
MAX_BLOCK_TRANSACTIONS = 2048
MAX_LOGS = 256
MAX_HASHES = 8
# Admitted token pairs cost at most 72 historical identity reads. A resumed
# 16-block scan with stale replacement hints and NFT/finality checks can add
# 73 reads including independent finalized nonce proof; leave bounded headroom within the shared DepositRpc ceiling.
MAX_RPC_REQUESTS = 160
MAX_BLOCK_NUMBER = 2**53-1
TRANSFER = '0x' + keccak(b'Transfer(address,address,uint256)').hex()
APPROVAL = '0x' + keccak(b'Approval(address,address,uint256)').hex()
PERMIT_APPROVAL = '0x' + keccak(b'Approval(address,address,address,uint160,uint48)').hex()
MODIFY = '0x' + keccak(b'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)').hex()
REASONS = frozenset(('transaction_not_found', 'transaction_pending', 'scan_in_progress',
    'nonce_consumed_transaction_unresolved', 'transaction_mismatch', 'receipt_mismatch',
    'receipt_pending', 'finality_pending', 'finality_unavailable', 'transaction_confirmed',
    'transaction_reverted', 'canonicality_changed', 'mint_state_unavailable',
    'token_review_changed', 'token_review_unavailable', 'reported_effect_nonce_mismatch'))
QUALIFIED_AMOUNT_BASES = frozenset(('admitted_standard_transfer_events', 'reviewed_proxy_transfer_events'))
UNQUALIFIED_AMOUNT_BASES = {
    'changed': 'token_review_changed',
    'unavailable': 'token_review_unavailable',
    'legacy_unqualified': 'legacy_token_review_unqualified',
}


def _raw(value):
    if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9][0-9]{0,77})', value) or int(value) >= 2**256:
        raise DataError('invalid_deposit_receipt_context')
    return int(value)


def _int(value, maximum=MAX_BLOCK_NUMBER):
    if type(value) is not int or not 0 <= value <= maximum:
        raise DataError('invalid_deposit_receipt_context')
    return value


def _block(raw):
    if not isinstance(raw, dict):
        raise DataError('deposit_receipt_block_unavailable')
    return {'number': _int(quantity(raw.get('number'))), 'hash': bytes32(raw.get('hash')),
            'timestamp': _int(quantity(raw.get('timestamp')))}


def _data(value, max_bytes=65536):
    if not isinstance(value, str) or len(value) > 2 + max_bytes*2 or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', value):
        raise DataError('invalid_deposit_receipt_data')
    return bytes.fromhex(value[2:])


def _abi(types, data):
    try:
        raw = _data(data)
        result = decode(types, raw, strict=True)
        if encode(types, result) != raw:
            raise ValueError()
        return result
    except Exception:
        raise DataError('invalid_deposit_receipt_encoding') from None


def _topic_address(value):
    value = bytes32(value)
    if value[2:26] != '0'*24:
        raise DataError('invalid_deposit_receipt_topic')
    return address('0x' + value[26:])


class _EvidenceMissing(Exception):
    pass


class ReceiptReconciler:
    def __init__(self, rpc, *, token_guard=None, max_blocks=MAX_BLOCKS, max_transactions=MAX_TRANSACTIONS):
        self._request = rpc.request if hasattr(rpc, 'request') else rpc
        if not callable(self._request) or token_guard is not None and not callable(token_guard) or type(max_blocks) is not int or not 1 <= max_blocks <= MAX_BLOCKS or type(max_transactions) is not int or not 1 <= max_transactions <= MAX_TRANSACTIONS:
            raise DataError('invalid_deposit_receipt_config')
        self._token_guard = token_guard
        self.max_blocks, self.max_transactions = max_blocks, max_transactions
        self._count = 0

    def _rpc(self, method, params):
        check_read_deadline()
        self._count += 1
        if self._count > MAX_RPC_REQUESTS:
            raise DataError('deposit_receipt_request_budget')
        try:
            result = self._request(method, params)
        except Exception:
            check_read_deadline()
            raise DataError('deposit_reconciliation_unavailable') from None
        check_read_deadline()
        return result

    def _get_block(self, number, full=False):
        raw = self._rpc('eth_getBlockByNumber', [number if isinstance(number, str) else hex(number), full])
        block = _block(raw)
        if type(number) is int and block['number'] != number:
            raise DataError('deposit_receipt_block_mismatch')
        return block, raw

    def _canonical(self, block):
        current, _ = self._get_block(block['number'])
        return current == block

    def _call(self, target, signature, inputs, values, outputs, block):
        data = '0x' + (keccak(signature.encode())[:4] + encode(inputs, values)).hex()
        raw = self._rpc('eth_call', [{'to': target, 'data': data, 'gas': hex(500000)},
                                    {'blockHash': block['hash'], 'requireCanonical': True}])
        return _abi(outputs, raw)

    @staticmethod
    def _context(owner, selection, artifact):
        try:
            owner = address(owner)
            selection = DepositSelection.model_validate(selection).model_dump(by_alias=True)
            artifact = PreparedArtifact.model_validate(artifact).model_dump(by_alias=True)
            tx = artifact['transaction']
            deadline_limit = 3650 if artifact['kind'] == 'permit2_approval' else 170
            if artifact['preparedDeadline'] > artifact['sourceBlock']['timestamp'] + deadline_limit or _raw(tx['nonceRaw']) >= 2**64-1:
                raise ValueError()
            if tx['from'] != owner:
                raise ValueError()
            for actual, limit in (('gasLimitRaw', 'maxGasLimitRaw'), ('maxFeePerGasRaw', 'maxFeePerGasRaw'), ('maxPriorityFeePerGasRaw', 'maxPriorityFeePerGasRaw')):
                if _raw(tx[actual]) > _raw(selection[limit]):
                    raise ValueError()
            key = PoolKey.checked(tuple(selection['poolKey'].values()), selection['poolId'])
            if artifact['admission']['policyVersion'] == 'direct_existing_pool_v2':
                expected_currencies = [currency for currency in (key.currency0, key.currency1) if currency != ZERO]
                if [review['address'] for review in artifact['admission']['tokenReviews']] != expected_currencies:
                    raise ValueError()
            caps = artifact['mintedBounds']
            if any(_raw(caps[f'amount{i}MaxRaw']) > _raw(selection[f'budget{i}Raw']) for i in (0, 1)):
                raise ValueError()
            if artifact['kind'] == 'mint':
                inspected = inspect_mint({'chainId': tx['chainId'], 'from': owner, 'to': tx['to'],
                    'data': tx['data'], 'value': tx['valueRaw']}, owner=owner, pool_key=key,
                    pool_id=selection['poolId'], tick_lower=selection['tickLower'],
                    tick_upper=selection['tickUpper'], deadline=artifact['preparedDeadline'])
                if inspected != caps:
                    raise ValueError()
                approval = None
            else:
                if tx['valueRaw'] != '0':
                    raise ValueError()
                raw = _data(tx['data'])
                if artifact['kind'] in ('erc20_reset', 'erc20_approval'):
                    if raw[:4] != keccak(b'approve(address,uint256)')[:4]: raise ValueError()
                    spender, amount = _abi(['address', 'uint256'], '0x'+raw[4:].hex())
                    token, expiry = tx['to'], None
                    if spender != PERMIT2 or (artifact['kind'] == 'erc20_reset') != (amount == 0): raise ValueError()
                else:
                    if tx['to'] != PERMIT2 or raw[:4] != keccak(b'approve(address,address,uint160,uint48)')[:4]: raise ValueError()
                    token, spender, amount, expiry = _abi(['address','address','uint160','uint48'], '0x'+raw[4:].hex())
                    if spender != POSITION_MANAGER or not 0 < amount < 2**160-1 or expiry != artifact['preparedDeadline']: raise ValueError()
                currencies = [key.currency0, key.currency1]
                if token == ZERO or token not in currencies: raise ValueError()
                index = currencies.index(token)
                if artifact['kind'] != 'erc20_reset' and amount != _raw(caps[f'amount{index}MaxRaw']): raise ValueError()
                approval = {'token': token, 'spender': spender, 'amountRaw': str(amount), 'expiration': expiry}
            return owner, selection, artifact, key, approval
        except Exception:
            raise DataError('invalid_deposit_receipt_context') from None

    @staticmethod
    def _transaction(raw, owner, expected):
        if not isinstance(raw, dict): return None
        try:
            observed = {'chainId': quantity(raw.get('chainId')), 'from': address(raw.get('from')),
                'to': address(raw.get('to')), 'data': '0x'+_data(raw.get('input')).hex(),
                'valueRaw': str(quantity(raw.get('value'))), 'nonceRaw': str(quantity(raw.get('nonce'))),
                'gasLimitRaw': str(quantity(raw.get('gas'))), 'maxFeePerGasRaw': str(quantity(raw.get('maxFeePerGas'))),
                'maxPriorityFeePerGasRaw': str(quantity(raw.get('maxPriorityFeePerGas')))}
            if quantity(raw.get('type')) != 2 or raw.get('accessList') != [] or raw.get('authorizationList') not in (None, []) or raw.get('blobVersionedHashes') not in (None, []):
                return None
            if any(observed[name] != expected[name] for name in ('chainId','from','to','data','valueRaw','nonceRaw')) or observed['from'] != owner:
                return None
            # Issuance is constrained by the selected limits. An independently
            # mined same-effect wallet replacement can exceed them; that breach
            # is evidence, not proof that the already executed effect is absent.
            if not 21000 <= _raw(observed['gasLimitRaw']) or _raw(observed['maxPriorityFeePerGasRaw']) > _raw(observed['maxFeePerGasRaw']): return None
            return observed
        except (ValueError, TypeError): return None

    @staticmethod
    def _transaction_evidence(observed, selection):
        if observed is None:
            return None
        limits = (('gasLimit', 'gasLimitRaw', 'maxGasLimitRaw'),
                  ('maxFeePerGas', 'maxFeePerGasRaw', 'maxFeePerGasRaw'),
                  ('maxPriorityFeePerGas', 'maxPriorityFeePerGasRaw', 'maxPriorityFeePerGasRaw'))
        return {**{name: observed[name] for name in ('nonceRaw', 'gasLimitRaw',
                    'maxFeePerGasRaw', 'maxPriorityFeePerGasRaw')},
                'selectedLimitsExceeded': [name for name, actual, limit in limits
                    if _raw(observed[actual]) > _raw(selection[limit])]}

    @staticmethod
    def _hint_identity(transaction):
        quantity(transaction.get('chainId')); address(transaction.get('from'))
        if 'to' not in transaction:
            raise DataError('deposit_receipt_hash_mismatch')
        if transaction['to'] is not None: address(transaction['to'])
        _data(transaction.get('input')); quantity(transaction.get('value'))
        quantity(transaction.get('nonce'))

    @staticmethod
    def _same_call(raw, owner, expected):
        """Conservative potential-effect match; unsupported envelopes can execute."""
        try:
            return (quantity(raw.get('chainId')) == CHAIN_ID
                and address(raw.get('from')) == owner
                and address(raw.get('to')) == expected['to']
                and '0x'+_data(raw.get('input')).hex() == expected['data']
                and str(quantity(raw.get('value'))) == expected['valueRaw'])
        except (ValueError, TypeError):
            return False

    @staticmethod
    def _different_effect(raw, owner, expected):
        # A cancellation may be any independently mined owner/nonce effect;
        # changing only gas never proves the deposit itself was cancelled.
        try:
            if (quantity(raw.get('chainId')) != CHAIN_ID or address(raw.get('from')) != owner
                    or str(quantity(raw.get('nonce'))) != expected['nonceRaw']): return False
            target = None if raw.get('to') is None else address(raw['to'])
            payload = '0x'+_data(raw.get('input')).hex()
            value = str(quantity(raw.get('value')))
            # An unsupported authorization/type envelope with the same call is
            # ambiguous, not evidence that the selected mint did not execute.
            return target != expected['to'] or payload != expected['data'] or value != expected['valueRaw']
        except (ValueError, TypeError): return False

    @staticmethod
    def _cancellation(raw, owner, expected):
        try:
            return (quantity(raw.get('chainId')) == CHAIN_ID and address(raw.get('from')) == owner
                and address(raw.get('to')) == owner and quantity(raw.get('nonce')) == _raw(expected['nonceRaw'])
                and quantity(raw.get('value')) == 0 and _data(raw.get('input')) == b''
                and quantity(raw.get('type')) in (0, 1, 2) and raw.get('accessList') in (None, []) and raw.get('authorizationList') in (None, [])
                and raw.get('blobVersionedHashes') in (None, []))
        except (ValueError, TypeError): return False

    @staticmethod
    def _logs(receipt, transaction_hash, block, transaction_index):
        rows = receipt.get('logs')
        if not isinstance(rows, list) or len(rows) > MAX_LOGS:
            raise DataError('invalid_deposit_receipt_logs')
        result, seen = [], set()
        for row in rows:
            if not isinstance(row, dict) or row.get('removed') is not False:
                raise DataError('invalid_deposit_receipt_logs')
            if bytes32(row.get('transactionHash')) != transaction_hash or bytes32(row.get('blockHash')) != block['hash'] or quantity(row.get('blockNumber')) != block['number'] or quantity(row.get('transactionIndex')) != transaction_index:
                raise DataError('deposit_receipt_log_mismatch')
            index = quantity(row.get('logIndex'))
            if index in seen or seen and index <= max(seen):
                raise DataError('deposit_receipt_log_mismatch')
            seen.add(index)
            topics = row.get('topics')
            if not isinstance(topics, list) or len(topics) > 4:
                raise DataError('invalid_deposit_receipt_logs')
            result.append({'address': address(row.get('address')), 'topics': [bytes32(x) for x in topics],
                           'data': '0x'+_data(row.get('data'), 8192).hex(), 'logIndex': index})
        return result

    def _nft_state(self, number, key, selection, block):
        raw_key, info = self._call(POSITION_MANAGER, 'getPoolAndPositionInfo(uint256)', ['uint256'], [number],
                                  ['(address,address,uint24,int24,address)', 'uint256'], block)
        if not info: raise _EvidenceMissing()
        observed_key = PoolKey.checked(raw_key, selection['poolId'])
        if observed_key != key or signed_tick(info >> 8) != selection['tickLower'] or signed_tick(info >> 32) != selection['tickUpper'] or info >> 56 != int(selection['poolId'],16) >> 56:
            raise DataError('deposit_receipt_nft_mismatch')
        owner, = self._call(POSITION_MANAGER, 'ownerOf(uint256)', ['uint256'], [number], ['address'], block)
        liquidity, = self._call(POSITION_MANAGER, 'getPositionLiquidity(uint256)', ['uint256'], [number], ['uint128'], block)
        owner = address(owner)
        if owner == ZERO: raise DataError('deposit_receipt_nft_mismatch')
        return {'status': 'verified', 'owner': owner, 'liquidityRaw': str(liquidity), 'snapshot': block}

    def _token_review(self, currency, artifact, block):
        """Historical endpoint evidence, never a transaction-time code trace.

        The callback is trusted operator policy, not a browser predicate. Its
        reads share this reconciliation's budget. Review/RPC failures remove
        amount trust without concealing a submitted transaction or its NFT.
        Matching proxy endpoints cannot exclude a transient same-block upgrade.
        """
        review = {'status': 'legacy_unqualified', 'reviewId': None, 'upgradeable': None}
        before = None
        if self._token_guard is not None:
            review['status'] = 'unavailable'
            try:
                if block['number'] == 0:
                    raise ValueError()
                before, _ = self._get_block(block['number']-1)
                if before['hash'] != self._receipt_parent_hash:
                    raise ValueError()
                observed = self._token_guard(request=self._rpc, currency=currency,
                    admission=deepcopy(artifact['admission']), before=deepcopy(before), block=deepcopy(block))
                if (type(observed) is not dict or set(observed) != {'status', 'reviewId', 'upgradeable'}
                        or observed['status'] not in ('matched', *UNQUALIFIED_AMOUNT_BASES)
                        or observed['reviewId'] is not None and not (
                            isinstance(observed['reviewId'], str) and re.fullmatch('[0-9a-f]{64}', observed['reviewId']))
                        or observed['upgradeable'] is not None and type(observed['upgradeable']) is not bool
                        or observed['status'] == 'matched' and (
                            observed['reviewId'] is None or type(observed['upgradeable']) is not bool)):
                    raise ValueError()
                if artifact['admission']['policyVersion'] == 'direct_existing_pool_v2':
                    expected = next(row['reviewId'] for row in artifact['admission']['tokenReviews']
                                    if row['address'] == currency)
                    if observed['status'] == 'matched' and observed['reviewId'] != expected:
                        raise ValueError()
                review = deepcopy(observed)
            except Exception:
                check_read_deadline()
                review = {'status': 'unavailable', 'reviewId': None, 'upgradeable': None}
        return {**review, 'beforeBlock': before, 'receiptBlock': deepcopy(block)}

    @staticmethod
    def _amount_basis(review):
        if review['status'] == 'matched':
            return 'reviewed_proxy_transfer_events' if review['upgradeable'] else 'admitted_standard_transfer_events'
        return UNQUALIFIED_AMOUNT_BASES[review['status']]

    def _mint(self, logs, owner, selection, artifact, key, block, head):
        transfers = [row for row in logs if row['address'] == POSITION_MANAGER and row['topics'] and row['topics'][0] == TRANSFER]
        if len(transfers) != 1: raise DataError('deposit_receipt_mint_event_mismatch')
        mint = transfers[0]
        if len(mint['topics']) != 4 or mint['data'] != '0x' or _topic_address(mint['topics'][1]) != ZERO or _topic_address(mint['topics'][2]) != owner:
            raise DataError('deposit_receipt_mint_event_mismatch')
        number = int(mint['topics'][3], 16)
        if number == 0: raise DataError('deposit_receipt_mint_event_mismatch')
        modifications = [row for row in logs if row['address'] == POOL_MANAGER and row['topics'] and row['topics'][0] == MODIFY]
        if len(modifications) != 1: raise DataError('deposit_receipt_modify_event_mismatch')
        modify = modifications[0]
        if len(modify['topics']) != 3 or modify['topics'][1] != selection['poolId'] or _topic_address(modify['topics'][2]) != POSITION_MANAGER:
            raise DataError('deposit_receipt_modify_event_mismatch')
        lower, upper, liquidity, salt = _abi(['int24','int24','int256','bytes32'], modify['data'])
        if lower != selection['tickLower'] or upper != selection['tickUpper'] or str(liquidity) != artifact['mintedBounds']['mintLiquidityRaw'] or int.from_bytes(salt, 'big') != number:
            raise DataError('deposit_receipt_modify_event_mismatch')
        try:
            at_receipt = self._nft_state(number, key, selection, block)
        except DataError as error:
            if str(error) == 'deposit_reconciliation_unavailable': raise _EvidenceMissing() from None
            raise
        if block == head:
            current = at_receipt
        else:
            try: current = self._nft_state(number, key, selection, head)
            except (_EvidenceMissing, DataError):
                current = {'status': 'unavailable', 'owner': None, 'liquidityRaw': None, 'snapshot': head}
        tokens = []
        for index, currency in enumerate((key.currency0, key.currency1)):
            cap = artifact['mintedBounds'][f'amount{index}MaxRaw']
            if currency == ZERO:
                tokens.append({'currency': currency, 'maximumDebitRaw': cap, 'depositedRaw': None,
                    'ownerDebitRaw': None, 'ownerCreditRaw': None, 'basis': 'native_net_unavailable'})
                continue
            review = self._token_review(currency, artifact, block)
            basis = self._amount_basis(review)
            if review['status'] != 'matched':
                tokens.append({'currency': currency, 'maximumDebitRaw': cap, 'depositedRaw': None,
                    'ownerDebitRaw': None, 'ownerCreditRaw': None, 'basis': basis, 'review': review})
                continue
            debit = credit = deposited = 0
            for row in logs:
                if row['address'] != currency or not row['topics'] or row['topics'][0] != TRANSFER: continue
                if len(row['topics']) != 3: raise DataError('deposit_receipt_token_event_mismatch')
                sender, recipient = _topic_address(row['topics'][1]), _topic_address(row['topics'][2])
                amount, = _abi(['uint256'], row['data'])
                if sender == owner:
                    debit += amount
                    if recipient != POOL_MANAGER: raise DataError('deposit_receipt_token_recipient_mismatch')
                    deposited += amount
                if recipient == owner: credit += amount
            if debit != deposited or credit or debit > _raw(cap): raise DataError('deposit_receipt_token_amount_mismatch')
            tokens.append({'currency': currency, 'maximumDebitRaw': cap, 'depositedRaw': str(deposited),
                'ownerDebitRaw': str(debit), 'ownerCreditRaw': str(credit), 'basis': basis, 'review': review})
        if key.currency0 != ZERO and all(token['depositedRaw'] is not None for token in tokens) and not any(_raw(token['depositedRaw']) for token in tokens):
            raise DataError('deposit_receipt_missing_token_transfers')
        return {'tokenId': str(number), 'poolId': selection['poolId'], 'poolKey': asdict(key),
            'tickLower': lower, 'tickUpper': upper, 'salt': '0x'+salt.hex(), 'mintRecipient': owner,
            'mintedLiquidityRaw': str(liquidity), 'receiptState': at_receipt, 'currentState': current,
            'tokens': tokens, 'native': {'sentRaw': artifact['transaction']['valueRaw'], 'depositRaw': None,
                'refundRaw': None, 'basis': 'transaction_value_only_net_unavailable'}}

    def _approval(self, logs, owner, artifact, approval, block):
        review = self._token_review(approval['token'], artifact, block)
        if review['status'] != 'matched':
            return {**approval, 'amountRaw': None, 'requestedAmountRaw': approval['amountRaw'],
                'basis': self._amount_basis(review), 'allowanceCurrentlyUsable': None,
                'snapshot': block, 'review': review}
        target = PERMIT2 if artifact['kind'] == 'permit2_approval' else approval['token']
        topic = PERMIT_APPROVAL if artifact['kind'] == 'permit2_approval' else APPROVAL
        events = [row for row in logs if row['address'] == target and row['topics'] and row['topics'][0] == topic]
        if len(events) != 1: raise DataError('deposit_receipt_approval_event_mismatch')
        event = events[0]
        if artifact['kind'] == 'permit2_approval':
            if len(event['topics']) != 4 or [_topic_address(x) for x in event['topics'][1:]] != [owner, approval['token'], approval['spender']]:
                raise DataError('deposit_receipt_approval_event_mismatch')
            amount, expiry = _abi(['uint160','uint48'], event['data'])
        else:
            if len(event['topics']) != 3 or [_topic_address(x) for x in event['topics'][1:]] != [owner, approval['spender']]:
                raise DataError('deposit_receipt_approval_event_mismatch')
            amount, = _abi(['uint256'], event['data']); expiry = None
        if str(amount) != approval['amountRaw'] or expiry != approval['expiration']:
            raise DataError('deposit_receipt_approval_event_mismatch')
        # Approval events prove this tx's effect. A later transfer in the same
        # block can consume it; the next preparation must read allowances again.
        return {**approval, 'basis': 'canonical_approval_event', 'allowanceCurrentlyUsable': None,
                'snapshot': block, 'review': review}

    def _scan(self, owner, nonce, source, cursor, head):
        next_block, offset, previous_hash, partial_hash = source['number'], 0, None, None
        canonical_source, _ = self._get_block(source['number'])
        source_hash = canonical_source['hash']
        reorg = source_hash != source['hash']

        def progress(number, offset=0, previous=None, partial=None):
            return {'nextBlock': number, 'nextTransactionIndex': offset,
                'previousBlockHash': previous, 'partialBlockHash': partial, 'sourceBlockHash': source_hash}

        if cursor is not None:
            if not isinstance(cursor, dict) or set(cursor) != {'nextBlock','nextTransactionIndex','previousBlockHash','partialBlockHash','sourceBlockHash'}:
                raise DataError('invalid_deposit_receipt_cursor')
            next_block, offset = _int(cursor['nextBlock']), _int(cursor['nextTransactionIndex'], MAX_BLOCK_TRANSACTIONS)
            if next_block < source['number']: raise DataError('invalid_deposit_receipt_cursor')
            previous_hash = None if cursor['previousBlockHash'] is None else bytes32(cursor['previousBlockHash'])
            partial_hash = None if cursor['partialBlockHash'] is None else bytes32(cursor['partialBlockHash'])
            if bool(offset) != (partial_hash is not None): raise DataError('invalid_deposit_receipt_cursor')
            if next_block > head['number']+1 or bytes32(cursor['sourceBlockHash']) != source_hash:
                next_block, offset, previous_hash, partial_hash, reorg = source['number'], 0, None, None, True
            elif next_block > source['number']:
                previous, _ = self._get_block(next_block-1)
                if previous['hash'] != previous_hash:
                    next_block, offset, previous_hash, partial_hash, reorg = source['number'], 0, None, None, True
            elif previous_hash is not None: raise DataError('invalid_deposit_receipt_cursor')
        scanned = 0
        for number in range(next_block, min(head['number']+1, next_block+self.max_blocks)):
            block, raw = self._get_block(number, True)
            if (previous_hash is not None and bytes32(raw.get('parentHash')) != previous_hash
                    or partial_hash is not None and block['hash'] != partial_hash):
                return None, progress(source['number']), False, True
            transactions = raw.get('transactions')
            if not isinstance(transactions, list) or len(transactions) > MAX_BLOCK_TRANSACTIONS or offset > len(transactions):
                raise DataError('deposit_receipt_scan_block_limit')
            end = min(len(transactions), offset+self.max_transactions-scanned)
            hashes = set()
            for index in range(offset, end):
                transaction = transactions[index]
                if not isinstance(transaction, dict): raise DataError('deposit_receipt_scan_transaction_invalid')
                transaction_hash = bytes32(transaction.get('hash'))
                if transaction_hash in hashes or bytes32(transaction.get('blockHash')) != block['hash'] or quantity(transaction.get('blockNumber')) != number or quantity(transaction.get('transactionIndex')) != index:
                    raise DataError('deposit_receipt_scan_transaction_invalid')
                hashes.add(transaction_hash)
                if address(transaction.get('from')) == owner and quantity(transaction.get('nonce')) == nonce:
                    if not self._canonical(block): return None, progress(source['number']), False, True
                    return transaction, progress(number, offset, previous_hash, partial_hash), False, reorg
            scanned += end-offset
            if not self._canonical(block): return None, progress(source['number']), False, True
            if end < len(transactions):
                return None, progress(number, end, previous_hash, block['hash']), False, reorg
            previous_hash, next_block, offset, partial_hash = block['hash'], number+1, 0, None
            if scanned >= self.max_transactions: break
        return None, progress(next_block, previous=previous_hash), next_block > head['number'], reorg

    def reconcile(self, owner, selection, artifact, known_hashes=(), previous_receipt=None,
                  scan_cursor=None, previous_conflicts=(), previous_resolved=(), on_observation=None):
        result = self._reconcile(owner, selection, artifact, known_hashes, previous_receipt,
                                 scan_cursor, previous_conflicts, previous_resolved, on_observation)
        if result['reportedEffectConflicts'] or result['unresolvedSubmissionHashes']:
            result['cancellation'] = False
            if result['state'] != 'reorged':
                result.update(state='mismatched', reason='reported_effect_nonce_mismatch'
                    if result['reportedEffectConflicts'] else 'reported_transaction_unresolved')
        return result

    def _reconcile(self, owner, selection, artifact, known_hashes, previous_receipt,
                   scan_cursor, previous_conflicts, previous_resolved, on_observation):
        """Return a strict persistable observation. No outcome authorizes retries."""
        self._count = 0
        owner, selection, artifact, key, approval = self._context(owner, selection, artifact)
        if not isinstance(known_hashes, (tuple, list)) or len(known_hashes) > MAX_HASHES:
            raise DataError('invalid_deposit_receipt_hashes')
        hashes = list(dict.fromkeys(bytes32(item) for item in known_hashes))
        reported = set(hashes)
        if not isinstance(previous_resolved, (tuple, list)) or len(previous_resolved) > MAX_HASHES:
            raise DataError('invalid_deposit_receipt_context')
        resolved = list(dict.fromkeys(bytes32(item) for item in previous_resolved))
        if not set(resolved) <= reported:
            raise DataError('invalid_deposit_receipt_context')
        if not isinstance(previous_conflicts, (tuple, list)) or len(previous_conflicts) > MAX_HASHES:
            raise DataError('invalid_deposit_receipt_context')
        conflicts = []
        for conflict in previous_conflicts:
            if (not isinstance(conflict, dict) or set(conflict) != {'transactionHash', 'nonceRaw'}
                    or _raw(conflict['nonceRaw']) >= 2**64-1
                    or conflict['nonceRaw'] == artifact['transaction']['nonceRaw']):
                raise DataError('invalid_deposit_receipt_context')
            item = {'transactionHash': bytes32(conflict['transactionHash']), 'nonceRaw': conflict['nonceRaw']}
            if any(value['transactionHash'] == item['transactionHash'] for value in conflicts):
                raise DataError('invalid_deposit_receipt_context')
            conflicts.append(item)
        if previous_receipt is not None:
            if not isinstance(previous_receipt, dict): raise DataError('invalid_deposit_previous_receipt')
            old_hash = bytes32(previous_receipt.get('transactionHash'))
            if old_hash not in hashes: hashes.append(old_hash)
        with read_deadline(15):
            if quantity(self._rpc('eth_chainId', [])) != CHAIN_ID: raise DataError('deposit_receipt_chain_mismatch')
            head, _ = self._get_block('latest')
            nonce = _raw(artifact['transaction']['nonceRaw'])
            nonce_consumed = quantity(self._rpc('eth_getTransactionCount', [owner, {'blockHash': head['hash'], 'requireCanonical': True}])) > nonce
            source_ahead = artifact['sourceBlock']['number'] > head['number']
            source_now = None if source_ahead else self._get_block(artifact['sourceBlock']['number'])[0]
            reorg = source_ahead or source_now['hash'] != artifact['sourceBlock']['hash']
            if previous_receipt is not None:
                number = _int(previous_receipt.get('blockNumber'))
                block_hash = bytes32(previous_receipt.get('blockHash'))
                current = None if number > head['number'] else self._get_block(number)[0]
                reorg = reorg or current is None or current['hash'] != block_hash
            result = {'state': 'not_found', 'reason': 'transaction_not_found', 'transactionHash': None,
                'nonceConsumed': nonce_consumed, 'nonceFinalized': False, 'replacement': False, 'differentEffect': False, 'cancellation': False,
                'reorgDetected': reorg, 'receipt': None, 'scanCursor': scan_cursor,
                'scanComplete': False, 'retryAllowed': False, 'reportedEffectConflicts': conflicts,
                'resolvedSubmissionHashes': resolved,
                'unresolvedSubmissionHashes': [item for item in hashes if item in reported and item not in resolved]}
            if source_ahead:
                result.update(state='reorged', reason='canonicality_changed', reorgDetected=True, scanCursor=None)
                return result
            candidate = None
            mismatched_hint = False
            for hinted in hashes:
                transaction = self._rpc('eth_getTransactionByHash', [hinted])
                if transaction is None: continue
                if not isinstance(transaction, dict) or bytes32(transaction.get('hash')) != hinted:
                    raise DataError('deposit_receipt_hash_mismatch')
                # Validate immutable identity before classifying a hint. Missing
                # or malformed metadata cannot prove that a second effect is absent.
                self._hint_identity(transaction)
                changed = False
                if (quantity(transaction.get('nonce')) != nonce
                        and self._same_call(transaction, owner, artifact['transaction'])):
                    conflict = {'transactionHash': hinted, 'nonceRaw': str(quantity(transaction['nonce']))}
                    if _raw(conflict['nonceRaw']) >= 2**64-1:
                        raise DataError('invalid_deposit_receipt_context')
                    existing = next((value for value in conflicts if value['transactionHash'] == hinted), None)
                    if existing is not None and existing != conflict:
                        raise DataError('deposit_receipt_hash_mismatch')
                    if existing is None:
                        if len(conflicts) >= MAX_HASHES:
                            raise DataError('deposit_receipt_request_budget')
                        conflicts.append(conflict)
                        changed = True
                if hinted in reported and hinted not in resolved:
                    resolved.append(hinted)
                    result['unresolvedSubmissionHashes'].remove(hinted)
                    changed = True
                if changed and on_observation is not None:
                    # Commit identity before any subsequent fallible RPC. If
                    # auth/deadline/DB prevents this write, the durable unknown
                    # hint still prevents release on a later missing lookup.
                    on_observation(list(resolved), list(conflicts))
                if address(transaction.get('from')) != owner or quantity(transaction.get('nonce')) != nonce:
                    mismatched_hint = True; continue
                if transaction.get('blockHash') is not None:
                    hinted_number = _int(quantity(transaction.get('blockNumber')))
                    hinted_block = None if hinted_number > head['number'] else self._get_block(hinted_number)[0]
                    if hinted_block is not None and hinted_block['hash'] != bytes32(transaction['blockHash']):
                        result['reorgDetected'] = True
                        continue
                # A mined owner/nonce candidate takes precedence over a stale
                # pending hash when a wallet has replaced the same transaction.
                if candidate is None or transaction.get('blockHash') is not None:
                    candidate = transaction
            if candidate is None or candidate.get('blockHash') is None:
                if nonce_consumed or candidate is None:
                    scanned, cursor, complete, changed = self._scan(owner, nonce, artifact['sourceBlock'], scan_cursor, head)
                    result.update(scanCursor=cursor, scanComplete=complete, reorgDetected=result['reorgDetected'] or changed)
                    if scanned is not None: candidate = scanned
            if candidate is None:
                if result['reorgDetected']: result.update(state='reorged', reason='canonicality_changed')
                elif nonce_consumed: result.update(state='pending', reason='nonce_consumed_transaction_unresolved')
                elif not result['scanComplete']: result.update(state='pending', reason='scan_in_progress')
                elif mismatched_hint: result.update(state='mismatched', reason='transaction_mismatch')
                return result
            transaction_hash = bytes32(candidate.get('hash'))
            if transaction_hash in reported and transaction_hash not in resolved:
                # A canonical block scan can supply identity even when the
                # provider's hash index temporarily omits this same transaction.
                self._hint_identity(candidate)
                resolved.append(transaction_hash)
                result['unresolvedSubmissionHashes'].remove(transaction_hash)
                if on_observation is not None:
                    on_observation(list(resolved), list(conflicts))
            result['transactionHash'] = transaction_hash
            observed = self._transaction(candidate, owner, artifact['transaction'])
            result['replacement'] = observed != artifact['transaction']
            result['differentEffect'] = self._different_effect(candidate, owner, artifact['transaction'])
            result['cancellation'] = self._cancellation(candidate, owner, artifact['transaction'])
            if candidate.get('blockHash') is None:
                result.update(state='pending' if observed is not None else 'mismatched',
                              reason='transaction_pending' if observed is not None else 'transaction_mismatch')
                return result
            number, block_hash = _int(quantity(candidate.get('blockNumber'))), bytes32(candidate['blockHash'])
            if number > head['number']:
                result.update(state='reorged' if result['reorgDetected'] else 'pending',
                    reason='canonicality_changed' if result['reorgDetected'] else 'receipt_pending')
                return result
            block, raw_block = self._get_block(number)
            if number < artifact['sourceBlock']['number']:
                result.update(state='mismatched', reason='transaction_mismatch')
                return result
            if block['hash'] != block_hash:
                result.update(state='reorged', reason='canonicality_changed', reorgDetected=True)
                return result
            transaction_index = quantity(candidate.get('transactionIndex'))
            listed = raw_block.get('transactions')
            if not isinstance(listed, list) or len(listed) > MAX_BLOCK_TRANSACTIONS or transaction_index >= len(listed) or listed[transaction_index] != transaction_hash:
                raise DataError('deposit_receipt_transaction_not_in_block')
            raw_receipt = self._rpc('eth_getTransactionReceipt', [transaction_hash])
            if raw_receipt is None:
                result.update(state='pending', reason='receipt_pending')
                return result
            receipt_target = None if isinstance(raw_receipt, dict) and raw_receipt.get('to') is None else address(raw_receipt.get('to')) if isinstance(raw_receipt, dict) else None
            candidate_target = None if candidate.get('to') is None else address(candidate.get('to'))
            if not isinstance(raw_receipt, dict) or bytes32(raw_receipt.get('transactionHash')) != transaction_hash or bytes32(raw_receipt.get('blockHash')) != block_hash or quantity(raw_receipt.get('blockNumber')) != number or quantity(raw_receipt.get('transactionIndex')) != transaction_index or address(raw_receipt.get('from')) != owner or receipt_target != candidate_target:
                result.update(state='mismatched', reason='receipt_mismatch')
                return result
            status = quantity(raw_receipt.get('status'))
            if status not in (0, 1): raise DataError('invalid_deposit_receipt_status')
            gas_used, price = quantity(raw_receipt.get('gasUsed')), quantity(raw_receipt.get('effectiveGasPrice'))
            if gas_used > quantity(candidate.get('gas')) or gas_used < 21000 or observed is not None and price > _raw(observed['maxFeePerGasRaw']):
                raise DataError('invalid_deposit_receipt_gas')
            gross_fee = gas_used * price
            try:
                l1_gas = quantity(raw_receipt['gasUsedForL1']) if 'gasUsedForL1' in raw_receipt else None
            except DataError:
                raise DataError('invalid_deposit_receipt_gas') from None
            if gross_fee >= 2**256 or l1_gas is not None and l1_gas > gas_used:
                raise DataError('invalid_deposit_receipt_gas')
            # Nitro's poster charge is included in gasUsed, not added to it.
            # Additional ArbOS resource refunds are not resolved by this receipt.
            l1_fee = None if l1_gas is None else l1_gas * price
            logs = self._logs(raw_receipt, transaction_hash, block, transaction_index)
            if status == 0 and logs: raise DataError('invalid_deposit_reverted_logs')
            finality, finalized = 'unavailable', None
            try:
                finalized, _ = self._get_block('finalized')
                if finalized['number'] > head['number'] or not self._canonical(finalized):
                    raise DataError('deposit_receipt_finality_mismatch')
                finality = 'finalized' if finalized['number'] >= number else 'pending'
                if finality == 'finalized' and quantity(self._rpc('eth_getTransactionCount',
                        [owner, {'blockHash': finalized['hash'], 'requireCanonical': True}])) <= nonce:
                    raise DataError('deposit_receipt_finalized_nonce_mismatch')
            except DataError as error:
                if str(error) not in ('deposit_reconciliation_unavailable', 'deposit_receipt_block_unavailable'):
                    raise
                finalized = None
            receipt = {'transactionHash': transaction_hash, 'blockNumber': number, 'blockHash': block_hash,
                'transactionIndex': transaction_index, 'status': 'success' if status else 'reverted', 'canonical': True,
                'gas': {'gasUsedRaw': str(gas_used), 'effectiveGasPriceRaw': str(price), 'grossGasFeeRaw': str(gross_fee),
                    'l1GasUsedRaw': None if l1_gas is None else str(l1_gas),
                    'l1FeeRaw': None if l1_fee is None else str(l1_fee),
                    'totalFeeRaw': None, 'totalFeeStatus': 'net_fee_unavailable'},
                'finality': {'status': finality, 'basis': 'rpc_finalized_tag', 'observedHead': head,
                    'finalizedHead': finalized, 'confirmations': head['number']-number+1, 'absoluteFinalityProven': False},
                'mint': None, 'approval': None,
                'transaction': self._transaction_evidence(observed, selection)}
            self._receipt_parent_hash = raw_block.get('parentHash')
            state_missing = False
            approval_review = None
            if observed is not None and status:
                try:
                    if artifact['kind'] == 'mint': receipt['mint'] = self._mint(logs, owner, selection, artifact, key, block, head)
                    else:
                        receipt['approval'] = self._approval(logs, owner, artifact, approval, block)
                        approval_review = receipt['approval']['review']['status']
                except _EvidenceMissing: state_missing = True
                except DataError:
                    result.update(state='mismatched', reason='receipt_mismatch', receipt=receipt,
                                  nonceConsumed=True, nonceFinalized=finality == 'finalized')
                    if not self._canonical(block) or not self._canonical(head) or finalized is not None and not self._canonical(finalized):
                        result.update(state='reorged', reason='canonicality_changed', reorgDetected=True, receipt=None, nonceFinalized=False)
                    return result
            if result['cancellation']:
                # Empty calldata alone does not prove an inert self-transfer:
                # delegated code could execute. Only intrinsic gas, no logs and
                # empty code at the canonical receipt snapshot admit release.
                result['cancellation'] = gas_used == 21000 and not logs
                if result['cancellation']:
                    try:
                        result['cancellation'] = self._rpc('eth_getCode', [owner, {'blockHash': block_hash, 'requireCanonical': True}]) == '0x'
                    except DataError:
                        result['cancellation'] = False
            if not self._canonical(block) or not self._canonical(head) or finalized is not None and not self._canonical(finalized):
                result.update(state='reorged', reason='canonicality_changed', reorgDetected=True, receipt=None)
                return result
            result.update(receipt=receipt, nonceConsumed=True, nonceFinalized=finality == 'finalized')
            if conflicts: result.update(state='mismatched', reason='reported_effect_nonce_mismatch')
            elif observed is None: result.update(state='mismatched', reason='transaction_mismatch')
            elif state_missing: result.update(state='pending', reason='mint_state_unavailable')
            elif approval_review in ('changed', 'legacy_unqualified'):
                result.update(state='mismatched', reason='token_review_changed' if approval_review == 'changed' else 'token_review_unavailable')
            elif approval_review == 'unavailable':
                result.update(state='pending', reason='token_review_unavailable')
            elif finality != 'finalized': result.update(state='pending', reason='finality_' + finality)
            elif status: result.update(state='confirmed', reason='transaction_confirmed')
            else: result.update(state='reverted', reason='transaction_reverted')
            return result


def validate_issued_artifact(owner, selection, artifact):
    """Recheck persisted transaction effects and selected caps without RPC/writes."""
    return ReceiptReconciler._context(owner, selection, artifact)[2]


def _public_token_amount(token, receipt):
    """Old amount labels alone do not establish the newly required identity.

    Keep historical raw records intact; project amounts only with their bound
    review evidence. A later implementation upgrade does not change an already
    recorded canonical historical identity.
    """
    basis = token.get('basis')
    if token.get('currency') == ZERO:
        return None, 'native_net_unavailable'
    if basis in UNQUALIFIED_AMOUNT_BASES.values():
        return None, basis
    review = token.get('review')
    try:
        if (basis not in QUALIFIED_AMOUNT_BASES or type(review) is not dict
                or review['status'] != 'matched' or type(review['upgradeable']) is not bool
                or basis != ('reviewed_proxy_transfer_events' if review['upgradeable'] else 'admitted_standard_transfer_events')
                or not re.fullmatch('[0-9a-f]{64}', review['reviewId'])
                or review['receiptBlock']['number'] != receipt['blockNumber']
                or review['receiptBlock']['hash'] != receipt['blockHash']
                or review['beforeBlock']['number'] != receipt['blockNumber']-1):
            raise ValueError()
        _raw(token['depositedRaw'])
        return token['depositedRaw'], basis
    except (KeyError, TypeError, ValueError, DataError):
        return None, 'legacy_token_review_unqualified'


def receipt_summary(outcome):
    """Project observed evidence into the closed public model; no scan internals."""
    from deposit_models import ReceiptSummary
    receipt = outcome.get('receipt')
    if receipt is None:
        return None
    mint = receipt['mint']
    position = None if mint is None else {
        'tokenId': mint['tokenId'], 'recipient': mint['mintRecipient'], 'poolId': mint['poolId'],
        'tickLower': mint['tickLower'], 'tickUpper': mint['tickUpper'], 'liquidityRaw': mint['mintedLiquidityRaw'],
        'currentOwner': mint['currentState']['owner'], 'currentOwnerStatus': mint['currentState']['status'],
        'ownershipObservedBlock': mint['currentState']['snapshot'],
    }
    if position is not None:
        for index, token in enumerate(mint['tokens']):
            position[f'amount{index}Raw'], position[f'amount{index}Basis'] = _public_token_amount(token, receipt)
    gas = receipt['gas']
    gas_used, price = _raw(gas['gasUsedRaw']), _raw(gas['effectiveGasPriceRaw'])
    # Old records have no qualified poster-gas observation. Recompute from raw
    # operands; never reinterpret their executionFeeRaw/l1FeeRaw/totalFeeRaw.
    l1_gas = None if gas.get('l1GasUsedRaw') is None else _raw(gas['l1GasUsedRaw'])
    body = {'transactionHash': receipt['transactionHash'], 'blockNumber': receipt['blockNumber'],
        'blockHash': receipt['blockHash'], 'outcome': receipt['status'],
        'finality': {'pending':'provisional','finalized':'finalized','unavailable':'unavailable'}[receipt['finality']['status']],
        'gasUsedRaw': str(gas_used), 'effectiveGasPriceRaw': str(price), 'grossGasFeeRaw': str(gas_used * price),
        'l1GasUsedRaw': None if l1_gas is None else str(l1_gas),
        'l1FeeRaw': None if l1_gas is None else str(l1_gas * price), 'totalFeeRaw': None,
        'position': position, 'transaction': receipt.get('transaction')}
    return ReceiptSummary.model_validate(body).model_dump()
