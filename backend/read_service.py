"""Read orchestration with optional public catalogue; no accounts or signer."""
from collections import OrderedDict
from dataclasses import asdict
from copy import deepcopy
from functools import wraps
from threading import BoundedSemaphore, Lock
import time
import re

from discovery import (CHAIN_ID, KEEPALIVE_OPENER, ZERO, DataError, DiscoveryReader,
                       ReadRpc, Block, address, bytes32, decode_result, discover,
                       json_http, parse_block, prefetched, SNAPSHOT_LOOPBACK_RPC,
                       snapshot_loopback_http)
from inventory import AlchemyInventory, CursorCodec
from rpc_failover import FailoverReadRpc, HistoricalReadRpc
from rpc_config import LOCAL_RPC_HOST, rpc_endpoint
from sequence_snapshot import sequence_snapshot
from read_deadline import (ReadDeadline, check_read_deadline, current_read_deadline,
                           use_read_deadline)


# These are known transport failures, not a fallback for arbitrary producer text.
_HTTP_REASONS = {f'http_{code}': 'upstream_unavailable'
                 for code in (400, 401, 403, 404, 408, 500, 502, 503, 504,
                              520, 521, 522, 523, 524, 530)}
_HTTP_REASONS['http_429'] = 'provider_rate_limited'


def public_reason(reason, known):
    if reason is None or type(reason) is str and reason in known:
        return reason
    if type(reason) is str and reason in _HTTP_REASONS:
        return _HTTP_REASONS[reason]
    raise DataError('upstream_contract_mismatch')


def public_response(route):
    """Project known worker states and identity tags without mutating raw reports."""
    def decorate(operation):
        @wraps(operation)
        def wrapped(*args, **kwargs):
            from read_contract import REASON_CODES
            from historical_read import project_historical_work
            result = deepcopy(operation(*args, **kwargs))
            project_historical_work(route, result)
            def walk(value):
                if isinstance(value, dict):
                    if isinstance(value.get('poolKey'), dict):
                        key = value['poolKey']
                        key['feeMode'] = 'dynamic' if key['fee_pips'] == 8388608 else 'fixed'
                    if route in ('token', 'pools', 'wallet-assets'):
                        if 'reason' in value:
                            value['reason'] = public_reason(value['reason'], REASON_CODES)
                        issues = value.get('metadataIssues', {})
                        if not isinstance(issues, dict):
                            raise DataError('upstream_contract_mismatch')
                        for field, reason in issues.items():
                            issues[field] = public_reason(reason, REASON_CODES)
                    for child in value.values(): walk(child)
                elif isinstance(value, list):
                    for child in value: walk(child)
            walk(result)
            for pool in result.get('pools', []) if route == 'pools' else result.get('items', []) if route == 'catalogue' else []:
                pool['poolKind'] = 'catalogue' if 'catalogueSource' in pool else 'discovery'
            return result
        return wrapped
    return decorate


def bounded_transport(seconds=60):
    parent = current_read_deadline()
    deadline = ReadDeadline(seconds, parents=(parent,) if parent else ())

    def transport(url, body=None):
        with use_read_deadline(deadline) as active:
            # Reads reuse kept provider connections instead of one handshake per call.
            return json_http(url, body, timeout=active.timeout(8), opener=KEEPALIVE_OPENER)
    return transport


def bounded_snapshot_loopback_transport(seconds=60):
    parent = current_read_deadline()
    deadline = ReadDeadline(seconds, parents=(parent,) if parent else ())

    def transport(url, body=None):
        if url != SNAPSHOT_LOOPBACK_RPC:
            raise DataError('upstream_unavailable')
        with use_read_deadline(deadline) as active:
            return snapshot_loopback_http(url, body, timeout=active.timeout(8))
    return transport


# The wallet inventory is the one third-party quota on the wallet path (Alchemy's
# token list). Which tokens a wallet holds changes slowly, so its first page is
# reused for a few minutes and, while the provider is busy, for up to an hour; the
# balances themselves are read on chain on every request. On 26 September 2026 the
# page and the probes of its twenty candidates were 1.2 s of a 1.6 s wallet read.
# Four calls at once stay far inside the provider's per-second allowance; a read
# waits up to two seconds for one, so a burst of new wallets still gets its lists,
# before it answers without one.
INVENTORY_FRESH_SECONDS = 300
INVENTORY_STALE_SECONDS = 3600
INVENTORY_CACHE_SIZE = 4096
INVENTORY_CONCURRENCY = 4
INVENTORY_WAIT_SECONDS = 2


class ReadService:
    def __init__(self, *, rpc_url=None, rpc_urls=None, inventory_url=None, historical_rpc_url=None,
                 historical_rpc_urls=None, clock=time.time,
                 rpc_factory=None, inventory=None, cursor_codec=None, transport_factory=bounded_transport,
                 catalogue=None, market_cache=None, snapshot=None, requests=None, public_data=None,
                 snapshot_rpc_version=None, snapshot_loopback=False):
        self.rpc_url, self.inventory_url, self.clock = rpc_url, inventory_url, clock
        self.rpc_urls = tuple(rpc_urls) if rpc_urls is not None else None
        self.snapshot_rpc_version = snapshot_rpc_version
        if type(snapshot_loopback) is not bool:
            raise DataError('invalid_local_provider_config')
        self.snapshot_loopback = snapshot_loopback
        self._inventory_pages, self._inventory_lock = OrderedDict(), Lock()
        self._inventory_slot = BoundedSemaphore(INVENTORY_CONCURRENCY)
        self.historical_rpc_url = historical_rpc_url
        self.historical_rpc_urls = tuple(historical_rpc_urls) if historical_rpc_urls is not None else None
        self.rpc_factory, self.inventory = rpc_factory, inventory
        self.cursor_codec = cursor_codec or CursorCodec(clock=clock)
        # Demand queue for pools a consumer asked to see. A public read may only
        # ask (an insert through a narrowly granted function); the worker that
        # indexes is a different role.
        self.requests = requests
        self.public_data = public_data
        self.transport_factory = transport_factory
        self.catalogue = catalogue
        if market_cache is None:
            from market_cache import MarketCache
            from market_data import GeckoMarketData
            market_cache = MarketCache(GeckoMarketData(clock=clock))
        self.market_cache = market_cache
        if snapshot is None:
            from markets_snapshot import MarketsSnapshot
            snapshot = MarketsSnapshot(clock=clock, wall_clock=clock)
        self.snapshot = snapshot
        # Validate configuration at startup, without sending network requests.
        if inventory_url:
            AlchemyInventory(inventory_url)

    @property
    def inventory_configured(self):
        return bool(self.inventory_url or self.inventory)

    def _rpc(self, transport, *, historical=False):
        check_read_deadline()
        if self.rpc_factory:
            return self.rpc_factory()
        if historical and (self.historical_rpc_urls or self.historical_rpc_url):
            return HistoricalReadRpc(self.historical_rpc_urls or (self.historical_rpc_url,),
                                     transport=transport, batch_reads=True)
        if self.rpc_urls is not None:
            return FailoverReadRpc(self.rpc_urls, transport=transport, batch_reads=True)
        return ReadRpc(self._endpoints(), transport=transport, batch_reads=True)

    def _endpoints(self):
        """The configured route; a service with none is refused, never sent to a default."""
        if self.rpc_urls:
            return self.rpc_urls
        if not self.rpc_url:
            raise DataError('rpc_unconfigured')
        return self.rpc_url

    def sequence_snapshot(self, owner, token_id=None):
        """Use only the configured primary Domino node; never public failover."""
        if self.rpc_factory is not None:  # An injected, explicit test double.
            return sequence_snapshot(self._rpc(self.transport_factory()), owner, token_id)
        if self.snapshot_rpc_version != 4 or not self.rpc_urls:
            raise DataError('upstream_unavailable')
        try:
            primary = rpc_endpoint(self.rpc_urls[0], (LOCAL_RPC_HOST,))
        except DataError:
            raise DataError('upstream_unavailable') from None
        if self.snapshot_loopback:
            return sequence_snapshot(ReadRpc(SNAPSHOT_LOOPBACK_RPC,
                                             transport=bounded_snapshot_loopback_transport(),
                                             batch_reads=True), owner, token_id)
        return sequence_snapshot(ReadRpc(primary, transport=self.transport_factory(), batch_reads=True),
                                 owner, token_id)

    def _market(self, kind, pool_id, **kwargs):
        check_read_deadline()
        result = self.market_cache.get(kind, pool_id, **kwargs)
        # Cache fallback cannot turn a timed-out request into stale success, or
        # permit a second provider call after the first spent the read budget.
        check_read_deadline()
        return result

    def _request_public(self, kind, entity_id):
        """A legacy live read also records aggregate interest when configured.

        The new stored API reports durable admission explicitly. An optional
        queue outage must not erase a legacy live response or grant table writes.
        """
        service = getattr(self, 'public_data', None)
        if service is not None:
            try:
                service.repository.request(kind, entity_id)
            except DataError:
                pass

    @public_response('pools')
    def pools(self, token, max_pools=12, pool_ids=(), *, paired_token=None):
        token=address(token)
        self._request_public('token', token)
        paired_token=address(paired_token) if paired_token is not None else None
        candidates=[]
        status={'status':'not_configured','completeHistory':False}
        if self.catalogue:
            try:
                page=self.catalogue.lookup(token,limit=100,paired_token=paired_token)
                candidates=page['items']
                status={key:value for key,value in page.items() if key!='items'}
                status.update(status='available',candidatesLoaded=len(candidates))
            except DataError as error:
                status={'status':'unavailable','reason':str(error),'completeHistory':False}
        transport = self.transport_factory()
        return discover(token, max_pools=max_pools, rpc=self._rpc(transport),
                        transport=transport, clock=self.clock, pool_ids=pool_ids,
                        catalogue_candidates=candidates,catalogue_status=status,paired_token=paired_token)

    @public_response('catalogue')
    def catalogue_page(self, token, *, limit=20, after=None, revision=None, paired_token=None):
        if not self.catalogue:
            raise DataError('catalogue_not_configured')
        return {'schemaVersion':1,'mode':'stored_catalogue_candidates',
                **self.catalogue.lookup(token,limit=limit,after=after,revision=revision,paired_token=paired_token)}

    @public_response('pool-activity')
    def pool_activity(self, pool_id, *, include_positions=False):
        from activity_store import PgActivity
        if not self.catalogue:
            raise DataError('catalogue_not_configured')
        store=PgActivity(self.catalogue)
        try:
            report=store.read(pool_id,include_positions=True) if include_positions else store.read(pool_id)
        except DataError as error:
            if str(error) not in ('activity_pool_not_registered','activity_not_indexed'):
                raise
            # A pool the ledger does not hold yet still deserves to be served:
            # ask for it, then serve the live window when its creation is
            # already verified. A pool nobody has anchored, or one whose live
            # window cannot be built, keeps today's answer rather than turning
            # "not indexed" into a provider error.
            self.request_pool(pool_id)
            anchor=self.registered_anchor(pool_id)
            if anchor is None:
                raise
            try:
                return self.live_window_activity(pool_id,anchor)
            except DataError as live_error:
                if str(live_error) in self.LIVE_WINDOW_UNSERVABLE:
                    raise error from None
                raise
        rpc=self._rpc(self.transport_factory())
        reader=DiscoveryReader(rpc,clock=self.clock)
        head=reader.snapshot()
        snap=report['snapshot']
        stored=Block(snap['number'],snap['hash'],snap['timestamp'])
        actual=parse_block(rpc.request('eth_getBlockByNumber',[stored.tag,False]))
        if actual!=stored or stored.number>head.number or stored.timestamp>head.timestamp:
            raise DataError('activity_snapshot_reorganized')
        reader.assert_canonical(head)
        age=max(0,int(self.clock())-stored.timestamp)
        report['coverage']['canonicality']='block_hash_rechecked'
        report['freshness']={'ageSeconds':age,'status':'fresh' if age<=120 else 'stale',
                             'checkedAgainstHead':head.number}
        report['window24h']['usableAsCurrent24h']=age<=120 and report['window24h']['completeWindow']
        return report

    LIVE_WINDOW_SECONDS = 86400
    # Read as a block count, not a duration: the chain's own recorded heads move
    # 7 to 13 blocks a second, so this bound reaches back hours. The response
    # reports the span it actually covered rather than claiming a day; the
    # margin only keeps the window start from passing its bound.
    LIVE_WINDOW_BLOCK_MARGIN = 120
    # Reasons that mean "this pool cannot be served live yet", as opposed to a
    # provider or transport failure that the caller should see as such.
    LIVE_WINDOW_UNSERVABLE = frozenset({'activity_pool_not_registered','invalid_pool_key',
                                        'invalid_pool_state','fixed_fee_mismatch',
                                        'initialize_anchor_not_found',
                                        'activity_window_start_after_snapshot'})

    def registered_anchor(self,pool_id):
        """The verified creation anchor, or None when the catalogue cannot say."""
        from activity_store import PgActivity
        if not self.catalogue:
            return None
        try:
            return PgActivity(self.catalogue).anchor(pool_id)
        except (DataError,AttributeError,TypeError):
            return None

    def live_window_activity(self,pool_id,anchor):
        """Exact last-24h window from live state, with no stored-ledger claim.

        This is the answer for a pool that is anchored but not walked yet: the
        active liquidity and fee growth come from the core state at a canonical
        block, and the window comes from the pool's own logs over a block range
        whose start timestamp proves every event is inside the window. Nothing
        here claims a stored model, a lifetime total or a revision.
        """
        from catalogue_indexer import IndexRpc
        from discovery import Block
        from pool_activity import protocol_directions, window_metrics

        # The window needs `eth_getLogs`, which the browser-facing read clients
        # deliberately lack; an injected factory (tests, alternate lanes) wins.
        rpc=self.rpc_factory() if self.rpc_factory else IndexRpc(
            self._endpoints(),
            transport=self.transport_factory(),max_requests=4096)
        reader=DiscoveryReader(rpc,clock=self.clock)
        block=reader.snapshot()
        pool=self._pool_identity(rpc,reader,pool_id,block,anchor)
        reader.assert_canonical(block)
        start_number=max(anchor['startBlock'],
                         block.number-self.LIVE_WINDOW_SECONDS-self.LIVE_WINDOW_BLOCK_MARGIN)
        lower=self._header(rpc,start_number)
        if lower.timestamp>block.timestamp:
            raise DataError('activity_window_start_after_snapshot')
        anchor_at=self._header(rpc,anchor['startBlock']).timestamp
        events=self._window_events(rpc,pool_id,lower.number,block)
        state={'number':block.number,'hash':block.hash,'timestamp':block.timestamp,
               'sqrtPriceX96':str(pool['sqrtPriceX96']),'tick':pool['tick'],
               'activeLiquidityRaw':str(self._active_liquidity(rpc,pool_id,block)),
               'protocolFeeRaw':pool['protocolFeeRaw'],
               'lpFeePips':pool['currentLpFeePips'],
               'feeGrowthGlobalX128':[str(value) for value in self._fee_growth(rpc,pool_id,block)]}
        # The read is bounded by blocks, and a block here is not a second: the
        # chain's own recorded heads move 7 to 13 blocks a second, so a range of
        # LIVE_WINDOW_SECONDS blocks reaches back hours, not a day. Report the
        # span the range actually covers, which is also what makes
        # range_bounded's precondition true - every event read lies inside it.
        covered=min(self.LIVE_WINDOW_SECONDS,max(1,block.timestamp-lower.timestamp))
        window=window_metrics(events,initialized_at=anchor_at,as_of=block.timestamp,
                              window_seconds=covered,range_bounded=True)
        age=max(0,int(self.clock())-block.timestamp)
        # A shorter span is never the current 24 hours, however complete it is.
        window['usableAsCurrent24h']=(age<=120 and window['completeWindow']
                                      and covered==self.LIVE_WINDOW_SECONDS)
        return {'schemaVersion':1,'methodologyVersion':1,'mode':'live_window_only',
                'chainId':CHAIN_ID,'poolId':bytes32(pool_id),'poolKey':pool['poolKey'],
                'revision':None,'accountingScope':'core_pool_events_only',
                'snapshot':state,
                'coverage':{'startBlock':anchor['startBlock'],'indexedThrough':None,
                            'initializedBlock':anchor['startBlock'],'initializedAt':anchor_at,
                            'scope':'live_window_only','canonicality':'block_hash_rechecked',
                            'rpcCompleteness':'single_provider_assumption',
                            'windowStartBlock':lower.number,'windowStartTimestamp':lower.timestamp},
                'freshness':{'ageSeconds':age,'status':'fresh' if age<=120 else 'stale',
                             'checkedAgainstHead':block.number},
                'window24h':window,
                'liquidity':{'status':'live_state_only',
                             'activeLiquidityRaw':state['activeLiquidityRaw'],
                             'rangeCount':None,'isTvl':False,'tvlUsd':None,
                             'tvlReason':'pool_activity_not_indexed',
                             'positionAccounting':{'methodologyVersion':1,'status':'unavailable',
                                                   'reason':'position_ledger_not_caught_up',
                                                   'lpAssetsRaw':None,'principalRaw':None,
                                                   'unsettledFeesRaw':None}},
                'fees':{'protocolDirectionalPips':protocol_directions(pool['protocolFeeRaw']),
                        'lpFeePipsAtSnapshot':pool['currentLpFeePips'],
                        'feeGrowthGlobalX128':state['feeGrowthGlobalX128'],
                        'growthIsTokenAmount':False,'growthIncludesDonations':True,
                        'accounting':{'methodologyVersion':1,'status':'unavailable',
                                      'reason':'fee_ledger_not_caught_up','lpFeesRaw':None,
                                      'protocolFeesRaw':None,'donationsRaw':None,
                                      'basis':'core_trading_fee_before_Q128_distribution_rounding',
                                      'isCollectedAmount':False,'isDominoServiceFee':False}},
                'storedEventCount':0,'suggested':False,'executionAvailable':False}

    @staticmethod
    def _header(rpc,number):
        from discovery import parse_block
        return parse_block(rpc.request('eth_getBlockByNumber',[hex(number),False]))

    def _pool_identity(self,rpc,reader,pool_id,block,anchor):
        """Core state plus a verified key: the manager cache first, then the log.

        The PositionManager's bytes25 cache only holds pools it has seen, so a
        pool created another way is refused as `invalid_pool_key`. The
        registered anchor already proved that identity from the pool's own
        Initialize log, so the same proof is used for the live state.
        """
        from catalogue import checked_key
        from catalogue_indexer import initialize_identity
        from discovery import STATE_VIEW

        candidate={'poolId':bytes32(pool_id),'poolKey':None,'currencies':None,'providerMetrics':None}
        try:
            return reader.pool(candidate,block)
        except DataError as error:
            # The cache either has no entry or an entry that is not this pool.
            if str(error) not in ('invalid_pool_key','pool_id_mismatch'):
                raise
        identity,_=initialize_identity(self._endpoints(),
                                       pool_id,anchor['startBlock'],rpc=rpc)
        key=checked_key(identity['poolKey'],bytes32(pool_id))
        sqrt,tick,protocol,lp_fee=rpc.call(STATE_VIEW,'getSlot0(bytes32)',['bytes32'],
                                           [bytes.fromhex(bytes32(pool_id)[2:])],
                                           ['uint160','int24','uint24','uint24'],block=block.tag)
        if not 0<sqrt<2**160 or not -887272<=tick<=887272 or lp_fee>1_000_000:
            raise DataError('invalid_pool_state')
        if key.fee_pips!=0x800000 and lp_fee!=key.fee_pips:
            raise DataError('fixed_fee_mismatch')
        return {**identity,'sqrtPriceX96':str(sqrt),'tick':tick,'currentLpFeePips':lp_fee,
                'protocolFeeRaw':protocol}

    def _active_liquidity(self,rpc,pool_id,block):
        from discovery import STATE_VIEW
        value,=rpc.call(STATE_VIEW,'getLiquidity(bytes32)',['bytes32'],
                        [bytes.fromhex(bytes32(pool_id)[2:])],['uint128'],block=block.tag)
        return value

    def _fee_growth(self,rpc,pool_id,block):
        from discovery import STATE_VIEW
        return rpc.call(STATE_VIEW,'getFeeGrowthGlobals(bytes32)',['bytes32'],
                        [bytes.fromhex(bytes32(pool_id)[2:])],['uint256','uint256'],block=block.tag)

    def _window_events(self,rpc,pool_id,from_block,block):
        """The pool's logs in the proved window, narrowed when a range is too big."""
        from discovery import POOL_MANAGER
        from pool_activity import TOPICS, decode_activity

        events,start,span=[],from_block,max(1,block.number-from_block)
        while start<block.number:
            end=min(start+span-1,block.number)
            try:
                logs=rpc.request('eth_getLogs',[{'address':POOL_MANAGER,'topics':[TOPICS,pool_id],
                                                'fromBlock':hex(start),'toBlock':hex(end)}])
            except DataError as error:
                if str(error) not in ('response_too_large','network_unavailable',
                                      'read_deadline_exceeded') or span<=1000:
                    raise
                span=max(1000,span//4)
                continue
            if not isinstance(logs,list) or len(logs)>2000:
                if span>1000:
                    span=max(1000,span//4)
                    continue
                raise DataError('activity_log_budget_exhausted')
            events.extend(decode_activity(raw,pool_id) for raw in logs)
            start=end+1
        return events

    def request_pool(self,pool_id,*,reason='read'):
        """Ask the durable queue for a pool; a read never fails because of it."""
        if self.requests is None:
            return False
        try:
            return self.requests.enqueue(pool_id,reason=reason)
        except (DataError,OSError):
            return False

    @public_response('pool-positions')
    def pool_positions(self,pool_id):
        report=self.pool_activity(pool_id,include_positions=True)
        # A live window holds no stored interval, so its coverage is a different
        # shape than this response declares and its positions are unavailable by
        # construction. Refuse with the code the caller already handles rather
        # than assembling a body that fails its own contract at the next hop.
        if report['mode']!='core_pool_activity_read_only':
            raise DataError('activity_not_indexed')
        positions=report['liquidity']['positionAccounting']
        if positions['status']!='reconciled_as_of':
            return {'schemaVersion':1,'mode':'core_pool_positions_read_only',
                    **{k:report[k] for k in ('chainId','poolId','poolKey','snapshot','coverage','freshness')},
                    'positionAccounting':positions,'executionAvailable':False}
        from nft_ownership import resolve_core_owners
        rpc = self._rpc(self.transport_factory(), historical=True)
        # Explicit per-read budget; never silently truncate a pool's known identities.
        rpc.max_requests = 600
        snap = report['snapshot']
        block = Block(snap['number'], snap['hash'], snap['timestamp'])
        reader = DiscoveryReader(rpc, clock=self.clock)
        head = reader.snapshot()
        if (parse_block(rpc.request('eth_getBlockByNumber', [block.tag, False])) != block or
                block.number > head.number or block.timestamp > head.timestamp):
            raise DataError('activity_snapshot_reorganized')
        positions['items'] = resolve_core_owners(rpc, report['poolId'], positions['items'], block)
        if parse_block(rpc.request('eth_getBlockByNumber', [block.tag, False])) != block:
            raise DataError('activity_snapshot_reorganized')
        reader.assert_canonical(head)
        positions['nftOwnershipResolved'] = bool(positions['items']) and all(
            p['nft']['nftOwnershipResolved'] for p in positions['items'])
        positions['nftOwnershipScope'] = 'historical_snapshot_not_current_wallet_authentication'
        return {'schemaVersion':1,'mode':'core_pool_positions_read_only',
                **{k:report[k] for k in ('chainId','poolId','poolKey','snapshot','coverage','freshness')},
                'positionAccounting':positions,'executionAvailable':False}

    @public_response('nft-positions')
    def nft_positions(self, token_ids, block_number=None):
        from nft_ownership import read_nft_position, token_id
        if not isinstance(token_ids, (list, tuple)) or not 1 <= len(token_ids) <= 10:
            raise DataError('invalid_nft_token_list')
        for value in token_ids: token_id(value)
        if len(set(token_ids)) != len(token_ids):
            raise DataError('duplicate_nft_token_ids')
        rpc = self._rpc(self.transport_factory(), historical=block_number is not None)
        reader = DiscoveryReader(rpc, clock=self.clock)
        head = reader.snapshot()
        if block_number is None:
            block = head
        else:
            if type(block_number) is not int or not 0 <= block_number <= min(head.number, 2**53-1):
                raise DataError('invalid_nft_snapshot_block')
            block = parse_block(rpc.request('eth_getBlockByNumber', [hex(block_number), False]))
            if block.number != block_number or block.timestamp > head.timestamp:
                raise DataError('invalid_nft_snapshot_block')
        items = [read_nft_position(rpc, value, block) for value in token_ids]
        if parse_block(rpc.request('eth_getBlockByNumber', [block.tag, False])) != block:
            raise DataError('nft_snapshot_reorganized')
        reader.assert_canonical(head)
        return {'schemaVersion': 1, 'mode': 'public_nft_positions_read_only', 'chainId': CHAIN_ID,
                'snapshot': asdict(block), 'items': items, 'requestedIdsOnly': True,
                'ownershipScope': 'owner_at_snapshot', 'walletControlVerified': False,
                'freshness': {'ageSeconds': max(0, int(self.clock())-block.timestamp),
                              'status': 'fresh' if self.clock()-block.timestamp <= 120 else 'stale'},
                'executionAvailable': False}

    @public_response('pool-metrics')
    def pool_metrics(self, pool_id):
        from metrics_service import stored_metrics
        if not self.catalogue:
            raise DataError('catalogue_not_configured')
        report = stored_metrics(self.catalogue, pool_id)
        rpc = self._rpc(self.transport_factory())
        reader = DiscoveryReader(rpc, clock=self.clock)
        head = reader.snapshot()
        snap = report['snapshot'];block = Block(snap['number'], snap['hash'], snap['timestamp'])
        if (parse_block(rpc.request('eth_getBlockByNumber', [block.tag, False])) != block or
                block.number > head.number or block.timestamp > head.timestamp):
            raise DataError('metrics_snapshot_reorganized')
        reader.assert_canonical(head)
        age = max(0, int(self.clock())-block.timestamp)
        report['freshness'] = {'ageSeconds': age, 'status': 'fresh' if age <= 120 else 'stale'}
        report['coverage']['canonicality'] = 'block_hash_rechecked'
        report['usableAsCurrent24h'] = (age <= 120 and report['capital']['complete24h'] and
                                       report['valuation']['status'] == 'qualified_historical_calculation' and
                                       report['valuation']['complete24h'] and
                                       report['valuation'].get('feeAprPercent') is not None)
        return report

    @public_response('pool-market')
    def pool_market(self, pool_id, *, include_price_history=False, price_token='base',
                    from_snapshot=False,allow_provider=True):
        """On-demand provider observations; no catalogue or history replay required.

        `from_snapshot` serves the stored verified pool state and market
        observation from the T2.1 snapshot without re-reading chain state
        (#156/T2.2). Its `issues` stay empty and its freshness is the
        snapshot's own; a not-built snapshot answers explicitly.
        """
        pool_id = bytes32(pool_id)
        self._request_public('pool', pool_id)
        if type(include_price_history) is not bool or type(allow_provider) is not bool or price_token not in ('base', 'quote'):
            raise DataError('invalid_market_query')
        if from_snapshot:
            if include_price_history:
                raise DataError('invalid_market_query')
            public_data = getattr(self,'public_data',None)
            if public_data is not None:
                from public_observations import aged_market
                row = public_data.repository.get('pool',pool_id)
                if row is not None and row['payload'] is not None:
                    return aged_market(row['payload'],row['observed_at'],int(self.clock()))
            with self.snapshot.lock:
                state = self.snapshot.state
                record = state['pools'].get(pool_id) if state else None
            if record is None:
                raise DataError('snapshot_not_built')
            pool = deepcopy(record['pool'])
            block = Block(**pool['snapshot'])
            market = deepcopy(record['market'])
            # Same wire shape as a fresh read; freshness is the snapshot's own.
            return {'schemaVersion': 1, 'mode': 'on_demand_provider_market', 'chainId': CHAIN_ID,
                    'poolId': pool_id, 'pool': pool, 'snapshot': asdict(block),
                    'market': market,
                    'priceHistory': {'status': 'not_requested', 'reason': None, 'data': None, 'cache': None},
                    'issues': [], 'requiresLocalHistory': False,
                    'providerMetricsReconciled': False, 'feeApr24h': None,
                    'aprReason': 'provider_lp_fee_history_unavailable',
                    'suggested': False, 'executionAvailable': False}
        reader = DiscoveryReader(self._rpc(self.transport_factory()), clock=self.clock)
        block = reader.snapshot()
        candidate = {'poolId':pool_id}
        # A known Initialize key also covers pools never seen by PositionManager.
        # It is still rehashed and its current state checked by DiscoveryReader.
        if self.catalogue is not None:
            try:
                with self.catalogue.connection() as conn:
                    stored = conn.execute('''SELECT pool_key FROM domino_catalogue.events WHERE pool_id=%s
                      UNION ALL SELECT pool_key FROM domino_catalogue.hints WHERE pool_id=%s LIMIT 1''',
                      (pool_id,pool_id)).fetchone()
                if stored:
                    candidate['poolKey'] = stored['pool_key']
            except (DataError, AttributeError, TypeError):
                pass
        pool = reader.pool(candidate, block)

        def matched(observation):
            data = observation.get('data')
            if data is not None and (type(data.get('chainId')) is not int or
                    data['chainId'] != CHAIN_ID or data.get('source') != 'geckoterminal' or
                    data.get('poolId') != pool_id or data.get('currencies') != pool['currencies'] or
                    {data.get('baseToken'), data.get('quoteToken')} != set(pool['currencies'])):
                return {**observation, 'status': 'rejected',
                        'reason': 'provider_currency_or_pool_mismatch', 'data': None}
            return observation

        market = matched(self._market('pool', pool_id,allow_provider=allow_provider))
        issues = []
        if market.get('data') and market['data'].get('dexLabel') != 'uniswap-v4-robinhood':
            issues.append('provider_dex_label_unconfirmed')
            # A PoolId does not include PoolManager: a fork may use the same key.
            market = {**market, 'status': 'rejected', 'reason': 'provider_dex_unconfirmed', 'data': None}
        history = {'status': 'not_requested', 'reason': None, 'data': None, 'cache': None}
        if include_price_history:
            if market.get('data') is None:
                history.update(status='unavailable', reason='provider_market_identity_unavailable')
            else:
                requested_currency = market['data'][price_token + 'Token']
                history = matched(self._market('hourly_prices', pool_id, token=price_token,
                                               currency=requested_currency,allow_provider=allow_provider))
                data = history.get('data')
                if data is not None and (data.get('selectedToken') != price_token or
                        data.get('currency') != requested_currency or
                        data.get('currency') != data.get(price_token + 'Token') or
                        any(data.get(side) != market['data'].get(side) for side in ('baseToken', 'quoteToken'))):
                    history = {**history, 'status': 'rejected',
                               'reason': 'provider_chart_currency_mismatch', 'data': None}
        reader.assert_canonical(block)
        # T2.2/T2.1: the verified pool identity/state and the matched provider
        # observation fold into the stored snapshot, so later reads serve it
        # without re-reading chain state. Only verified results are stored.
        self.snapshot.refresh(pool_id, pool, market)
        return {'schemaVersion': 1, 'mode': 'on_demand_provider_market', 'chainId': CHAIN_ID,
                'poolId': pool_id, 'pool': pool, 'snapshot': asdict(block),
                'market': market, 'priceHistory': history, 'issues': issues,
                'requiresLocalHistory': False, 'providerMetricsReconciled': False,
                'feeApr24h': None, 'aprReason': 'provider_lp_fee_history_unavailable',
                'suggested': False, 'executionAvailable': False}

    @public_response('markets-snapshot')
    def markets_snapshot(self, pool_ids=()):
        """Serve the stored snapshot; touches neither RPC nor providers (#155).

        Only an explicitly requested subset is returned (requested echo keeps
        the caller's evidence chain); unknown ids are absent, never invented.
        """
        if not isinstance(pool_ids, (list, tuple)) or len(pool_ids) > 24:
            raise DataError('invalid_snapshot_request')
        public_data = getattr(self,'public_data',None)
        if public_data is not None:
            repo = public_data.repository
            ids = list(pool_ids) if pool_ids else repo.snapshot_pool_ids()
            rows = repo.overview(pool_ids=ids)['pools']
            ready = [row for row in rows if row['payload'] is not None]
            if ready:
                from public_observations import aged_market
                now = int(self.clock())
                built = min(row['observed_at'] for row in ready)
                entries = []
                for row in ready:
                    value = aged_market(row['payload'],row['observed_at'],now)
                    entries.append({'poolId':row['entity_id'],'pool':value['pool'],
                                    'market':value['market'],'observedAt':row['observed_at']})
                age = max(0,now-built)
                return {'schemaVersion':1,'mode':'stored_markets_snapshot','chainId':CHAIN_ID,
                        'status':'stale' if age>300 else 'current','reason':'snapshot_refresh_pending' if age>300 else None,
                        'builtAt':built,'ageSeconds':age,'stale':age>300,'generated':False,
                        'requested':list(pool_ids),'pools':entries}
        return self.snapshot.serve(list(pool_ids) if pool_ids else None)


    @public_response('token')
    def token(self, token):
        token = address(token)
        reader = DiscoveryReader(self._rpc(self.transport_factory()), clock=self.clock)
        block = reader.snapshot()
        asset = reader.token_lookup(token, block)
        reader.assert_canonical(block)
        return {'schemaVersion': 1, 'mode': 'public_token_read_only', 'chainId': CHAIN_ID,
                'snapshot': asdict(block), 'asset': asset, 'liveExecution': False}

    def _inventory_page(self, provider, wallet, key):
        """The provider's first page for this wallet, reused while fresh; later pages always go to it.

        At most INVENTORY_CONCURRENCY provider calls run at once. A caller waits
        up to INVENTORY_WAIT_SECONDS for one, then gets a page up to
        INVENTORY_STALE_SECONDS old, or provider_capacity_busy, and the balances
        of the tokens it named still.
        A page reports when the provider returned it (retrievedAt), cached or not;
        wallet_assets only reads it.
        """
        cache_key = (wallet, provider.context) if key is None else None
        with self._inventory_lock:
            cached = self._inventory_pages.get(cache_key) if cache_key else None
        age = self.clock() - cached['retrievedAt'] if cached else None
        if cached and age < INVENTORY_FRESH_SECONDS:
            return cached
        if not self._inventory_slot.acquire(timeout=INVENTORY_WAIT_SECONDS):
            if cached and age < INVENTORY_STALE_SECONDS:
                return cached
            raise DataError('provider_capacity_busy')
        try:
            page = provider.page(wallet, key)
        finally:
            self._inventory_slot.release()
        if cache_key:
            with self._inventory_lock:
                self._inventory_pages[cache_key] = page
                self._inventory_pages.move_to_end(cache_key)
                while len(self._inventory_pages) > INVENTORY_CACHE_SIZE:
                    self._inventory_pages.popitem(last=False)
        return page

    @public_response('wallet-assets')
    def wallet_assets(self, wallet, tokens=(), *, auto_discover=True, cursor=None):
        wallet = address(wallet)
        if not isinstance(tokens, (list, tuple)) or len(tokens) > 10:
            raise DataError('invalid_token_list')
        tokens = sorted(set(address(token) for token in tokens) - {ZERO})
        transport = self.transport_factory()
        provider = self.inventory or (AlchemyInventory(self.inventory_url, transport=transport, clock=self.clock)
                                      if self.inventory_url else None)
        if cursor and (not provider or not auto_discover):
            raise DataError('invalid_or_expired_cursor')
        key = self.cursor_codec.read(cursor, wallet, tokens, provider.context) if cursor else None
        inventory = {'status': 'not_configured' if auto_discover else 'not_requested',
                     'source': 'alchemy' if provider else None, 'asOfBlock': None,
                     'coverage': 'unknown', 'hasMore': None, 'nextCursor': None}
        candidates = []
        skipped_candidates = 0
        reader = DiscoveryReader(self._rpc(transport), clock=self.clock)
        if auto_discover and provider:
            try:
                check_read_deadline()
                page = self._inventory_page(provider, wallet, key)
                check_read_deadline()
                candidates = page['currencies']
                # Bound the candidates probed on-chain so a full provider page
                # cannot exceed the RPC budget (#149). Each probed erc20
                # candidate costs four reads (code, decimals, symbol, balance);
                # the snapshot costs seven, the native balance and the final
                # canonical re-read one each, and twelve items stay reserved.
                reserved = 12 + 4 * len(tokens)
                probed_budget = max(0, (getattr(reader.rpc, 'max_requests', 160) - reserved) // 4)
                probed = candidates[:min(len(candidates), probed_budget)]
                skipped_candidates = len(candidates) - len(probed)
                candidates = probed
                next_cursor = (self.cursor_codec.issue(wallet, tokens, provider.context, page['nextKey'])
                               if page['nextKey'] else None)
                inventory.update(status='page_received', coverage='provider_page_only',
                                 hasMore=bool(page['nextKey']), nextCursor=next_cursor,
                                 retrievedAt=page['retrievedAt'], rowsReceived=page['rowsReceived'],
                                 excludedRows=page['excludedRows'],
                                 candidatesProbed=len(candidates),
                                 candidatesSkipped=skipped_candidates,
                                 skippedReason='request_budget_exhausted' if skipped_candidates else None)
            except DataError as error:
                inventory.update(status='unavailable', reason=str(error))
        block = reader.snapshot()  # Fresh balances after the indexed candidate page.
        items, failed = [], []
        currencies = list(dict.fromkeys([ZERO] + tokens + candidates))
        try:
            items, failed = self._probe_currencies(reader, block, wallet, currencies, tokens, candidates)
        except DataError as error:
            if str(error) != 'rpc_batch_unavailable':
                raise
            # Batched probing is unavailable on this transport: fall back to
            # the sequential per-currency path, one currency per call so a
            # broken token still preserves the other balances.
            items, failed = [], []
            for currency in currencies:
                try:
                    metadata = reader.token(currency, block)
                    if currency == ZERO:
                        raw = reader.balances(wallet, [], block)['items'][0]['amountRaw']
                    else:
                        raw, = reader.rpc.call(currency, 'balanceOf(address)', ['address'], [wallet],
                                               ['uint256'], block=block.tag)
                        raw = str(raw)
                    items.append({**metadata, 'amountRaw': raw, 'balanceStatus': 'read_at_block',
                                  'requestedByAddress': currency in tokens,
                                  'discoveredByProvider': currency in candidates,
                                  'executionAvailable': False})
                except DataError as error:
                    failed.append({'currency': currency, 'reason': str(error)})
        reader.assert_canonical(block)
        return {'schemaVersion': 2, 'mode': 'public_address_read_only', 'chainId': CHAIN_ID,
                'snapshot': asdict(block), 'items': items, 'unavailableAssets': failed,
                'balanceCoverage': 'requested_and_page_addresses_only', 'inventory': inventory,
                'walletControlVerified': False, 'liveExecution': False}

    def _probe_currencies(self, reader, block, wallet, currencies, tokens, candidates):
        """Batched per-candidate reads: code, then decimals/symbol/balance (#148).

        A refused read is delivered in that item's position (batch item_errors),
        so one wallet-hostile token — an airdropped contract whose decimals()
        reverts — costs its own metadata issue and nothing else; it can no
        longer fail the envelope and poison the failover for the whole read.
        An envelope failure proper (transport, malformed reply) still falls
        back to sequential reads for that chunk, and under the failover
        transport is poisoned closed instead. Metadata mirrors
        DiscoveryReader.token: a failed optional read becomes a metadata issue
        and the token stays 'partial'.
        """
        rpc = reader.rpc
        if getattr(rpc, 'batch_reads', False) is not True:
            raise DataError('rpc_batch_unavailable')
        erc20 = [currency for currency in currencies if currency != ZERO]
        has_code, meta = {}, {}
        for currency in erc20:
            meta[currency] = {'decimals_raw': None, 'symbol_raw': None, 'issues': {}}

        def staged(signature, inputs, outputs, values=()):
            """Run one read for every live currency; per-currency errors are kept."""
            # The code stage probes everyone; only later stages gate on its answer.
            live = [currency for currency in erc20 if signature is None or has_code.get(currency)]
            for index in range(0, len(live), 8):
                chunk = live[index:index + 8]
                if signature is None:
                    specs = [('eth_getCode', [currency, block.tag]) for currency in chunk]
                else:
                    specs = [('eth_call', rpc.call_params(currency, signature, inputs, values, block=block.tag))
                             for currency in chunk]
                try:
                    results = rpc.batch(specs, item_errors=True)
                except DataError:
                    results = []
                    for currency in chunk:
                        try:
                            results.append(rpc.request('eth_getCode' if signature is None else 'eth_call',
                                                       [currency, block.tag] if signature is None else
                                                       rpc.call_params(currency, signature, inputs, values, block=block.tag)))
                        except DataError as error:
                            results.append(error)
                for currency, result in zip(chunk, results):
                    yield currency, result

        for currency, result in staged(None, (), []):
            has_code[currency] = isinstance(result, str) and bool(re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+', result or ''))
            if not has_code[currency]:
                meta[currency]['dead'] = ('token_has_no_code' if result == '0x'
                                          else 'token_code_unavailable')
        for signature, inputs, values, outputs, key in (
                ('decimals()', (), (), ['uint8'], 'decimals_raw'),
                ('symbol()', (), (), [], 'symbol_raw'),
                ('balanceOf(address)', ['address'], [wallet], ['uint256'], 'balance_raw')):
            for currency in erc20:
                meta[currency].setdefault(key, None)
            for currency, result in staged(signature, inputs, outputs, values):
                if isinstance(result, DataError):
                    if key == 'balance_raw':
                        meta[currency][key] = result
                    else:
                        meta[currency]['issues'][key.removesuffix('_raw')] = str(result)
                else:
                    meta[currency][key] = result

        items, failed = [], []
        for currency in currencies:
            if currency == ZERO:
                try:
                    raw = reader.balances(wallet, [], block)['items'][0]['amountRaw']
                except DataError as error:
                    failed.append({'currency': currency, 'reason': str(error)})
                    continue
                items.append({**reader.token(ZERO, block), 'amountRaw': raw, 'balanceStatus': 'read_at_block',
                              'requestedByAddress': True, 'discoveredByProvider': False,
                              'executionAvailable': False})
                continue
            record = meta.get(currency)
            if record is None or record.get('dead'):
                failed.append({'currency': currency,
                               'reason': record.get('dead', 'token_has_no_code') if record else 'token_has_no_code'})
                continue
            try:
                # A contract may answer balanceOf with success and no data
                # rather than revert. The spoofed "ETH"/"USDG" contracts that
                # emit fake transfers from a wallet do, and they reach its
                # provider page (found 27 Sep 2026). As on the sequential path,
                # that balance fails this asset, never the whole read.
                raw, = decode_result(['uint256'], prefetched(record['balance_raw']))
            except DataError as error:
                failed.append({'currency': currency, 'reason': str(error)})
                continue
            decimals, symbol, issues = None, None, dict(record['issues'])
            try:
                if isinstance(issues.get('decimals'), str):
                    raise DataError(issues['decimals'])
                decimals, = decode_result(['uint8'], record['decimals_raw'])
                if type(decimals) is not int or not 0 <= decimals <= 255:
                    raise DataError('invalid_token_decimals')
            except DataError as error:
                issues['decimals'] = str(error)
                decimals = None
            try:
                if isinstance(issues.get('symbol'), str):
                    raise DataError(issues['symbol'])
                raw_symbol = self._decode_symbol(record['symbol_raw'])
                if not isinstance(raw_symbol, str) or not raw_symbol or len(raw_symbol) > 40 or not raw_symbol.isprintable():
                    raise DataError('invalid_symbol_text')
                symbol = raw_symbol
            except DataError as error:
                issues['symbol'] = str(error)
                symbol = None
            items.append({'address': currency, 'kind': 'erc20_candidate', 'decimals': decimals, 'symbol': symbol,
                          'readStatus': 'partial' if issues else 'available', 'metadataIssues': issues,
                          'displayUnitsAvailable': decimals is not None, 'executionAvailable': False,
                          'amountRaw': str(raw), 'balanceStatus': 'read_at_block',
                          'requestedByAddress': currency in tokens,
                          'discoveredByProvider': currency in candidates})
        return items, failed

    @staticmethod
    def _decode_symbol(raw):
        if isinstance(raw, str) and len(raw) == 66:
            value, = decode_result(['bytes32'], raw)
            try:
                return value.rstrip(b'\x00').decode('utf-8')
            except UnicodeError:
                raise DataError('invalid_symbol_text') from None
        value, = decode_result(['string'], raw)
        return value
