"""Stored public overview/search/history with narrowly scoped demand admission."""
import time

from discovery import address, bytes32
from pool_apr_contract import build_pool_market_estimate
from public_data_contract import REQUEST_MODELS, validate_response
from public_observations import aged_market


def acquisition(row):
    if row is None:
        return {'status':'pending','refreshing':False,'reason':None,'nextAttemptAt':None}
    return {'status':row['status'], 'refreshing':row.get('lease_token') is not None,
            'reason':row.get('last_error'),
            'nextAttemptAt':int(row['next_due'].timestamp()) if row.get('next_due') else None}


def token_item(row, token):
    return {'address':token, 'value':row.get('payload') if row else None,
            'observedAt':row.get('observed_at') if row else None,
            'acquisition':acquisition(row)}


class PublicDataService:
    def __init__(self, repository, *, clock=time.time, history_store=None):
        self.repository, self.clock = repository, clock
        if history_store is None:
            from public_history import PublicHistory
            history_store = PublicHistory(repository.catalogue)
        self.history_store = history_store

    def overview(self, *, token=None, poolIds=(), afterPoolId=None, revision=None, limit=24):
        body = {'token':token,'poolIds':list(poolIds),'afterPoolId':afterPoolId,'revision':revision,'limit':limit}
        REQUEST_MODELS['overview'].model_validate(body, strict=True)
        token = address(token) if token is not None else None
        ids = [bytes32(pool_id) for pool_id in poolIds]
        accepted = True
        if token is not None:
            accepted = self.repository.request('token', token)
        else:
            accepted = self.repository.request_many('pool',ids)
        page = self.repository.overview(token=token, pool_ids=ids, after=afterPoolId,
                                        limit=limit, revision=revision)
        if token is not None:
            # Only the returned page represents current browser interest. The
            # token's metadata TTL is independent from its visible pool state.
            page_accepted = self.repository.request_many('pool',page['poolIds'])
            accepted = page_accepted and accepted
        now = int(self.clock())
        tokens = [token_item(row, row['entity_id']) for row in page['tokens']]
        if token is not None and token not in {item['address'] for item in tokens}:
            tokens.append(token_item(None, token))
        stored = {row['entity_id']:row for row in page['pools']}
        pools = []
        for pool_id in page['poolIds']:
            row = stored.get(pool_id)
            value = None
            if row and row['payload']:
                market = aged_market(row['payload'], row['observed_at'], now)
                value = build_pool_market_estimate(market, now=now, requested_pool_id=pool_id)
            pools.append({'poolId':pool_id,'value':value,
                          'observedAt':row['observed_at'] if row else None,
                          'acquisition':acquisition(row)})
        result = {'schemaVersion':1,'chainId':4663,'mode':'stored_public_overview',
                  'generatedAt':now,'selectedToken':token,'requestedPoolIds':ids,
                  'acquisitionAccepted':accepted,'revision':page['revision'],
                  'hasMore':page['hasMore'],'nextAfterPoolId':page['nextAfter'],
                  'discoveryCoverage':'known_verified_pools_only','completeHistory':False,
                  'tokens':tokens,'pools':pools,'executionAvailable':False}
        return validate_response('overview',result)

    def search(self, *, query, limit=20):
        REQUEST_MODELS['search'].model_validate({'query':query,'limit':limit}, strict=True)
        rows = self.repository.search(query, limit=limit)
        return validate_response('search',{'schemaVersion':1,'chainId':4663,'query':query,
            'coverage':'known_verified_tokens_only',
            'tokens':[token_item(row,row['entity_id']) for row in rows], 'executionAvailable':False})

    def history(self, *, poolId, currency, windowSeconds=86400, resolutionSeconds=3600):
        REQUEST_MODELS['history'].model_validate(dict(poolId=poolId,currency=currency,
            windowSeconds=windowSeconds,resolutionSeconds=resolutionSeconds), strict=True)
        accepted = self.repository.request('pool',poolId)
        accepted = self.history_store.request(poolId,windowSeconds) and accepted
        result = self.history_store.read(poolId,currency,windowSeconds,resolutionSeconds)
        result['acquisitionAccepted'] = accepted
        return validate_response('history',result)
