"""Bounded Initialize-event indexing, with atomic checkpoints and replay."""
from dataclasses import asdict
import re

from eth_hash.auto import keccak

from discovery import (CHAIN_ID, POOL_MANAGER, DataError, ReadRpc, PoolKey,
                       address, bytes32, quantity, parse_block, decode_result)
from catalogue import PgCatalogue
from indexer_io import MAX_CHUNK_EVENTS, MAX_INDEXER_SPAN, indexer_transport, read_headers
from discovery import Block
from rpc_failover import HistoricalReadRpc

INITIALIZE_TOPIC = '0x' + keccak(b'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)').hex()


class IndexRpc(HistoricalReadRpc):
    METHODS = ReadRpc.METHODS | {'eth_getLogs'}
    # An indexer envelope may carry many independent reads; the public read
    # path keeps ReadRpc's smaller cap.
    MAX_BATCH_ITEMS = 100


def decode_initialize(raw):
    if not isinstance(raw, dict) or address(raw.get('address')) != POOL_MANAGER or raw.get('removed') is not False:
        raise DataError('invalid_initialize_log')
    topics = raw.get('topics')
    if not isinstance(topics, list) or len(topics) != 4 or bytes32(topics[0]) != INITIALIZE_TOPIC:
        raise DataError('invalid_initialize_topics')
    pool_id = bytes32(topics[1])
    currencies = []
    for value in topics[2:]:
        value = bytes32(value)
        if value[2:26] != '0'*24:
            raise DataError('invalid_indexed_currency')
        currencies.append(address('0x'+value[26:]))
    data = raw.get('data')
    if not isinstance(data, str) or len(data) != 322:
        raise DataError('invalid_initialize_data')
    fee, spacing, hooks, sqrt, tick = decode_result(['uint24','int24','address','uint160','int24'],data)
    key = PoolKey.checked((*currencies,fee,spacing,hooks),pool_id)
    if not 0 < sqrt < 2**160 or not -887272 <= tick <= 887272:
        raise DataError('invalid_initial_price')
    return {'poolId':pool_id,'poolKey':asdict(key), 'blockNumber':quantity(raw.get('blockNumber')),
            'blockHash':bytes32(raw.get('blockHash')), 'transactionHash':bytes32(raw.get('transactionHash')),
            'logIndex':quantity(raw.get('logIndex'))}


def initialize_identity(url,pool_id,anchor_block,*,rpc=None):
    """Verified pool identity from its own Initialize log, not the manager cache.

    `DiscoveryReader.pool` resolves the key through the PositionManager's bytes25
    cache, which only holds pools that manager has seen. A pool created another
    way, or one with no position yet, is refused as `invalid_pool_key` even
    though its creation log proves the identity: the configured PoolManager
    emitted it and the key hashes to the pool id.
    """
    if type(anchor_block) is not int or anchor_block<1:
        raise DataError('invalid_anchor_block')
    rpc=rpc if rpc is not None else IndexRpc(url,transport=indexer_transport(90),max_requests=16)
    logs=rpc.request('eth_getLogs',[{'address':POOL_MANAGER,'topics':[INITIALIZE_TOPIC,pool_id],
                                    'fromBlock':hex(anchor_block),'toBlock':hex(anchor_block)}])
    if not isinstance(logs,list) or len(logs)!=1:
        raise DataError('initialize_anchor_not_found')
    event=decode_initialize(logs[0])
    if event['poolId']!=bytes32(pool_id) or event['blockNumber']!=anchor_block:
        raise DataError('initialize_anchor_mismatch')
    header=read_headers(rpc,[anchor_block])[anchor_block]
    if header.hash!=event['blockHash']:
        raise DataError('initialize_anchor_mismatch')
    return ({'poolId':event['poolId'],'poolKey':event['poolKey'],
             'currencies':[event['poolKey']['currency0'],event['poolKey']['currency1']],
             'providerMetrics':None},
            Block(anchor_block,header.hash,header.timestamp))


class CatalogueIndexer:
    def __init__(self, catalogue, rpc):
        self.catalogue, self.rpc = catalogue, rpc

    def block(self, number):
        block = parse_block(self.rpc.request('eth_getBlockByNumber',[hex(number),False]))
        if block.number != number:
            raise DataError('unexpected_block_number')
        return block

    def check_chain(self):
        if quantity(self.rpc.request('eth_chainId')) != CHAIN_ID:
            raise DataError('wrong_chain')

    def start(self, start_block):
        if type(start_block) is not int or start_block<1:
            raise DataError('invalid_catalogue_start')
        self.check_chain()
        with self.catalogue.connection(writer=True,lock=True) as conn:
            state = self.catalogue.state(conn)
            if state['start_block'] is not None:
                if state['start_block'] != start_block:
                    raise DataError('catalogue_start_already_set')
                return
            base = self.block(start_block-1)
            conn.execute('''UPDATE domino_catalogue.state SET start_block=%s,next_block=%s,
                          base_hash=%s,revision=revision+1 WHERE singleton''',(start_block,start_block,base.hash))

    def reset(self, start_block):
        """Restart the stored catalogue at an explicit, verified start block.

        This is the only supported way to change an already-set start block:
        the previous chunks, events and seed hints are dropped together, so a
        re-index cannot mix two intervals. It never touches the chain.
        """
        if type(start_block) is not int or start_block<1:
            raise DataError('invalid_catalogue_start')
        self.check_chain()
        base = self.block(start_block-1)
        with self.catalogue.connection(writer=True,lock=True) as conn:
            self.catalogue.state(conn)
            if self.block(start_block-1) != base:
                raise DataError('index_snapshot_reorganized')
            return self.catalogue.reset(conn,start_block,base.hash)

    def _reconcile(self, conn):
        state = self.catalogue.state(conn)
        if state['start_block'] is None:
            raise DataError('catalogue_start_required')
        checkpoints = conn.execute('SELECT * FROM domino_catalogue.chunks ORDER BY end_block DESC LIMIT 64').fetchall()
        if checkpoints and self.block(checkpoints[0]['end_block']).hash == checkpoints[0]['end_hash']:
            return None
        if not checkpoints and self.block(state['start_block']-1).hash == state['base_hash']:
            return None
        # Network errors abort the transaction. Only confirmed hash changes rewind.
        for checkpoint in checkpoints[1:]:
            if self.block(checkpoint['end_block']).hash == checkpoint['end_hash']:
                self.catalogue.rewind(conn,checkpoint['end_block'])
                return checkpoint['end_block']
        base = self.block(state['start_block']-1)
        self.catalogue.rewind(conn,base.number,base.hash)
        return base.number

    def step(self, *, through, span=1000):
        if type(through) is not int or type(span) is not int or not 1<=span<=MAX_INDEXER_SPAN:
            raise DataError('invalid_indexer_bounds')
        self.check_chain()
        with self.catalogue.connection(writer=True,lock=True) as conn:
            rewind = self._reconcile(conn)
            if rewind is not None:
                return {'status':'rewound','through':rewind}
            state = self.catalogue.state(conn)
            start = state['next_block']
            if start>through:
                return {'status':'caught_up_to_target','through':start-1}
            end = min(start+span-1,through)
            before, end_block = self.block(start-1), self.block(end)
            tail = conn.execute('SELECT end_hash FROM domino_catalogue.chunks ORDER BY end_block DESC LIMIT 1').fetchone()
            if before.hash != (tail['end_hash'] if tail else state['base_hash']):
                raise DataError('index_snapshot_reorganized')
            code = self.rpc.request('eth_getCode',[POOL_MANAGER,end_block.tag])
            if not isinstance(code,str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+',code):
                raise DataError('missing_pool_manager')
            raw = self.rpc.request('eth_getLogs',[{'address':POOL_MANAGER,'topics':[INITIALIZE_TOPIC],
                                   'fromBlock':hex(start),'toBlock':hex(end)}])
            if not isinstance(raw,list) or len(raw)>MAX_CHUNK_EVENTS:
                raise DataError('invalid_logs_response')
            events, identities = [], {}
            for log in raw:
                event = decode_initialize(log)
                number = event['blockNumber']
                if not start<=number<=end:
                    raise DataError('event_outside_chunk')
                # One header per event block would cost a provider call for every
                # Initialize event on the chain to re-check a hash the same reply
                # already carried. The chunk's own boundaries are read before and
                # after this call, so the range and its end hash are verified, and
                # the identity that matters — the key hashing to the pool id — is
                # checked inside decode_initialize.
                identity = (event['blockHash'],event['logIndex'])
                if identity in identities:
                    if identities[identity] != event:
                        raise DataError('conflicting_duplicate_log')
                    continue
                identities[identity] = event
                events.append(event)
            if self.block(end)!=end_block or self.block(start-1)!=before:
                raise DataError('index_snapshot_reorganized')
            events.sort(key=lambda event:(event['blockNumber'],event['logIndex']))
            self.catalogue.commit_chunk(conn,start,end,end_block.hash,events)
            return {'status':'indexed','fromBlock':start,'through':end,'events':len(events),
                    'endHash':end_block.hash}
