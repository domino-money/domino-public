"""Bounded canonical E2 acquisition, not a financial/valuation adapter.

Only a trusted collector chooses owner, vault and reviewed runtime hash. These
records are internal evidence, not browser input or proof supplied by a wallet.
Finalized end-of-block baselines include existing assets as opening capital.
Raw logs NEVER establish trading income, service charges or price qualification.
The provider's finalized tag is an explicit trust boundary, not a consensus proof.
"""
import json
import re
from types import SimpleNamespace
from typing import Annotated, Literal

from eth_abi import encode
from eth_hash.auto import keccak
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictInt, model_validator

from discovery import (Block, DataError, ReadRpc, POSITION_MANAGER, POOL_MANAGER,
                       STATE_VIEW, ZERO, address, bytes32, quantity, decode_result)
from nft_ownership import read_nft_position
from rpc_config import DEFAULT_RPC_HOSTS, rpc_endpoint

MAX_MEMBERS = 64
MAX_TRANSACTIONS = 256
MAX_BLOCK_TRANSACTIONS = 4096
MAX_LOGS = 4096
MAX_PAGE_BYTES = 4_000_000
MAX_RECEIPT_BYTES = 262_144
TRANSFER = '0x' + keccak(b'Transfer(address,address,uint256)').hex()
POSITION_TYPE = '(bool,bool,bool,uint256,uint64,int24,int24,bytes32,bytes32,bytes32,bytes32)'
CHECKPOINT_TYPE = '(uint128,uint256,uint256,uint256,uint256,uint64,bytes32)'
Hash = Annotated[str, Field(pattern=r'^0x[0-9a-f]{64}$', min_length=66, max_length=66)]
Address = Annotated[str, Field(pattern=r'^0x[0-9a-f]{40}$', min_length=42, max_length=42)]
Number = Annotated[StrictInt, Field(ge=0, le=2**53-1)]


def _uint256(value):
    if not re.fullmatch(r'0|[1-9][0-9]{0,77}', value) or int(value) >= 2**256:
        raise ValueError('invalid_uint256')
    return value


def _positive(value):
    if int(value) == 0: raise ValueError('invalid_positive_uint256')
    return value


def _hex_data(value):
    if not re.fullmatch(r'0x(?:[0-9a-f]{2})*', value):
        raise ValueError('invalid_hex_data')
    return value


Raw = Annotated[str, Field(min_length=1, max_length=78), AfterValidator(_uint256)]
TokenId = Annotated[Raw, AfterValidator(_positive)]
HexData = Annotated[str, Field(min_length=2, max_length=131074), AfterValidator(_hex_data)]


class CollectionError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class ReorgDetected(CollectionError):
    def __init__(self, code, observed_baseline=None):
        self.observed_baseline = observed_baseline
        super().__init__(code)


def _bounded(value, limit=MAX_PAGE_BYTES):
    def walk(v, depth=0):
        if depth > 14:
            raise CollectionError('collection_payload_budget')
        if isinstance(v, dict):
            if len(v) > 256 or any(type(k) is not str or len(k) > 128 for k in v):
                raise CollectionError('collection_payload_budget')
            for child in v.values(): walk(child, depth+1)
        elif isinstance(v, list):
            if len(v) > MAX_LOGS: raise CollectionError('collection_payload_budget')
            for child in v: walk(child, depth+1)
        elif v is not None and type(v) not in (str, int, bool):
            raise CollectionError('invalid_collection_json')
    walk(value)
    if _json_size(value) > limit:
        raise CollectionError('collection_payload_budget')
    return value


def _json_size(value):
    try:
        return len(json.dumps(value, allow_nan=False, separators=(',', ':')).encode())
    except (TypeError, ValueError, RecursionError):
        raise CollectionError('invalid_collection_json') from None


class Record(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Cursor(Record):
    blockNumber: Number
    blockHash: Hash
    parentHash: Hash
    timestamp: Number


class CodePin(Record):
    address: Address
    codeHash: Hash


class MemberOpening(Record):
    tokenId: TokenId
    holder: Address
    isRoot: bool
    parentTokenId: Raw
    generation: Annotated[StrictInt, Field(ge=1, le=2**53-1)]
    tickLower: Annotated[StrictInt, Field(ge=-887272, le=887272)]
    tickUpper: Annotated[StrictInt, Field(ge=-887272, le=887272)]
    identity: Hash
    registrationBaselineId: Hash
    source0: Hash
    source1: Hash
    liquidityRaw: Raw
    principalRaw: Annotated[list[Raw], Field(min_length=2, max_length=2)]
    unsettledFeesRaw: Annotated[list[Raw], Field(min_length=2, max_length=2)]
    registrationCheckpoint: Annotated[list[Raw | Hash], Field(min_length=7, max_length=7)]
    checkpoint: Annotated[list[Raw | Hash], Field(min_length=7, max_length=7)]

    @model_validator(mode='after')
    def coherent(self):
        if self.tickLower >= self.tickUpper:
            raise ValueError('invalid_member_range')
        for checkpoint in (self.registrationCheckpoint, self.checkpoint):
            for value in checkpoint[:6]: _uint256(value)
            if (not re.fullmatch(r'0x[0-9a-f]{64}', checkpoint[6]) or
                    int(checkpoint[0]) >= 2**128 or int(checkpoint[5]) >= 2**64):
                raise ValueError('invalid_member_checkpoint')
        return self


class Opening(Record):
    sequenceIdentity: Hash
    poolManager: Address
    stateView: Address
    factory: Address
    implementation: Address
    implementationVersion: Annotated[StrictInt, Field(ge=1, le=3)]
    poolId: Hash
    currencies: Annotated[list[Address], Field(min_length=2, max_length=2)]
    members: Annotated[list[MemberOpening], Field(min_length=1, max_length=MAX_MEMBERS)]
    codePins: Annotated[list[CodePin], Field(min_length=6, max_length=8)]
    heldRaw: Annotated[list[Raw], Field(min_length=2, max_length=2)]
    accountedRaw: Annotated[list[Raw], Field(min_length=2, max_length=2)]
    nativeHeldRaw: Raw


def epoch_id(owner, vault, block_hash):
    return '0x' + keccak(encode(['string', 'uint256', 'address', 'address', 'bytes32'],
        ['DominoPerformanceEpochV1', 4663, owner, vault, bytes.fromhex(block_hash[2:])])).hex()


class Baseline(Record):
    chainId: Literal[4663]
    epochId: Hash
    owner: Address
    vault: Address
    positionManager: Address
    rootTokenId: TokenId
    tokenIds: Annotated[list[TokenId], Field(min_length=1, max_length=MAX_MEMBERS)]
    baseline: Cursor
    vaultCodeHash: Hash
    opening: Opening

    @model_validator(mode='after')
    def coherent(self):
        if type(self.chainId) is not int or self.epochId != epoch_id(self.owner, self.vault, self.baseline.blockHash):
            raise ValueError('invalid_epoch_identity')
        if self.tokenIds != sorted(set(self.tokenIds), key=int) or self.rootTokenId not in self.tokenIds:
            raise ValueError('invalid_baseline_members')
        if [m.tokenId for m in self.opening.members] != self.tokenIds:
            raise ValueError('invalid_baseline_members')
        for member in self.opening.members:
            if member.isRoot != (member.tokenId == self.rootTokenId) or member.holder != (
                    self.owner if member.isRoot else self.vault):
                raise ValueError('invalid_baseline_holder')
        if len({p.address for p in self.opening.codePins}) != len(self.opening.codePins):
            raise ValueError('duplicate_code_pin')
        if not any(p.address == self.vault and p.codeHash == self.vaultCodeHash for p in self.opening.codePins):
            raise ValueError('missing_vault_pin')
        return self


class CanonicalLog(Record):
    address: Address
    topics: Annotated[list[Hash], Field(max_length=4)]
    data: HexData
    blockNumber: Number
    blockHash: Hash
    transactionHash: Hash
    transactionIndex: Number
    logIndex: Number
    receiptLogIndex: Number


class Receipt(Record):
    transactionHash: Hash
    blockNumber: Number
    blockHash: Hash
    transactionIndex: Number
    fromAddress: Address
    toAddress: Address | None
    status: Literal[0, 1]
    gasUsed: Raw
    effectiveGasPrice: Raw
    logs: Annotated[list[CanonicalLog], Field(max_length=MAX_LOGS)]
    rawReceipt: dict
    rawTransaction: dict


def event_id(tx_hash, ordinal):
    return '0x' + keccak(encode(['string', 'uint256', 'bytes32', 'uint256'],
        ['DominoPerformanceLogV1', 4663, bytes.fromhex(tx_hash[2:]), ordinal])).hex()


class EventLocator(Record):
    eventId: Hash
    transactionHash: Hash
    receiptLogIndex: Number
    blockNumber: Number
    blockHash: Hash
    transactionIndex: Number
    logIndex: Number
    address: Address
    kind: Literal['vault', 'position_transfer', 'currency_transfer']


class Page(Record):
    epochId: Hash
    owner: Address
    vault: Address
    fromCursor: Cursor
    throughCursor: Cursor
    headers: Annotated[list[Cursor], Field(min_length=1, max_length=16)]
    receipts: Annotated[list[Receipt], Field(max_length=MAX_TRANSACTIONS)]
    events: Annotated[list[EventLocator], Field(max_length=MAX_LOGS)]

    @model_validator(mode='after')
    def coherent(self):
        previous = self.fromCursor
        headers = {}
        for header in self.headers:
            if (header.blockNumber != previous.blockNumber+1 or header.parentHash != previous.blockHash
                    or header.timestamp < previous.timestamp):
                raise ValueError('noncontiguous_page')
            headers[header.blockNumber] = header
            previous = header
        if previous != self.throughCursor:
            raise ValueError('invalid_page_cursor')
        records = {}
        order = []
        for receipt in self.receipts:
            if receipt.transactionHash in records or receipt.blockNumber not in headers:
                raise ValueError('invalid_page_receipt')
            if receipt.blockHash != headers[receipt.blockNumber].blockHash:
                raise ValueError('invalid_page_receipt')
            records[receipt.transactionHash] = receipt
            order.append((receipt.blockNumber, receipt.transactionIndex))
            for i, log in enumerate(receipt.logs):
                if (log.receiptLogIndex != i or log.transactionHash != receipt.transactionHash or
                        log.blockHash != receipt.blockHash or log.blockNumber != receipt.blockNumber or
                        log.transactionIndex != receipt.transactionIndex):
                    raise ValueError('invalid_receipt_log')
            if receipt.status == 0 and receipt.logs:
                raise ValueError('reverted_receipt_has_logs')
        if order != sorted(set(order)):
            raise ValueError('invalid_receipt_order')
        event_order, seen = [], set()
        for event in self.events:
            receipt = records.get(event.transactionHash)
            if receipt is None or event.receiptLogIndex >= len(receipt.logs):
                raise ValueError('missing_event_receipt')
            log = receipt.logs[event.receiptLogIndex]
            if event.eventId != event_id(event.transactionHash, event.receiptLogIndex) or event.eventId in seen:
                raise ValueError('invalid_event_identity')
            for key in ('blockNumber', 'blockHash', 'transactionIndex', 'logIndex', 'address'):
                if getattr(event, key) != getattr(log, key): raise ValueError('event_receipt_mismatch')
            seen.add(event.eventId)
            event_order.append((event.blockNumber, event.transactionIndex, event.receiptLogIndex))
        if event_order != sorted(set(event_order)):
            raise ValueError('invalid_event_order')
        _bounded(self.model_dump())
        return self


class PerformanceRpc(ReadRpc):
    """Explicit operator-configured read transport; no estimate/send/sign methods."""
    METHODS = frozenset({'eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance', 'eth_call',
        'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt'})

    def __init__(self, url, *, allowed_hosts=DEFAULT_RPC_HOSTS, **kwargs):
        super().__init__(rpc_endpoint(url, allowed_hosts), **kwargs)


def _model(kind, value):
    return kind.model_validate(value.model_dump() if isinstance(value, kind) else value)


class CanonicalCollector:
    def __init__(self, rpc, *, page_blocks=4, max_requests=1024):
        if type(page_blocks) is not int or not 1 <= page_blocks <= 16:
            raise CollectionError('invalid_collection_page_size')
        if type(max_requests) is not int or not 1 <= max_requests <= 2048:
            raise CollectionError('invalid_collection_rpc_budget')
        self.rpc, self.page_blocks, self.max_requests = rpc, page_blocks, max_requests
        self.count = 0

    def request(self, method, params=()):
        if method not in PerformanceRpc.METHODS:
            raise CollectionError('collection_method_not_read_only')
        if self.count >= self.max_requests:
            raise CollectionError('collection_rpc_budget')
        self.count += 1
        try:
            result = self.rpc.request(method, list(params))
        except Exception:
            raise CollectionError('collection_rpc_unavailable') from None
        return _bounded(result, 2_000_000)

    def call(self, target, signature, inputs=(), values=(), outputs=(), *, block):
        data = '0x' + (keccak(signature.encode())[:4] + encode(inputs, values)).hex()
        return decode_result(outputs, self.request('eth_call', [
            {'to': address(target), 'data': data, 'gas': '0x7a120'}, block]))

    def _get(self, target, signature, output, block, inputs=(), values=()):
        return self.call(target, signature, inputs, values, [output], block=self._tag(block))[0]

    @staticmethod
    def _tag(block):
        return {'blockHash': block.blockHash, 'requireCanonical': True}

    def _header(self, tag):
        raw = self.request('eth_getBlockByNumber', [tag, False])
        if not isinstance(raw, dict): raise CollectionError('collection_block_unavailable')
        header = Cursor(blockNumber=quantity(raw.get('number')), blockHash=bytes32(raw.get('hash')),
            parentHash=bytes32(raw.get('parentHash')), timestamp=quantity(raw.get('timestamp')))
        txs = raw.get('transactions')
        if not isinstance(txs, list) or len(txs) > MAX_BLOCK_TRANSACTIONS:
            raise CollectionError('collection_block_budget')
        txs = [bytes32(tx) for tx in txs]
        if len(set(txs)) != len(txs): raise CollectionError('duplicate_block_transaction')
        return header, txs

    def _chain(self):
        if quantity(self.request('eth_chainId')) != 4663:
            raise CollectionError('collection_wrong_chain')

    def _code(self, target, block):
        raw = self.request('eth_getCode', [target, self._tag(block)])
        if type(raw) is not str or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2}){1,49152}', raw):
            raise CollectionError('collection_code_unavailable')
        return '0x' + keccak(bytes.fromhex(raw[2:])).hex()

    def _recheck(self, expected, *, baseline=None):
        observed, _ = self._header(hex(expected.blockNumber))
        if observed != expected:
            raise ReorgDetected('collection_header_reorganized', observed if baseline else None)
        return observed

    def capture(self, owner, vault, token_ids, expected_vault_code_hash):
        self.count = 0
        try:
            return self._capture(address(owner), address(vault), token_ids, bytes32(expected_vault_code_hash))
        except CollectionError: raise
        except Exception:
            raise CollectionError('invalid_collection_baseline') from None

    def _capture(self, owner, vault, token_ids, expected_hash):
        self._chain()
        if owner == ZERO or vault == ZERO or type(token_ids) is not list or not 1 <= len(token_ids) <= MAX_MEMBERS:
            raise CollectionError('invalid_collection_subject')
        ids = [str(int(value)) for value in token_ids if type(value) is str and re.fullmatch(r'(0|[1-9][0-9]{0,77})', value)]
        if len(ids) != len(token_ids) or len(set(ids)) != len(ids) or any(not 0 < int(i) < 2**256 for i in ids):
            raise CollectionError('invalid_collection_members')
        ids.sort(key=int)
        block, _ = self._header('finalized')
        if self._code(vault, block) != expected_hash: raise CollectionError('unadmitted_vault_runtime')
        get = lambda signature, output: self._get(vault, signature, output, block)
        if address(get('owner()', 'address')) != owner: raise CollectionError('collection_owner_mismatch')
        pm = address(get('positionManager()', 'address'))
        pool_manager, state_view = address(get('poolManager()', 'address')), address(get('stateView()', 'address'))
        if (pm, pool_manager, state_view) != (POSITION_MANAGER, POOL_MANAGER, STATE_VIEW):
            raise CollectionError('collection_manager_adapter_required')
        root = str(get('rootTokenId()', 'uint256'))
        if root not in ids or get('activePositions()', 'uint256') != len(ids):
            raise CollectionError('incomplete_collection_members')
        version = get('implementationVersion()', 'uint64')
        if version not in (1, 2, 3): raise CollectionError('collection_vault_version_unsupported')
        implementation, factory = address(get('implementation()', 'address')), address(get('factory()', 'address'))
        sequence = '0x' + get('sequenceIdentityHash()', 'bytes32').hex()
        pool_id = '0x' + get('poolId()', 'bytes32').hex()
        raw_key = get('poolKey()', '(address,address,uint24,int24,address)')
        currencies = [address(raw_key[0]), address(raw_key[1])]
        if currencies[0] >= currencies[1] or raw_key[4] != ZERO:
            raise CollectionError('invalid_collection_pair')
        targets = [vault, implementation, factory, pm, pool_manager, state_view]
        if version >= 2: targets.append(address(get('readHelper()', 'address')))
        if version == 3: targets.append(address(get('compoundEngine()', 'address')))
        pins = [CodePin(address=a, codeHash=self._code(a, block)) for a in targets]
        members = []
        for token_id in ids:
            number = int(token_id)
            member = self._get(vault, 'position(uint256)', POSITION_TYPE, block, ['uint256'], [number])
            if not member[0] or not member[1] or member[2] != (token_id == root):
                raise CollectionError('invalid_collection_member')
            nft = read_nft_position(self, token_id, SimpleNamespace(tag=self._tag(block)))
            if (not nft.get('nftOwnershipResolved') or nft['owner'] != (owner if member[2] else vault)
                    or nft['poolId'] != pool_id or (nft['tickLower'], nft['tickUpper']) != (member[5], member[6])):
                raise CollectionError('collection_nft_binding_mismatch')
            checkpoints = []
            for signature in ('registrationCheckpoint(uint256)', 'checkpoint(uint256)'):
                cp = self._get(vault, signature, CHECKPOINT_TYPE, block, ['uint256'], [number])
                checkpoints.append([str(v) for v in cp[:6]] + ['0x' + cp[6].hex()])
            members.append(MemberOpening(tokenId=token_id, holder=nft['owner'], isRoot=member[2],
                parentTokenId=str(member[3]), generation=member[4], tickLower=member[5], tickUpper=member[6],
                registrationBaselineId='0x'+member[7].hex(), identity='0x'+member[8].hex(),
                source0='0x'+member[9].hex(), source1='0x'+member[10].hex(), liquidityRaw=nft['liquidityRaw'],
                principalRaw=nft['principalRaw'], unsettledFeesRaw=nft['unsettledFeesRaw'],
                registrationCheckpoint=checkpoints[0], checkpoint=checkpoints[1]))
        held, accounted = [], []
        native = str(quantity(self.request('eth_getBalance', [vault, self._tag(block)])))
        for currency in currencies:
            held.append(native if currency == ZERO else str(self._get(currency, 'balanceOf(address)', 'uint256', block, ['address'], [vault])))
            accounted.append(str(self._get(vault, 'accountedCurrency(address)', 'uint256', block, ['address'], [currency])))
            if int(accounted[-1]) > int(held[-1]): raise CollectionError('unbacked_collection_opening')
        self._recheck(block, baseline=True)
        final_check, _ = self._header('finalized')
        if (final_check.blockNumber < block.blockNumber or
                (final_check.blockNumber == block.blockNumber and final_check != block)):
            raise ReorgDetected('collection_finality_regressed')
        self._chain()
        return Baseline(chainId=4663, epochId=epoch_id(owner, vault, block.blockHash), owner=owner, vault=vault,
            positionManager=pm, rootTokenId=root, tokenIds=ids, baseline=block, vaultCodeHash=expected_hash,
            opening=Opening(sequenceIdentity=sequence, poolManager=pool_manager, stateView=state_view, factory=factory,
                implementation=implementation, implementationVersion=version, poolId=pool_id, currencies=currencies,
                members=members, codePins=pins, heldRaw=held, accountedRaw=accounted, nativeHeldRaw=native))

    @staticmethod
    def _log(raw, ordinal):
        if not isinstance(raw, dict) or raw.get('removed') is not False:
            raise CollectionError('invalid_or_removed_collection_log')
        return CanonicalLog(address=address(raw.get('address')), topics=[bytes32(t) for t in raw.get('topics', [])],
            data=raw.get('data', '').lower(), blockNumber=quantity(raw.get('blockNumber')),
            blockHash=bytes32(raw.get('blockHash')), transactionHash=bytes32(raw.get('transactionHash')),
            transactionIndex=quantity(raw.get('transactionIndex')), logIndex=quantity(raw.get('logIndex')),
            receiptLogIndex=ordinal)

    @staticmethod
    def _kind(log, baseline):
        if log.address == baseline.vault: return 'vault'
        if not log.topics or log.topics[0] != TRANSFER: return None
        vault_topic = '0x' + baseline.vault[2:].rjust(64, '0')
        if log.address == baseline.positionManager:
            if len(log.topics) != 4 or log.data != '0x': raise CollectionError('malformed_position_transfer')
            if any(topic[2:26] != '0'*24 for topic in log.topics[1:3]):
                raise CollectionError('malformed_position_transfer')
            if (str(int(log.topics[3], 16)) in baseline.tokenIds or vault_topic in log.topics[1:3]):
                return 'position_transfer'
        elif log.address in baseline.opening.currencies and log.address != ZERO:
            if len(log.topics) != 3 or len(log.data) != 66: raise CollectionError('malformed_currency_transfer')
            if any(topic[2:26] != '0'*24 for topic in log.topics[1:3]):
                raise CollectionError('malformed_currency_transfer')
            if vault_topic in log.topics[1:3]: return 'currency_transfer'
        return None

    def collect(self, baseline, cursor):
        self.count = 0
        try:
            baseline = _model(Baseline, baseline)
            return self._collect(baseline, _model(Cursor, cursor))
        except ReorgDetected as error:
            # A cursor or later page block may reorganize while the opening
            # block remains canonical. Re-read that block now; do not attach
            # the stored baseline as if it were a fresh observation. Failed
            # confirmation is a read failure, leaving durable state intact.
            try:
                observed, _ = self._header(hex(baseline.baseline.blockNumber))
                if observed.blockNumber != baseline.baseline.blockNumber:
                    raise CollectionError('collection_baseline_confirmation_failed')
            except CollectionError:
                raise
            except Exception:
                raise CollectionError('collection_baseline_confirmation_failed') from None
            raise ReorgDetected(error.code, observed) from None
        except CollectionError: raise
        except Exception:
            raise CollectionError('invalid_collection_page') from None

    def _collect(self, baseline, cursor):
        self._chain()
        self._recheck(baseline.baseline, baseline=True)
        if cursor.blockNumber < baseline.baseline.blockNumber:
            raise CollectionError('collection_cursor_before_baseline')
        self._recheck(cursor)
        finalized, _ = self._header('finalized')
        if finalized.blockNumber < cursor.blockNumber:
            raise ReorgDetected('collection_finality_regressed', baseline.baseline)
        if finalized.blockNumber == cursor.blockNumber:
            if finalized != cursor: raise ReorgDetected('collection_finalized_cursor_changed', baseline.baseline)
            return None
        stop = min(finalized.blockNumber, cursor.blockNumber+self.page_blocks)
        headers, transactions, header_bytes = [], {}, 0
        previous = cursor
        for number in range(cursor.blockNumber+1, stop+1):
            header, txs = self._header(hex(number))
            if header.blockNumber != number or header.parentHash != previous.blockHash or header.timestamp < previous.timestamp:
                raise ReorgDetected('collection_noncontiguous_headers', baseline.baseline)
            header_bytes += _json_size(header.model_dump()) + _json_size(txs)
            if header_bytes > MAX_PAGE_BYTES: raise CollectionError('collection_page_budget')
            headers.append(header); previous = header
            transactions[number] = txs
        # Discover only the managed subjects. Complete receipts cross-check every
        # relevant log inside each discovered transaction. A provider omitting an
        # ENTIRE transaction is not detected here: income coverage stays unknown.
        # Reverted/no-log actions require future #89 receipt hints, not polling
        # unrelated transactions. This is not full-chain receipt qualification.
        subject = '0x' + baseline.vault[2:].rjust(64, '0')
        pair = [c for c in baseline.opening.currencies if c != ZERO]
        filters = [{'address': baseline.vault},
            {'address': baseline.positionManager, 'topics': [TRANSFER, None, None,
                ['0x'+int(i).to_bytes(32, 'big').hex() for i in baseline.tokenIds]]},
            {'address': baseline.positionManager, 'topics': [TRANSFER, subject]},
            {'address': baseline.positionManager, 'topics': [TRANSFER, None, subject]}]
        if pair:
            filters.extend([{'address': pair, 'topics': [TRANSFER, subject]},
                            {'address': pair, 'topics': [TRANSFER, None, subject]}])
        queried, queried_bytes = {}, 0
        for filter_ in filters:
            rows = self.request('eth_getLogs', [{**filter_, 'fromBlock': hex(cursor.blockNumber+1), 'toBlock': hex(stop)}])
            if not isinstance(rows, list) or len(rows) > MAX_LOGS: raise CollectionError('collection_log_budget')
            in_filter = set()
            for raw in rows:
                log = self._log(raw, 0)
                location = (log.blockNumber, log.transactionIndex, log.logIndex)
                if location in in_filter: raise CollectionError('duplicate_query_log')
                in_filter.add(location)
                data = log.model_dump(exclude={'receiptLogIndex'})
                if location in queried and queried[location] != data: raise CollectionError('conflicting_query_log')
                if location not in queried:
                    queried_bytes += _json_size(data)
                    if len(queried) >= MAX_LOGS or queried_bytes > MAX_PAGE_BYTES:
                        raise CollectionError('collection_page_budget')
                queried[location] = data
        discovered = {}
        header_map = {h.blockNumber:h for h in headers}
        for data in queried.values():
            header = header_map.get(data['blockNumber'])
            txs = transactions.get(data['blockNumber'], [])
            if (header is None or data['blockHash'] != header.blockHash or data['transactionIndex'] >= len(txs)
                    or txs[data['transactionIndex']] != data['transactionHash']):
                raise CollectionError('query_transaction_location_mismatch')
            key = (data['blockNumber'], data['transactionIndex'])
            if key in discovered and discovered[key] != data['transactionHash']:
                raise CollectionError('conflicting_query_transaction')
            discovered[key] = data['transactionHash']
        if len(discovered) > MAX_TRANSACTIONS: raise CollectionError('collection_page_budget')
        receipts, relevant, all_locations, receipt_bytes = [], [], set(), 0
        for (number, index), tx_hash in sorted(discovered.items()):
            header = header_map[number]
            raw = self.request('eth_getTransactionReceipt', [tx_hash])
            if not isinstance(raw, dict) or (bytes32(raw.get('transactionHash')) != tx_hash or
                    quantity(raw.get('transactionIndex')) != index or quantity(raw.get('blockNumber')) != number or
                    bytes32(raw.get('blockHash')) != header.blockHash):
                raise CollectionError('transaction_receipt_mismatch')
            rows = raw.get('logs')
            if not isinstance(rows, list) or len(rows) > MAX_LOGS:
                raise CollectionError('collection_log_budget')
            logs = [self._log(log, i) for i, log in enumerate(rows)]
            for ordinal, log in enumerate(logs):
                location = (number, log.logIndex)
                if (log.transactionHash != tx_hash or log.transactionIndex != index or log.blockNumber != number or
                        log.blockHash != header.blockHash or (ordinal and log.logIndex != logs[ordinal-1].logIndex+1)
                        or location in all_locations):
                    raise CollectionError('incomplete_or_mismatched_receipt_logs')
                all_locations.add(location)
            if len(all_locations) > MAX_LOGS: raise CollectionError('collection_page_budget')
            status = quantity(raw.get('status'))
            if status not in (0, 1) or (status == 0 and logs): raise CollectionError('invalid_receipt_status')
            relevant.extend(log for log in logs if self._kind(log, baseline))
            transaction = self.request('eth_getTransactionByHash', [tx_hash])
            if (not isinstance(transaction, dict) or bytes32(transaction.get('hash')) != tx_hash or
                    quantity(transaction.get('blockNumber')) != header.blockNumber or
                    bytes32(transaction.get('blockHash')) != header.blockHash or quantity(transaction.get('transactionIndex')) != index):
                raise CollectionError('transaction_receipt_mismatch')
            sender = address(transaction.get('from'))
            to = None if transaction.get('to') is None else address(transaction['to'])
            if address(raw.get('from')) != sender or raw.get('to') != transaction.get('to'):
                raise CollectionError('transaction_sender_mismatch')
            receipt = Receipt(transactionHash=tx_hash, blockNumber=header.blockNumber, blockHash=header.blockHash,
                transactionIndex=index, fromAddress=sender, toAddress=to, status=status,
                gasUsed=str(quantity(raw.get('gasUsed'))), effectiveGasPrice=str(quantity(raw.get('effectiveGasPrice'))),
                logs=logs, rawReceipt=raw, rawTransaction=transaction)
            size = _json_size(receipt.model_dump())
            if size > MAX_RECEIPT_BYTES: raise CollectionError('collection_receipt_budget')
            receipt_bytes += size
            if receipt_bytes > MAX_PAGE_BYTES: raise CollectionError('collection_page_budget')
            receipts.append(receipt)
        expected = {(l.blockNumber, l.transactionIndex, l.logIndex): l.model_dump(exclude={'receiptLogIndex'}) for l in relevant}
        if queried != expected: raise CollectionError('incomplete_or_inconsistent_log_query')
        through = headers[-1]
        for pin in baseline.opening.codePins:
            if self._code(pin.address, through) != pin.codeHash:
                raise CollectionError('collection_dependency_code_changed')
        if address(self._get(baseline.vault, 'owner()', 'address', through)) != baseline.owner:
            raise CollectionError('collection_owner_changed')
        for header in [baseline.baseline, cursor, *headers]: self._recheck(header, baseline=header==baseline.baseline)
        final_check, _ = self._header('finalized')
        if (final_check.blockNumber < through.blockNumber or
                (final_check.blockNumber == through.blockNumber and final_check != through)):
            raise ReorgDetected('collection_finality_regressed', baseline.baseline)
        self._chain()
        events = [EventLocator(eventId=event_id(l.transactionHash, l.receiptLogIndex), kind=self._kind(l, baseline),
            **l.model_dump(exclude={'topics', 'data'})) for l in relevant]
        return Page(epochId=baseline.epochId, owner=baseline.owner, vault=baseline.vault, fromCursor=cursor,
            throughCursor=through, headers=headers, receipts=receipts, events=events)
