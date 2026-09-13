"""Bounded forward financial observations, with no income or USD inference.

Each point is exact finalized end-of-block state. Missing reads remain nullable
and partial; immutable opening membership and source inventory survive terminal
roots. Pool observations cover only the epoch's full PoolId. Query completeness
and finality remain explicit provider trust assumptions, not consensus proofs.
"""
from typing import Annotated, Literal

from eth_abi import decode
from eth_abi.exceptions import DecodingError
from eth_hash.auto import keccak
from pydantic import Field, StrictBool, StrictInt, model_validator

from discovery import DataError, PoolKey, ZERO, address, bytes32, quantity
from nft_ownership import signed_tick
from performance_collection import (Address, Baseline, CanonicalCollector,
    CHECKPOINT_TYPE, CollectionError, Cursor, Hash, HexData, MAX_LOGS, MAX_MEMBERS,
    MAX_PAGE_BYTES, MAX_RECEIPT_BYTES, MAX_TRANSACTIONS, Number, Page, POSITION_TYPE,
    Raw, Receipt, Record, ReorgDetected, TokenId, TRANSFER, _bounded, _json_size, _model)
from pool_activity import DONATE, MODIFY, SWAP, valid_price
from position_accounting import principal_amounts
from v4_math import Q128, U256

REGISTERED = '0x'+keccak(b'PositionRegistered(uint256,bytes32,bytes32,bytes32,uint64)').hex()
SOURCE_TYPE = '(bool,uint256,address,bytes32)'
FEE_BALANCE_TYPE = '(uint128,uint128)'
Pair = Annotated[list[Raw], Field(min_length=2, max_length=2)]
NullablePair = Annotated[list[Raw | None], Field(min_length=2, max_length=2)]
Reasons = Annotated[list[Annotated[str, Field(pattern=r'^[a-z][a-z0-9_]{0,95}$')]], Field(max_length=128)]
Checkpoint = Annotated[list[Raw | Hash], Field(min_length=7, max_length=7)]


class FinancialMember(Record):
    tokenId: TokenId
    status: Literal['complete', 'partial']
    reasons: Reasons
    holder: Address | None
    known: StrictBool | None
    active: StrictBool | None
    isRoot: StrictBool | None
    parentTokenId: Raw | None
    generation: Number | None
    identity: Hash | None
    source0: Hash | None
    source1: Hash | None
    tickLower: StrictInt | None
    tickUpper: StrictInt | None
    liquidityRaw: Raw | None
    principalRaw: Pair | None
    unsettledFeesRaw: Pair | None
    insideGrowthX128: Pair | None
    lastGrowthX128: Pair | None
    registrationBaselineId: Hash | None
    registrationCheckpoint: Checkpoint | None
    checkpoint: Checkpoint | None

    @model_validator(mode='after')
    def coherent(self):
        if (self.status == 'complete') != (not self.reasons):
            raise ValueError('invalid_financial_member_status')
        if self.status == 'complete' and any(value is None for key, value in self.model_dump().items()):
            raise ValueError('incomplete_financial_member')
        return self


class FinancialSource(Record):
    sourceId: Hash
    tokenId: TokenId
    originalCurrency: Address
    currency: Address
    originalRaw: Raw | None
    chargedRaw: Raw | None


class FinancialPoint(Record):
    epochId: Hash
    owner: Address
    vault: Address
    block: Cursor
    status: Literal['complete', 'partial']
    reasons: Reasons
    activeTokenIds: Annotated[list[TokenId], Field(max_length=MAX_MEMBERS)]
    members: Annotated[list[FinancialMember], Field(min_length=1, max_length=MAX_MEMBERS)]
    sources: Annotated[list[FinancialSource], Field(max_length=4*MAX_MEMBERS)]
    currencies: Annotated[list[Address], Field(min_length=2, max_length=2)]
    heldRaw: NullablePair
    accountedRaw: NullablePair
    nativeHeldRaw: Raw | None
    nativeSurplusRaw: Raw | None
    unattributedAccountedRaw: NullablePair

    @model_validator(mode='after')
    def coherent(self):
        ids = [member.tokenId for member in self.members]
        if ids != sorted(set(ids), key=int) or self.activeTokenIds != sorted(set(self.activeTokenIds), key=int):
            raise ValueError('invalid_financial_member_inventory')
        if not set(self.activeTokenIds) <= set(ids):
            raise ValueError('invalid_financial_active_inventory')
        source_ids = [(source.sourceId, source.currency) for source in self.sources]
        if len(source_ids) != len(set(source_ids)) or any(source.tokenId not in ids for source in self.sources):
            raise ValueError('invalid_financial_source_inventory')
        if (self.status == 'complete') != (not self.reasons):
            raise ValueError('invalid_financial_point_status')
        if self.status == 'complete' and (any(m.status != 'complete' for m in self.members)
                or any(v is None for v in [*self.heldRaw, *self.accountedRaw,
                    *self.unattributedAccountedRaw, self.nativeHeldRaw, self.nativeSurplusRaw])
                or any(s.originalRaw is None or s.chargedRaw is None for s in self.sources)):
            raise ValueError('incomplete_financial_point')
        _bounded(self.model_dump())
        return self


class FinancialPoolEvent(Record):
    address: Address
    topics: Annotated[list[Hash], Field(min_length=3, max_length=3)]
    data: HexData
    blockNumber: Number
    blockHash: Hash
    transactionHash: Hash
    transactionIndex: Number
    logIndex: Number
    # A pool query does not establish an ordinal within a transaction receipt.
    receiptLogIndex: Number | None


class FinancialPage(Record):
    epochId: Hash
    owner: Address
    vault: Address
    fromCursor: Cursor
    throughCursor: Cursor
    knownTokenIds: Annotated[list[TokenId], Field(min_length=1, max_length=MAX_MEMBERS)]
    points: Annotated[list[FinancialPoint], Field(min_length=1, max_length=16)]
    poolEvents: Annotated[list[FinancialPoolEvent], Field(max_length=MAX_LOGS)]
    receipts: Annotated[list[Receipt], Field(max_length=MAX_TRANSACTIONS)]

    @model_validator(mode='after')
    def coherent(self):
        previous = self.fromCursor
        for point in self.points:
            if (point.epochId, point.owner, point.vault) != (self.epochId, self.owner, self.vault):
                raise ValueError('financial_point_epoch_mismatch')
            if (point.block.blockNumber != previous.blockNumber+1 or point.block.parentHash != previous.blockHash
                    or point.block.timestamp < previous.timestamp):
                raise ValueError('noncontiguous_financial_points')
            previous = point.block
        if previous != self.throughCursor or self.knownTokenIds != sorted(set(self.knownTokenIds), key=int):
            raise ValueError('invalid_financial_page_cursor')
        if not all({m.tokenId for m in p.members} <= set(self.knownTokenIds) for p in self.points):
            raise ValueError('invalid_financial_page_inventory')
        # Reuse canonical receipt inclusion/order/log validation without changing
        # the persisted raw page or its event contract.
        Page(epochId=self.epochId, owner=self.owner, vault=self.vault, fromCursor=self.fromCursor,
             throughCursor=self.throughCursor, headers=[p.block for p in self.points], receipts=self.receipts, events=[])
        headers = {p.block.blockNumber: p.block for p in self.points}
        receipts = {r.transactionHash: r for r in self.receipts}
        order, slots = [], set()
        for event in self.poolEvents:
            header = headers.get(event.blockNumber)
            if header is None or header.blockHash != event.blockHash or event.topics[0] not in (SWAP, DONATE, MODIFY):
                raise ValueError('invalid_financial_pool_event')
            order.append((event.blockNumber, event.transactionIndex, event.logIndex))
            slot = (event.blockNumber, event.logIndex)
            if slot in slots: raise ValueError('duplicate_financial_pool_location')
            slots.add(slot)
            receipt = receipts.get(event.transactionHash)
            if event.receiptLogIndex is not None:
                if receipt is None or event.receiptLogIndex >= len(receipt.logs) or (
                        event.model_dump() != receipt.logs[event.receiptLogIndex].model_dump()):
                    raise ValueError('financial_pool_receipt_mismatch')
            elif receipt is not None:
                raise ValueError('missing_financial_pool_receipt_ordinal')
        if order != sorted(set(order)):
            raise ValueError('invalid_financial_pool_order')
        _bounded(self.model_dump())
        return self


class FinancialCollector(CanonicalCollector):
    """Consumes a persisted canonical page; never starts historical replay."""

    @staticmethod
    def _known(baseline, values):
        ids = baseline.tokenIds if values is None else values
        if (type(ids) is not list or not 1 <= len(ids) <= MAX_MEMBERS
                or any(type(i) is not str or not i.isdecimal() or not 0 < int(i) < 2**256
                    or str(int(i)) != i for i in ids)
                or len(ids) != len(set(ids)) or not set(baseline.tokenIds) <= set(ids)):
            raise CollectionError('invalid_financial_known_members')
        return sorted(ids, key=int)

    def _admission(self, baseline, block):
        for pin in baseline.opening.codePins:
            if self._code(pin.address, block) != pin.codeHash:
                raise CollectionError('collection_dependency_code_changed')
        for signature, output, expected in (
            ('owner()', 'address', baseline.owner),
            ('positionManager()', 'address', baseline.positionManager),
            ('poolManager()', 'address', baseline.opening.poolManager),
            ('stateView()', 'address', baseline.opening.stateView),
            ('implementation()', 'address', baseline.opening.implementation),
            ('factory()', 'address', baseline.opening.factory),
            ('implementationVersion()', 'uint64', baseline.opening.implementationVersion),
            ('rootTokenId()', 'uint256', int(baseline.rootTokenId)),
        ):
            if self._get(baseline.vault, signature, output, block) != expected:
                raise CollectionError('financial_epoch_binding_changed')
        for signature, expected in (('sequenceIdentityHash()', baseline.opening.sequenceIdentity),
                                     ('poolId()', baseline.opening.poolId)):
            if '0x'+self._get(baseline.vault, signature, 'bytes32', block).hex() != expected:
                raise CollectionError('financial_epoch_binding_changed')
        targets = {p.address for p in baseline.opening.codePins}
        for signature, enabled in (('readHelper()', baseline.opening.implementationVersion >= 2),
                                   ('compoundEngine()', baseline.opening.implementationVersion == 3)):
            if enabled and self._get(baseline.vault, signature, 'address', block) not in targets:
                raise CollectionError('financial_dependency_pin_missing')
        if baseline.opening.implementationVersion == 4:
            engine = self._get(baseline.vault, 'executionEngine()', 'address', block)
            pins = baseline.opening.codePins
            if (len(pins) != 10 or engine != pins[7].address
                    or self._get(engine, 'routingHelper()', 'address', block) != pins[8].address
                    or self._get(engine, 'priceGuard()', 'address', block) != pins[9].address):
                raise CollectionError('financial_dependency_pin_missing')
        if len(targets) != {1:6, 2:7, 3:8, 4:10}[baseline.opening.implementationVersion]:
            raise CollectionError('financial_dependency_pin_missing')

    @staticmethod
    def _attempt(fn, reasons, code):
        try:
            return fn()
        except CollectionError as error:
            if error.code != 'collection_rpc_unavailable':
                raise
        except (DataError, DecodingError, ValueError, TypeError, IndexError, OverflowError):
            pass
        if code not in reasons:
            reasons.append(code)
        return None

    @staticmethod
    def _checkpoint(raw):
        return [str(v) for v in raw[:6]]+['0x'+raw[6].hex()]

    def _point(self, baseline, block, known_ids):
        self._admission(baseline, block)
        vault, opening = baseline.vault, baseline.opening
        tag, reasons = self._tag(block), []
        get = lambda target, sig, output, inputs=(), values=(): self._get(target, sig, output, block, inputs, values)
        native = self._attempt(lambda: str(quantity(self.request('eth_getBalance', [vault, tag]))),
                               reasons, 'native_balance_unavailable')
        held, accounted = [], []
        for currency in opening.currencies:
            held.append(native if currency == ZERO else self._attempt(
                lambda c=currency: str(get(c, 'balanceOf(address)', 'uint256', ['address'], [vault])),
                reasons, 'currency_balance_unavailable'))
            accounted.append(self._attempt(lambda c=currency: str(get(vault, 'accountedCurrency(address)',
                'uint256', ['address'], [c])), reasons, 'accounted_balance_unavailable'))
        pool = bytes.fromhex(opening.poolId[2:])
        slot = self._attempt(lambda: self.call(opening.stateView, 'getSlot0(bytes32)', ['bytes32'], [pool],
            ['uint160', 'int24', 'uint24', 'uint24'], block=tag), reasons, 'pool_state_unavailable')
        if slot is not None:
            if self._attempt(lambda: (valid_price(slot[0], slot[1]), True)[1], reasons,
                             'pool_state_invalid') is None:
                slot = None
        active_count = self._attempt(lambda: get(vault, 'activePositions()', 'uint256'),
                                     reasons, 'member_inventory_unavailable')
        original_members = {m.tokenId: m for m in opening.members}
        members, sources, active_ids, seen_sources = [], [], [], set()
        for token_id in known_ids:
            number, member_reasons = int(token_id), []
            values = {key: None for key in FinancialMember.model_fields if key not in ('tokenId', 'status', 'reasons')}
            member = self._attempt(lambda: get(vault, 'position(uint256)', POSITION_TYPE, ['uint256'], [number]),
                                   member_reasons, 'member_state_unavailable')
            if member is not None:
                values.update(known=member[0], active=member[1], isRoot=member[2], parentTokenId=str(member[3]),
                    generation=member[4], tickLower=member[5], tickUpper=member[6],
                    registrationBaselineId='0x'+member[7].hex(), identity='0x'+member[8].hex(),
                    source0='0x'+member[9].hex(), source1='0x'+member[10].hex())
                if not member[0]: member_reasons.append('member_not_registered')
                if not member[1]: member_reasons.append('member_inactive')
                if member[1]: active_ids.append(token_id)
                if member[2] != (token_id == baseline.rootTokenId): member_reasons.append('member_root_mismatch')
                original = original_members.get(token_id)
                if original is not None and any(values[key] != getattr(original, key) for key in (
                        'isRoot', 'parentTokenId', 'identity', 'registrationBaselineId', 'source0', 'source1',
                        'tickLower', 'tickUpper')):
                    member_reasons.append('opening_member_identity_changed')
            for signature, field in (('registrationCheckpoint(uint256)', 'registrationCheckpoint'),
                                      ('checkpoint(uint256)', 'checkpoint')):
                values[field] = self._attempt(lambda s=signature: self._checkpoint(get(vault, s, CHECKPOINT_TYPE,
                    ['uint256'], [number])), member_reasons, 'member_checkpoint_unavailable')
            original = original_members.get(token_id)
            if original is not None and values['registrationCheckpoint'] is not None and (
                    values['registrationCheckpoint'] != original.registrationCheckpoint):
                member_reasons.append('opening_registration_checkpoint_changed')
            values['holder'] = self._attempt(lambda: address(get(baseline.positionManager, 'ownerOf(uint256)',
                'address', ['uint256'], [number])), member_reasons, 'member_holder_unavailable')
            expected_holder = baseline.owner if token_id == baseline.rootTokenId else vault
            if values['holder'] is not None and values['holder'] != expected_holder:
                member_reasons.append('member_holder_changed')

            def read_amounts():
                raw_key, info = self.call(baseline.positionManager, 'getPoolAndPositionInfo(uint256)',
                    ['uint256'], [number], ['(address,address,uint24,int24,address)', 'uint256'], block=tag)
                if info == 0:
                    raise ValueError('empty_position_info')
                key = PoolKey.checked(raw_key, opening.poolId)
                lo, hi = signed_tick(info >> 8), signed_tick(info >> 32)
                if (key.hooks != ZERO or [key.currency0, key.currency1] != opening.currencies
                        or not -887272 <= lo < hi <= 887272 or lo % key.tick_spacing or hi % key.tick_spacing
                        or info >> 56 != int(opening.poolId, 16) >> 56
                        or (lo, hi) != (values['tickLower'], values['tickUpper'])):
                    raise ValueError('member_pool_binding_mismatch')
                liquidity = get(baseline.positionManager, 'getPositionLiquidity(uint256)', 'uint128', ['uint256'], [number])
                core_liquidity, last0, last1 = self.call(opening.stateView,
                    'getPositionInfo(bytes32,address,int24,int24,bytes32)',
                    ['bytes32', 'address', 'int24', 'int24', 'bytes32'],
                    [pool, baseline.positionManager, lo, hi, number.to_bytes(32, 'big')],
                    ['uint128', 'uint256', 'uint256'], block=tag)
                if core_liquidity != liquidity:
                    raise ValueError('core_liquidity_mismatch')
                growth = self.call(opening.stateView, 'getFeeGrowthInside(bytes32,int24,int24)',
                    ['bytes32', 'int24', 'int24'], [pool, lo, hi], ['uint256', 'uint256'], block=tag)
                result = dict(liquidityRaw=str(liquidity), lastGrowthX128=[str(last0), str(last1)],
                    insideGrowthX128=list(map(str, growth)), unsettledFeesRaw=[str(((growth[i]-last)&U256)*liquidity//Q128)
                    for i, last in enumerate((last0, last1))])
                if slot is not None:
                    result['principalRaw'] = list(map(str, principal_amounts({'sqrtPriceX96':str(slot[0])}, lo, hi, liquidity)))
                return result

            amounts = self._attempt(read_amounts, member_reasons, 'member_amounts_unavailable')
            if amounts is not None: values.update(amounts)
            if slot is None: member_reasons.append('member_principal_unavailable')
            # Even a burned/withdrawn NFT retains source metadata in the vault.
            # If that read fails, immutable opening identifiers still locate its
            # balances; unavailable rows are never replaced by zero.
            metadata = values if member is not None and member[0] else (
                original.model_dump() if original is not None else None)
            if metadata is not None:
                for index in (0, 1):
                    source_id = metadata['source'+str(index)]
                    if source_id in seen_sources:
                        raise CollectionError('duplicate_financial_source')
                    seen_sources.add(source_id)
                    source = self._attempt(lambda s=source_id: get(vault, 'source(bytes32)', SOURCE_TYPE,
                        ['bytes32'], [bytes.fromhex(s[2:])]), reasons, 'source_metadata_unavailable')
                    valid_source = source is not None and (source[0] and source[1] == number
                        and address(source[2]) == opening.currencies[index]
                        and '0x'+source[3].hex() == metadata['identity'])
                    if source is not None and not valid_source and 'source_identity_changed' not in reasons:
                        reasons.append('source_identity_changed')
                    for currency in opening.currencies:
                        balance = self._attempt(lambda s=source_id, c=currency: get(vault,
                            'feeBalance(bytes32,address)', FEE_BALANCE_TYPE, ['bytes32', 'address'],
                            [bytes.fromhex(s[2:]), c]), reasons, 'source_balance_unavailable') if valid_source else None
                        sources.append(FinancialSource(sourceId=source_id, tokenId=token_id,
                            originalCurrency=opening.currencies[index], currency=currency,
                            originalRaw=None if balance is None else str(balance[0]),
                            chargedRaw=None if balance is None else str(balance[1])))
            member_reasons = sorted(set(member_reasons))
            members.append(FinancialMember(tokenId=token_id, status='partial' if member_reasons else 'complete',
                                           reasons=member_reasons, **values))
            if member_reasons and 'member_observation_partial' not in reasons:
                reasons.append('member_observation_partial')
        if active_count is not None and active_count != len(active_ids): reasons.append('member_inventory_incomplete')
        residual = []
        for index, currency in enumerate(opening.currencies):
            known = sum(int(s.originalRaw)+int(s.chargedRaw) for s in sources if s.currency == currency
                        and s.originalRaw is not None and s.chargedRaw is not None)
            amount = None if accounted[index] is None else int(accounted[index])-known
            if amount is not None and amount < 0:
                reasons.append('source_accounting_mismatch'); amount = None
            residual.append(None if amount is None else str(amount))
            if amount is not None and amount > 0 and 'source_inventory_unattributed' not in reasons:
                reasons.append('source_inventory_unattributed')
            if held[index] is not None and accounted[index] is not None and int(accounted[index]) > int(held[index]):
                reasons.append('accounted_balance_unbacked')
        native_accounted = accounted[opening.currencies.index(ZERO)] if ZERO in opening.currencies else '0'
        surplus = None if native is None or native_accounted is None else int(native)-int(native_accounted)
        if surplus is not None and surplus < 0: surplus = None
        reasons = sorted(set(reasons))
        return FinancialPoint(epochId=baseline.epochId, owner=baseline.owner, vault=vault, block=block,
            status='partial' if reasons else 'complete', reasons=reasons, activeTokenIds=active_ids, members=members,
            sources=sources, currencies=opening.currencies, heldRaw=held, accountedRaw=accounted,
            nativeHeldRaw=native, nativeSurplusRaw=None if surplus is None else str(surplus),
            unattributedAccountedRaw=residual)

    def _finish(self, baseline, headers):
        for block in [baseline.baseline, *headers]:
            self._recheck(block, baseline=block == baseline.baseline)
        finalized, _ = self._header('finalized')
        through = headers[-1]
        if finalized.blockNumber < through.blockNumber or (finalized.blockNumber == through.blockNumber and finalized != through):
            raise ReorgDetected('collection_finality_regressed', baseline.baseline)
        self._chain()

    def capture_point(self, baseline, block, known_token_ids=None):
        self.count = 0
        try:
            baseline, block = _model(Baseline, baseline), _model(Cursor, block)
            known = self._known(baseline, known_token_ids)
            if block.blockNumber < baseline.baseline.blockNumber:
                raise CollectionError('financial_point_before_baseline')
            self._chain()
            self._recheck(baseline.baseline, baseline=True)
            self._recheck(block)
            point = self._point(baseline, block, known)
            self._finish(baseline, [block])
            return point
        except ReorgDetected as error:
            self._confirm_reorg(error, baseline)
        except CollectionError: raise
        except Exception:
            raise CollectionError('invalid_financial_point') from None

    def _confirm_reorg(self, error, baseline):
        # Never return the stored opening as if it were a fresh observation.
        try:
            observed, _ = self._header(hex(baseline.baseline.blockNumber))
            if observed.blockNumber != baseline.baseline.blockNumber:
                raise CollectionError('collection_baseline_confirmation_failed')
        except CollectionError: raise
        except Exception:
            raise CollectionError('collection_baseline_confirmation_failed') from None
        raise ReorgDetected(error.code, observed) from None

    @staticmethod
    def _registered_ids(page, baseline):
        additions = {}
        for receipt in page.receipts:
            for log in receipt.logs:
                if log.address != baseline.vault or not log.topics or log.topics[0] != REGISTERED:
                    continue
                if len(log.topics) != 3 or len(log.data) != 194:
                    raise CollectionError('malformed_financial_registration')
                decode(['bytes32', 'bytes32', 'uint64'], bytes.fromhex(log.data[2:]))
                token = str(int(log.topics[1], 16))
                if token == '0': raise CollectionError('malformed_financial_registration')
                additions.setdefault(log.blockNumber, set()).add(token)
        return additions

    @staticmethod
    def _pool_log(log, baseline):
        if log.address != baseline.opening.poolManager or not log.topics or log.topics[0] not in (SWAP, DONATE, MODIFY):
            return False
        if len(log.topics) != 3 or log.topics[1] != baseline.opening.poolId:
            return False
        if log.topics[2][2:26] != '0'*24:
            raise CollectionError('malformed_financial_pool_event')
        types = {SWAP:['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'],
                 DONATE:['uint256', 'uint256'], MODIFY:['int24', 'int24', 'int256', 'bytes32']}[log.topics[0]]
        if len(log.data) != 2+64*len(types): raise CollectionError('malformed_financial_pool_event')
        decode(types, bytes.fromhex(log.data[2:]))
        return True

    @staticmethod
    def _known_transfer(log, baseline, known):
        if log.address != baseline.positionManager or not log.topics or log.topics[0] != TRANSFER:
            return False
        if len(log.topics) != 4 or log.data != '0x' or any(t[2:26] != '0'*24 for t in log.topics[1:3]):
            raise CollectionError('malformed_position_transfer')
        return str(int(log.topics[3], 16)) in known

    def _receipt(self, tx_hash, header, index):
        raw = self.request('eth_getTransactionReceipt', [tx_hash])
        if not isinstance(raw, dict) or (bytes32(raw.get('transactionHash')) != tx_hash
                or quantity(raw.get('blockNumber')) != header.blockNumber
                or bytes32(raw.get('blockHash')) != header.blockHash
                or quantity(raw.get('transactionIndex')) != index):
            raise CollectionError('transaction_receipt_mismatch')
        rows = raw.get('logs')
        if not isinstance(rows, list) or len(rows) > MAX_LOGS: raise CollectionError('collection_log_budget')
        logs = [self._log(row, ordinal) for ordinal, row in enumerate(rows)]
        for ordinal, log in enumerate(logs):
            if (log.transactionHash != tx_hash or log.blockNumber != header.blockNumber
                    or log.blockHash != header.blockHash or log.transactionIndex != index
                    or ordinal and log.logIndex != logs[ordinal-1].logIndex+1):
                raise CollectionError('incomplete_or_mismatched_receipt_logs')
        status = quantity(raw.get('status'))
        if status not in (0, 1) or status == 0 and logs: raise CollectionError('invalid_receipt_status')
        transaction = self.request('eth_getTransactionByHash', [tx_hash])
        if not isinstance(transaction, dict) or (bytes32(transaction.get('hash')) != tx_hash
                or quantity(transaction.get('blockNumber')) != header.blockNumber
                or bytes32(transaction.get('blockHash')) != header.blockHash
                or quantity(transaction.get('transactionIndex')) != index):
            raise CollectionError('transaction_receipt_mismatch')
        sender = address(transaction.get('from'))
        to = None if transaction.get('to') is None else address(transaction['to'])
        if address(raw.get('from')) != sender or raw.get('to') != transaction.get('to'):
            raise CollectionError('transaction_sender_mismatch')
        result = Receipt(transactionHash=tx_hash, blockNumber=header.blockNumber, blockHash=header.blockHash,
            transactionIndex=index, fromAddress=sender, toAddress=to, status=status,
            gasUsed=str(quantity(raw.get('gasUsed'))), effectiveGasPrice=str(quantity(raw.get('effectiveGasPrice'))),
            logs=logs, rawReceipt=raw, rawTransaction=transaction)
        if _json_size(result.model_dump()) > MAX_RECEIPT_BYTES: raise CollectionError('collection_receipt_budget')
        return result

    def capture_points(self, baseline, page, known_token_ids=None):
        self.count = 0
        try:
            baseline, page = _model(Baseline, baseline), _model(Page, page)
            return self._capture_points(baseline, page, self._known(baseline, known_token_ids))
        except ReorgDetected as error:
            self._confirm_reorg(error, baseline)
        except CollectionError: raise
        except Exception:
            raise CollectionError('invalid_financial_page') from None

    def _capture_points(self, baseline, page, initial_ids):
        if (page.epochId, page.owner, page.vault) != (baseline.epochId, baseline.owner, baseline.vault):
            raise CollectionError('financial_page_epoch_mismatch')
        if page.fromCursor.blockNumber < baseline.baseline.blockNumber:
            raise CollectionError('financial_page_before_baseline')
        self._chain()
        self._recheck(baseline.baseline, baseline=True)
        self._recheck(page.fromCursor)
        header_map, transaction_map = {}, {}
        for header in page.headers:
            observed, txs = self._header(hex(header.blockNumber))
            if observed != header: raise ReorgDetected('collection_header_reorganized', baseline.baseline)
            header_map[header.blockNumber], transaction_map[header.blockNumber] = header, txs
        additions = self._registered_ids(page, baseline)
        all_ids = set(initial_ids).union(*(ids for ids in additions.values()))
        if len(all_ids) > MAX_MEMBERS: raise CollectionError('financial_member_budget')
        queried, query_slots = {}, set()
        filters = [({'address': baseline.opening.poolManager, 'topics': [[SWAP, DONATE, MODIFY], baseline.opening.poolId]},
                    lambda log: self._pool_log(log, baseline)),
                   ({'address': baseline.positionManager, 'topics': [TRANSFER, None, None,
                     ['0x'+int(i).to_bytes(32, 'big').hex() for i in sorted(all_ids, key=int)]]},
                    lambda log: self._known_transfer(log, baseline, all_ids))]
        for query, matches in filters:
            rows = self.request('eth_getLogs', [{**query, 'fromBlock': hex(page.fromCursor.blockNumber+1),
                                                'toBlock': hex(page.throughCursor.blockNumber)}])
            if not isinstance(rows, list) or len(rows) > MAX_LOGS: raise CollectionError('collection_log_budget')
            for raw in rows:
                log = self._log(raw, 0)
                if not matches(log): raise CollectionError('financial_log_filter_mismatch')
                header, txs = header_map.get(log.blockNumber), transaction_map.get(log.blockNumber, [])
                if (header is None or log.blockHash != header.blockHash or log.transactionIndex >= len(txs)
                        or txs[log.transactionIndex] != log.transactionHash):
                    raise CollectionError('query_transaction_location_mismatch')
                location = (log.blockNumber, log.transactionIndex, log.logIndex)
                slot = (log.blockNumber, log.logIndex)
                if slot in query_slots: raise CollectionError('duplicate_query_log')
                query_slots.add(slot)
                queried[location] = log
                if len(queried) > MAX_LOGS: raise CollectionError('collection_page_budget')
        discovered = {r.transactionHash:(r.blockNumber, r.transactionIndex) for r in page.receipts}
        pm_topic = '0x'+baseline.positionManager[2:].rjust(64, '0')
        for log in queried.values():
            if self._known_transfer(log, baseline, all_ids):
                discovered[log.transactionHash] = (log.blockNumber, log.transactionIndex)
            elif log.topics[0] == MODIFY and log.topics[2] == pm_topic:
                _, _, _, salt = decode(['int24', 'int24', 'int256', 'bytes32'], bytes.fromhex(log.data[2:]))
                if str(int.from_bytes(salt, 'big')) in all_ids:
                    discovered[log.transactionHash] = (log.blockNumber, log.transactionIndex)
        if len(discovered) > MAX_TRANSACTIONS: raise CollectionError('collection_page_budget')
        originals = {r.transactionHash:r for r in page.receipts}
        receipts, locations, size = [], set(), 0
        pool_events = {loc: FinancialPoolEvent(**log.model_dump(exclude={'receiptLogIndex'}), receiptLogIndex=None)
                       for loc, log in queried.items() if self._pool_log(log, baseline)}
        for tx_hash, (number, index) in sorted(discovered.items(), key=lambda item: item[1]):
            txs = transaction_map.get(number, [])
            if index >= len(txs) or txs[index] != tx_hash: raise CollectionError('query_transaction_location_mismatch')
            receipt = self._receipt(tx_hash, header_map[number], index)
            if tx_hash in originals and originals[tx_hash] != receipt:
                raise CollectionError('financial_raw_receipt_mismatch')
            for log in receipt.logs:
                location = (log.blockNumber, log.transactionIndex, log.logIndex)
                slot = (log.blockNumber, log.logIndex)
                if slot in locations: raise CollectionError('incomplete_or_mismatched_receipt_logs')
                locations.add(slot)
                if self._pool_log(log, baseline) or self._known_transfer(log, baseline, all_ids):
                    found = queried.get(location)
                    if found is None or found.model_dump(exclude={'receiptLogIndex'}) != log.model_dump(exclude={'receiptLogIndex'}):
                        raise CollectionError('incomplete_or_inconsistent_log_query')
                    if self._pool_log(log, baseline):
                        pool_events[location] = FinancialPoolEvent(**log.model_dump())
            actual = {l.logIndex for l in receipt.logs}
            if any(l.logIndex not in actual for l in queried.values() if l.transactionHash == tx_hash):
                raise CollectionError('incomplete_or_inconsistent_log_query')
            size += _json_size(receipt.model_dump())
            if size > MAX_PAGE_BYTES or len(locations | query_slots) > MAX_LOGS:
                raise CollectionError('collection_page_budget')
            receipts.append(receipt)
        known, points = set(initial_ids), []
        for header in page.headers:
            known.update(additions.get(header.blockNumber, set()))
            points.append(self._point(baseline, header, sorted(known, key=int)))
        self._finish(baseline, [page.fromCursor, *page.headers])
        return FinancialPage(epochId=baseline.epochId, owner=baseline.owner, vault=baseline.vault,
            fromCursor=page.fromCursor, throughCursor=page.throughCursor, knownTokenIds=sorted(known, key=int),
            points=points, poolEvents=[pool_events[loc] for loc in sorted(pool_events)], receipts=receipts)
