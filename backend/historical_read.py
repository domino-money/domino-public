"""Explicit projection of unpublished worker diagnostics into pinned read-v1.

Only known incomplete operational states are projected. Source, checkpoint and
on-chain inconsistencies remain errors; the operator's raw report is unchanged.
"""
from discovery import DataError


_RESOURCE_REASONS = frozenset({'core_position_budget_exhausted', 'core_tick_budget_exhausted',
                             'fee_step_budget_exhausted', 'historical_work_byte_budget_exhausted'})
_TRANSIENT_REASONS = {reason: reason for reason in (
    'network_unavailable', 'rpc_error', 'rpc_call_gas_limit', 'rpc_call_reverted',
    'request_budget_exhausted',
    'read_deadline_exceeded', 'catalogue_database_unavailable', 'block_unavailable')}
_TRANSIENT_REASONS.update({f'http_{code}': 'upstream_unavailable'
                           for code in (400, 401, 403, 404, 408, 429, 500, 502, 503, 504)})
_DEPENDENCY_REASONS = {'position': frozenset({'reconciled_fee_chunk_required'}), 'fee': frozenset(),
                       'capital': frozenset({'reconciled_position_tail_required',
                                             'reconciled_position_chunk_required'})}
_FIELDS = frozenset({'status', 'reason', 'capacityProfile', 'fromBlock', 'throughBlock',
                     'processedEvents', 'totalEvents', 'phase', 'completedChecks',
                     'requiredChecks', 'limits', 'action'})


def _require(condition):
    if not condition:
        raise DataError('upstream_contract_mismatch')


def _uint(value, maximum):
    return type(value) is int and 0 <= value <= maximum


def _incomplete(work, snapshot, ledger):
    _require(isinstance(work, dict) and set(work) == _FIELDS)
    _require(isinstance(snapshot, dict) and type(snapshot.get('number')) is int and snapshot['number'] >= 0)
    profile = work['capacityProfile']
    _require(type(profile) is str and profile in ('standard', 'extended'))
    positions, ticks = (128, 256) if profile == 'standard' else (1024, 2048)
    limits = work['limits']
    expected = {'positions': positions, 'ticks': ticks, 'eventsPerBatch': 32,
                'checksPerBatch': 128, 'progressBytes': 8388608}
    _require(isinstance(limits, dict) and set(limits) == set(expected) and
             all(type(value) is int for value in limits.values()) and
             all(limits[field] == expected[field] for field in ('positions', 'ticks', 'progressBytes')) and
             1 <= limits['eventsPerBatch'] <= 32 and 1 <= limits['checksPerBatch'] <= 128)
    _require(_uint(work['fromBlock'], snapshot['number']) and work['fromBlock'] > 0 and
             _uint(work['throughBlock'], snapshot['number']) and
             work['fromBlock'] <= work['throughBlock'])
    offset, total = work['processedEvents'], work['totalEvents']
    checks, required = work['completedChecks'], work['requiredChecks']
    _require(_uint(offset, 2000) and (total is None or _uint(total, 2000)) and
             _uint(checks, 4096) and (required is None or _uint(required, 4096)))
    if work['phase'] == 'replay':
        _require(checks == 0 and required is None and
                 ((total is None and offset == 0) or (total is not None and offset < total)))
    else:
        _require(work['phase'] == 'reconciliation' and total is not None and offset == total and
                 (required is None and checks == 0 or required is not None and checks < required))
    reason = work['reason']
    if work['status'] == 'in_progress':
        _require(reason is None and total is not None and work['action'] == 'resume_same_command')
    else:
        _require(work['status'] == 'blocked' and type(reason) is str)
        if reason in _RESOURCE_REASONS:
            if reason in {'core_position_budget_exhausted', 'core_tick_budget_exhausted'}:
                _require(ledger in ('position', 'capital'))
            action = ('select_extended_profile_and_resume' if profile == 'standard' and
                      reason in {'core_position_budget_exhausted', 'core_tick_budget_exhausted'}
                      else 'capacity_review_required')
        elif reason in _TRANSIENT_REASONS or reason in _DEPENDENCY_REASONS[ledger]:
            action = 'repair_source_then_resume'
        elif reason == 'activity_range_budget_exhausted':
            action = 'review_activity_capacity_profile_then_resume'
        elif reason == 'historical_work_method_mismatch':
            # Accept the persisted legacy diagnostic and the explicit #58 restart
            # instruction. Neither qualifies the unpublished prefix. Source and
            # checkpoint mismatches still fail below rather than becoming lag.
            _require(ledger in ('fee', 'position') and work['action'] in
                     ('repair_source_then_resume', 'restart_unpublished_work_after_review'))
            action = work['action']
        else:
            raise DataError('upstream_contract_mismatch')
        _require(work['action'] == action)
    return reason


def _project(accounting, ledger, snapshot):
    if not isinstance(accounting, dict) or 'historicalWork' not in accounting:
        return None
    fields = (('lpFeesRaw', 'protocolFeesRaw', 'donationsRaw') if ledger == 'fee' else
              ('lpAssetsRaw', 'principalRaw', 'unsettledFeesRaw'))
    _require(accounting.get('status') == 'unavailable' and
             all(field in accounting and accounting[field] is None for field in fields))
    reason = _incomplete(accounting['historicalWork'], snapshot, ledger)
    public_reason = ledger + '_ledger_not_caught_up'
    _require(accounting.get('reason') == (reason or public_reason))
    if reason in _TRANSIENT_REASONS:
        # Failed source work is an availability failure, never ordinary progress.
        raise DataError(_TRANSIENT_REASONS[reason])
    old_reason = accounting['reason']
    del accounting['historicalWork']
    accounting['reason'] = public_reason
    return old_reason, public_reason


def project_historical_work(route, result):
    """Mutate only the already-deepcopied public result, at explicit paths."""
    if not isinstance(result, dict):
        return
    if route == 'pool-activity':
        fees, liquidity = result.get('fees'), result.get('liquidity')
        change = _project(fees.get('accounting') if isinstance(fees, dict) else None,
                          'fee', result.get('snapshot'))
        _project(liquidity.get('positionAccounting') if isinstance(liquidity, dict) else None,
                 'position', result.get('snapshot'))
        if change:
            window = result.get('window24h')
            _require(isinstance(window, dict) and window.get('lpFeesReason') == change[0] and window.get('lpFeesRaw') is None and
                     window.get('protocolFeesRaw') is None)
            window['lpFeesReason'] = change[1]
    elif route == 'pool-positions':
        _project(result.get('positionAccounting'), 'position', result.get('snapshot'))


def require_incomplete_positions(accounting, snapshot):
    """Check a raw unavailable ledger before capital projects it as missing history.

    The caller owns the report; validation uses a copy and never edits stored
    worker evidence. Corrupt or failed sidecars cannot become ordinary lag.
    """
    from copy import deepcopy
    projected = deepcopy(accounting)
    _project(projected, 'position', snapshot)
    _require(isinstance(projected, dict) and
             set(projected) == {'methodologyVersion', 'status', 'reason', 'lpAssetsRaw',
                                'principalRaw', 'unsettledFeesRaw'} and
             type(projected['methodologyVersion']) is int and projected['methodologyVersion'] == 1 and
             projected['status'] == 'unavailable' and
             projected['reason'] in ('position_ledger_not_caught_up', 'position_accounting_adapter_required') and
             all(projected[field] is None for field in ('lpAssetsRaw', 'principalRaw', 'unsettledFeesRaw')))


def require_incomplete_capital(work, snapshot):
    """Validate unpublished capital work; callers still check ambiguous dependencies."""
    reason = _incomplete(work, snapshot, 'capital')
    if reason in _TRANSIENT_REASONS:
        raise DataError(_TRANSIENT_REASONS[reason])
    return reason
