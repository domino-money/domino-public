"""Read orchestration with optional public catalogue; no accounts or signer."""
from dataclasses import asdict
from copy import deepcopy
from functools import wraps
import time

from discovery import (CHAIN_ID, RPC_URL, ZERO, DataError, DiscoveryReader,
                       ReadRpc, Block, address, bytes32, discover, json_http, parse_block)
from inventory import AlchemyInventory, CursorCodec
from rpc_failover import FailoverReadRpc
from read_deadline import (ReadDeadline, check_read_deadline, current_read_deadline,
                           use_read_deadline)


# These are known transport failures, not a fallback for arbitrary producer text.
_HTTP_REASONS = {f'http_{code}': 'upstream_unavailable'
                 for code in (400, 401, 403, 404, 408, 500, 502, 503, 504)}
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
            return json_http(url, body, timeout=active.timeout(8))
    return transport


class ReadService:
    def __init__(self, *, rpc_url=RPC_URL, rpc_urls=None, inventory_url=None, clock=time.time,
                 rpc_factory=None, inventory=None, cursor_codec=None, transport_factory=bounded_transport,
                 catalogue=None, market_cache=None):
        self.rpc_url, self.inventory_url, self.clock = rpc_url, inventory_url, clock
        self.rpc_urls = tuple(rpc_urls) if rpc_urls is not None else None
        self.rpc_factory, self.inventory = rpc_factory, inventory
        self.cursor_codec = cursor_codec or CursorCodec(clock=clock)
        self.transport_factory = transport_factory
        self.catalogue = catalogue
        if market_cache is None:
            from market_cache import MarketCache
            from market_data import GeckoMarketData
            market_cache = MarketCache(GeckoMarketData(clock=clock))
        self.market_cache = market_cache
        # Validate configuration at startup, without sending network requests.
        if inventory_url:
            AlchemyInventory(inventory_url)

    @property
    def inventory_configured(self):
        return bool(self.inventory_url or self.inventory)

    def _rpc(self, transport):
        check_read_deadline()
        if self.rpc_factory:
            return self.rpc_factory()
        if self.rpc_urls is not None:
            return FailoverReadRpc(self.rpc_urls, transport=transport)
        return ReadRpc(self.rpc_url, transport=transport)

    def _market(self, kind, pool_id, **kwargs):
        check_read_deadline()
        result = self.market_cache.get(kind, pool_id, **kwargs)
        # Cache fallback cannot turn a timed-out request into stale success, or
        # permit a second provider call after the first spent the read budget.
        check_read_deadline()
        return result

    @public_response('pools')
    def pools(self, token, max_pools=12, pool_ids=(), *, paired_token=None):
        token=address(token)
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
        report=store.read(pool_id,include_positions=True) if include_positions else store.read(pool_id)
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

    @public_response('pool-positions')
    def pool_positions(self,pool_id):
        report=self.pool_activity(pool_id,include_positions=True)
        positions=report['liquidity']['positionAccounting']
        if positions['status']!='reconciled_as_of':
            return {'schemaVersion':1,'mode':'core_pool_positions_read_only',
                    **{k:report[k] for k in ('chainId','poolId','poolKey','snapshot','coverage','freshness')},
                    'positionAccounting':positions,'executionAvailable':False}
        from nft_ownership import resolve_core_owners
        rpc = self._rpc(self.transport_factory())
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
        rpc = self._rpc(self.transport_factory())
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
    def pool_market(self, pool_id, *, include_price_history=False, price_token='base'):
        """On-demand provider observations; no catalogue or history replay required."""
        pool_id = bytes32(pool_id)
        if type(include_price_history) is not bool or price_token not in ('base', 'quote'):
            raise DataError('invalid_market_query')
        reader = DiscoveryReader(self._rpc(self.transport_factory()), clock=self.clock)
        block = reader.snapshot()
        pool = reader.pool({'poolId': pool_id}, block)

        def matched(observation):
            data = observation.get('data')
            if data is not None and (type(data.get('chainId')) is not int or
                    data['chainId'] != CHAIN_ID or data.get('source') != 'geckoterminal' or
                    data.get('poolId') != pool_id or data.get('currencies') != pool['currencies'] or
                    {data.get('baseToken'), data.get('quoteToken')} != set(pool['currencies'])):
                return {**observation, 'status': 'rejected',
                        'reason': 'provider_currency_or_pool_mismatch', 'data': None}
            return observation

        market = matched(self._market('pool', pool_id))
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
                history = matched(self._market('hourly_prices', pool_id, token=price_token))
                data = history.get('data')
                if data is not None and (data.get('selectedToken') != price_token or
                        data.get('currency') != data.get(price_token + 'Token') or
                        any(data.get(side) != market['data'].get(side) for side in ('baseToken', 'quoteToken'))):
                    history = {**history, 'status': 'rejected',
                               'reason': 'provider_chart_currency_mismatch', 'data': None}
        reader.assert_canonical(block)
        return {'schemaVersion': 1, 'mode': 'on_demand_provider_market', 'chainId': CHAIN_ID,
                'poolId': pool_id, 'pool': pool, 'snapshot': asdict(block),
                'market': market, 'priceHistory': history, 'issues': issues,
                'requiresLocalHistory': False, 'providerMetricsReconciled': False,
                'feeApr24h': None, 'aprReason': 'provider_lp_fee_history_unavailable',
                'suggested': False, 'executionAvailable': False}


    @public_response('token')
    def token(self, token):
        reader = DiscoveryReader(self._rpc(self.transport_factory()), clock=self.clock)
        block = reader.snapshot()
        asset = reader.token_lookup(token, block)
        reader.assert_canonical(block)
        return {'schemaVersion': 1, 'mode': 'public_token_read_only', 'chainId': CHAIN_ID,
                'snapshot': asdict(block), 'asset': asset, 'liveExecution': False}

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
        if auto_discover and provider:
            try:
                check_read_deadline()
                page = provider.page(wallet, key)
                check_read_deadline()
                candidates = page['currencies']
                next_cursor = (self.cursor_codec.issue(wallet, tokens, provider.context, page['nextKey'])
                               if page['nextKey'] else None)
                inventory.update(status='page_received', coverage='provider_page_only',
                                 hasMore=bool(page['nextKey']), nextCursor=next_cursor,
                                 retrievedAt=page['retrievedAt'], rowsReceived=page['rowsReceived'],
                                 excludedRows=page['excludedRows'])
            except DataError as error:
                inventory.update(status='unavailable', reason=str(error))
        reader = DiscoveryReader(self._rpc(transport), clock=self.clock)
        block = reader.snapshot()  # Fresh balances after the indexed candidate page.
        items, failed = [], []
        currencies = list(dict.fromkeys([ZERO] + tokens + candidates))
        for currency in currencies:
            try:
                metadata = reader.token(currency, block)
                # One currency per call lets a broken token preserve other balances.
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
