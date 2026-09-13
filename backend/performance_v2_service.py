"""Session-authorized enrollment, saved snapshots and exact financial projections."""
import time

from discovery import DataError, ZERO
from performance_service import PerformanceService
from performance_history_projection import build_financial_projection
from performance_store import PerformanceStoreError
from performance_valuation import ManagedValuation, _Asset, load_managed_valuation
import performance_v2_models as m
from read_deadline import check_read_deadline


def unavailable_valuation(bundle, reason='event_time_valuation_unavailable'):
    base, head = bundle['epoch']['baseline'], bundle['financial']
    end = head['cursor']['timestamp'] if head else base['baseline']['timestamp']
    start = max(base['baseline']['timestamp'],end-86400)
    if 'valuationBounds' in bundle: start,end=bundle['valuationBounds']['start'],bundle['valuationBounds']['end']
    return ManagedValuation(base['opening']['poolId'],start,end,
        {currency: _Asset(None,(),(),reason) for currency in set(base['opening']['currencies']+[ZERO])})


class StoredValuation:
    """Read only existing admitted price observations, never fetch or qualify one."""
    def __init__(self, connection):
        self.connection = connection

    def __call__(self, bundle):
        base, head = bundle['epoch']['baseline'], bundle['financial']
        end = head['cursor']['timestamp'] if head else base['baseline']['timestamp']
        start = max(base['baseline']['timestamp'],end-86400)
        if 'valuationBounds' in bundle: start,end=bundle['valuationBounds']['start'],bundle['valuationBounds']['end']
        try:
            with self.connection() as conn:
                return load_managed_valuation(conn,pool_id=base['opening']['poolId'],
                    currencies=sorted(set(base['opening']['currencies']+[ZERO])),start=start,end=end)
        except (DataError, OSError):
            check_read_deadline()
            return unavailable_valuation(bundle,'performance_price_store_unavailable')


def _missing(epoch):
    return {'epochId':epoch,'kind':'not_found','collectionStatus':'unavailable','collectionReason':'epoch_not_found',
        'performanceStatus':'unavailable','performanceReasons':['epoch_not_found'],
        'metrics':{field:None for field in m.Metrics.model_fields},'complete24h':False,'executionAvailable':False}


class PerformanceV2Service:
    def __init__(self, auth, enrollments, history, valuation, admission, *, clock=time.time, projection=None, projection_refresh=None):
        self.auth,self.enrollments,self.history,self.valuation,self.admission,self.clock = auth,enrollments,history,valuation,admission,clock
        self.projection,self.projection_refresh=projection,projection_refresh

    def _card(self, owner, epoch, now):
        try:
            bundle = (self.history.read_projection_window(owner,epoch) if self.projection is not None
                      else self.history.read_financial_window(owner,epoch))
        except PerformanceStoreError as error:
            if error.code == 'performance_not_found': return _missing(epoch)
            raise
        row = bundle['epoch']
        card = PerformanceService._project(row,owner,[epoch],now)
        result = (self.projection or build_financial_projection)(bundle,self.valuation(bundle),now)
        if result.get('dirtyBuckets') and self.projection_refresh is not None:
            self.projection_refresh(owner,epoch,result['replayGeneration'],result['dirtyBuckets'])
        if (result['owner'],result['epochId'],result['rawRevision'],result['replayGeneration']) != (owner,epoch,card['revision'],card['replayGeneration']):
            raise m.Error('upstream_invalid_response')
        performance = result['performance']
        status = performance['status']
        metrics = {field: performance.get(field) for field in m.Metrics.model_fields}
        for field in ('externalDepositsUsd','externalWithdrawalsUsd','reinvestedUsd'):
            metrics[field] = result[field]
        reasons = sorted(set(performance['issues']) | set(result['projectionIssues']))
        if card['collectionStatus'] in ('partial','unavailable'):
            status = 'unavailable'
        elif card['collectionStatus'] == 'stale' and status != 'unavailable':
            status = 'stale'
            reasons = sorted(set(reasons)|{card['collectionReason']})
        if status == 'unavailable': metrics = {field:None for field in metrics}
        if status != 'available':
            metrics['grossFeeAprPercent'] = metrics['netFeeAprPercent'] = None
        card.update(performanceStatus=status,performanceReasons=reasons,metrics=metrics,
            complete24h=performance['complete24h'] and status not in ('unavailable','partial'),
            financial={'methodologyVersion':1,'financialRevision':result['financialRevision'],
                'snapshot':{key:result['financialCursor'][key] for key in ('blockNumber','blockHash','timestamp')},
                'windowStart':result['windowStart'],'windowEnd':result['windowEnd'],
                'observedSeconds':result['windowEnd']-result['windowStart'],
                'externalFlowsComplete':result['externalFlowCoverage']['complete'],
                'operatorCostsReason':performance['operatorCostsReason']})
        return card

    def execute(self, route, body, *, client, session, csrf):
        request = m.validate_request(route,body)
        context = self.auth.begin(client,session,csrf)
        owner = context['owner']
        now = PerformanceService._now(self)
        try:
            check_read_deadline()
            if route == 'enroll':
                code_hash = self.admission(owner,request['vault'])
                if code_hash is None: raise m.Error('performance_subject_not_admitted')
                value = {'enrollment':self.enrollments.enroll(owner,request,code_hash)}
            elif route == 'epochs':
                value = self.enrollments.visible(owner,after=request['after'])
            else:
                # Refresh only enrolled owner subjects; raw/private orphan IDs are not card authority.
                visible = self.enrollments.visible(owner,epoch_ids=request['epochIds'])
                bound = {row['epochId'] for row in visible['enrollments']}
                value = {'cards':[self._card(owner,epoch,now) if epoch in bound else _missing(epoch)
                                  for epoch in request['epochIds']]}
            self.auth.finish(context)
            check_read_deadline()
            return m.validate_response(route,{'contractVersion':m.CONTRACT_VERSION,'chainId':4663,'owner':owner,
                'refreshAfterSeconds':30 if route != 'cards' or any(c['performanceStatus']=='measuring' for c in value['cards']) else 60,
                'executionAvailable':False,**value})
        except PerformanceStoreError as error:
            raise m.Error('invalid_request' if error.code=='performance_invalid_request' else 'performance_store_unavailable') from None
