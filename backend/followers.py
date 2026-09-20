"""Bounded follow loops for the catalogue and activity indexers.

A follower repeats the indexer's own bounded step against a target that stays a
fixed number of blocks behind the observed head, so a reorg inside that lag is
rewound by the indexer's reconciliation instead of being committed as history.
It never submits a transaction and never decides policy: it only decides *when*
the step runs and how the outcome is summarised.

Every loop is bounded by an explicit round budget, an optional deadline, a
repeated-failure budget and an external stop flag. `max_passes=0` means "until
stopped" and is only meaningful with a deadline, a stop flag or a supervisor.
Each target keeps its own failure budget, so one pool that cannot catch up
stops the loop for the operator instead of starving the others in silence.
"""
import time

from discovery import DataError

STEP_STATUSES = ('indexed', 'caught_up_to_target', 'rewound')
# A spent provider budget is an operator decision point, not a transient fault:
# retrying would spend the same money again.
STOP_REASONS = frozenset({'header_budget_exhausted','indexer_rpc_budget_exhausted'})


def follow_target(head_number, lag):
    """Highest block a follower may index: the observed head minus its lag."""
    if type(head_number) is not int or head_number < 1:
        raise DataError('invalid_follow_head')
    if type(lag) is not int or lag < 0:
        raise DataError('invalid_follow_lag')
    return max(1, head_number - lag)


def _checked(*, lag, max_passes, poll_seconds, max_seconds, max_consecutive_failures):
    if type(lag) is not int or lag < 0:
        raise DataError('invalid_follow_lag')
    if type(max_passes) is not int or max_passes < 0:
        raise DataError('invalid_follow_passes')
    if type(poll_seconds) not in (int, float) or poll_seconds < 0:
        raise DataError('invalid_follow_poll')
    if max_seconds is not None and (type(max_seconds) not in (int, float) or max_seconds <= 0):
        raise DataError('invalid_follow_deadline')
    if type(max_consecutive_failures) is not int or max_consecutive_failures < 1:
        raise DataError('invalid_follow_failure_budget')


def follow_many(targets, observe_head, *, lag, max_passes, poll_seconds, max_seconds=None,
                max_consecutive_failures=5, should_stop=None, sleep=time.sleep,
                clock=time.monotonic, on_pass=None):
    """Run one step per target on every round, so no target starves the others.

    `targets` is a sequence of `(name, step)`; `step(through=block)` is the
    indexer's own bounded step. `observe_head()` returns the current head
    snapshot with a numeric `number` and is called once per round.
    """
    targets = tuple(targets)
    if not targets or any(not isinstance(name, str) or not callable(step) for name, step in targets):
        raise DataError('invalid_follow_targets')
    _checked(lag=lag, max_passes=max_passes, poll_seconds=poll_seconds,
             max_seconds=max_seconds, max_consecutive_failures=max_consecutive_failures)
    deadline = None if max_seconds is None else clock() + max_seconds
    progress = {name: {'indexedPasses': 0, 'rewinds': [], 'failures': [],
                       'consecutiveFailures': 0, 'lastResult': None} for name, _ in targets}
    rounds, stopped, target_block = 0, 'max_passes', None
    failures_in_a_row = 0
    head_failures = []
    while max_passes == 0 or rounds < max_passes:
        if should_stop is not None and should_stop():
            stopped = 'stop_requested'
            break
        if deadline is not None and clock() >= deadline:
            stopped = 'max_seconds'
            break
        try:
            head = observe_head()
            target_block = follow_target(head['number'], lag)
        except (DataError, OSError) as error:
            # A provider hiccup while asking the chain where it is must not end
            # the follower: it is one failed round, under the same budget.
            rounds += 1
            failures_in_a_row += 1
            failure = {'round': rounds, 'targetBlock': None, 'reason': str(error)}
            head_failures.append(failure)
            if on_pass is not None:
                on_pass({'round': rounds, 'target': 'head', **failure})
            if failures_in_a_row >= max_consecutive_failures:
                stopped = 'failures'
                break
            sleep(poll_seconds)
            continue
        rounds += 1
        failures_in_a_row = 0
        catching_up = failed = False
        for name, step in targets:
            if should_stop is not None and should_stop():
                stopped = 'stop_requested'
                break
            try:
                result = step(through=target_block)
                if not isinstance(result, dict) or result.get('status') not in STEP_STATUSES:
                    raise DataError('invalid_follow_step_result')
            except (DataError, OSError) as error:
                entry = progress[name]
                entry['consecutiveFailures'] += 1
                failure = {'round': rounds, 'targetBlock': target_block, 'reason': str(error)}
                entry['failures'].append(failure)
                entry['lastResult'] = failure
                if on_pass is not None:
                    on_pass({'round': rounds, 'target': name, 'targetBlock': target_block, **failure})
                if str(error) in STOP_REASONS:
                    stopped = 'budget'
                    break
                failed = True
                if entry['consecutiveFailures'] >= max_consecutive_failures:
                    stopped = 'failures'
                    break
                continue
            entry = progress[name]
            entry['consecutiveFailures'] = 0
            entry['lastResult'] = result
            if result['status'] == 'indexed':
                entry['indexedPasses'] += 1
                if result.get('through', 0) < target_block:
                    catching_up = True
            elif result['status'] == 'rewound':
                entry['rewinds'].append(result)
                catching_up = True
            if on_pass is not None:
                on_pass({'round': rounds, 'target': name, 'targetBlock': target_block, **result})
        if stopped in ('failures','stop_requested','budget'):
            break
        # Idle only when nothing is catching up; a backfill is not slowed by the
        # poll interval, and a failed round waits before it is retried.
        if (not catching_up or failed) and (max_passes == 0 or rounds < max_passes):
            sleep(poll_seconds)
    return {'schemaVersion': 1, 'mode': 'bounded_follower', 'lagBlocks': lag, 'rounds': rounds,
            'targets': progress, 'maxConsecutiveFailures': max_consecutive_failures,
            'stoppedBecause': stopped, 'lastTargetBlock': target_block,
            'headFailures': head_failures, 'transactionSubmission': False}


def follow(step, observe_head, **options):
    """Single-target follower; the summary keeps the flat one-target shape."""
    summary = follow_many((('index', step),), observe_head, **options)
    single = summary['targets']['index']
    return {'schemaVersion': summary['schemaVersion'], 'mode': summary['mode'],
            'lagBlocks': summary['lagBlocks'], 'passes': summary['rounds'],
            'indexedPasses': single['indexedPasses'], 'rewinds': single['rewinds'],
            'failures': single['failures'], 'maxConsecutiveFailures': summary['maxConsecutiveFailures'],
            'stoppedBecause': summary['stoppedBecause'], 'lastTarget': summary['lastTargetBlock'],
            'headFailures': summary['headFailures'],
            'lastResult': single['lastResult'], 'transactionSubmission': False}
