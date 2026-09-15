"""Follower semantics: moving target, idle only when caught up, bounded stop."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from discovery import DataError
from followers import follow, follow_many, follow_target


class FakeClock:
    def __init__(self):
        self.now=0.0
        self.slept=[]
    def __call__(self):
        return self.now
    def sleep(self,seconds):
        self.slept.append(seconds);self.now+=seconds


def head(number):
    return {'number':number}


class FollowTargetTests(unittest.TestCase):
    def test_target_stays_the_lag_behind_the_observed_head(self):
        self.assertEqual(follow_target(1000,200),800)
        self.assertEqual(follow_target(1000,0),1000)
        self.assertEqual(follow_target(50,200),1)

    def test_invalid_heads_and_lags_are_rejected(self):
        for head_number,lag in [(0,10),(True,10),('1000',10),(1000,-1),(1000,True)]:
            with self.subTest(head=head_number,lag=lag), self.assertRaises(DataError):
                follow_target(head_number,lag)

    def test_invalid_loop_bounds_are_rejected_before_any_step(self):
        cases=[{'lag':-1,'max_passes':1,'poll_seconds':1},{'lag':0,'max_passes':-1,'poll_seconds':1},
               {'lag':0,'max_passes':1,'poll_seconds':-1},{'lag':0,'max_passes':1,'poll_seconds':1,
                'max_seconds':0},{'lag':0,'max_passes':1,'poll_seconds':1,'max_consecutive_failures':0}]
        for options in cases:
            with self.subTest(options=options), self.assertRaises(DataError):
                follow(lambda *,through:{'status':'caught_up_to_target'},lambda:head(500),**options)


class FollowLoopTests(unittest.TestCase):
    def test_catching_up_does_not_idle_and_reaching_the_target_waits(self):
        clock=FakeClock()
        seen=[]
        results=[{'status':'indexed','through':5},{'status':'caught_up_to_target','through':800},
                 {'status':'caught_up_to_target','through':800},{'status':'caught_up_to_target','through':800}]
        def step(*,through):
            seen.append(through)
            return results[len(seen)-1]
        summary=follow(step,lambda:head(1000),lag=200,max_passes=4,poll_seconds=5,
                       sleep=clock.sleep,clock=clock)
        self.assertEqual(seen,[800,800,800,800])
        self.assertEqual(summary['passes'],4)
        self.assertEqual(summary['indexedPasses'],1)
        self.assertEqual(summary['stoppedBecause'],'max_passes')
        # Passes 2 and 3 waited; the last pass had no successor to wait for.
        self.assertEqual(clock.slept,[5,5])

    def test_backfill_keeps_advancing_without_waiting_between_passes(self):
        clock=FakeClock()
        calls=[]
        def step(*,through):
            calls.append(through)
            return {'status':'indexed','through':min(through,100*len(calls))}
        summary=follow(step,lambda:head(100000),lag=200,max_passes=5,poll_seconds=5,
                       sleep=clock.sleep,clock=clock)
        self.assertEqual(summary['indexedPasses'],5)
        self.assertEqual(clock.slept,[])
        self.assertEqual(calls,[99800]*5)

    def test_stop_flag_and_deadline_are_both_honoured(self):
        clock=FakeClock()
        stop=[False]
        def step(*,through):
            stop[0]=True
            return {'status':'caught_up_to_target','through':through}
        requested=follow(step,lambda:head(500),lag=100,max_passes=0,poll_seconds=5,
                         should_stop=lambda:stop[0],sleep=clock.sleep,clock=clock)
        self.assertEqual(requested['stoppedBecause'],'stop_requested')
        self.assertEqual(requested['passes'],1)
        expired=follow(lambda *,through:{'status':'caught_up_to_target','through':through},
                       lambda:head(500),lag=100,max_passes=0,poll_seconds=5,max_seconds=4,
                       sleep=clock.sleep,clock=clock)
        self.assertEqual(expired['stoppedBecause'],'max_seconds')

    def test_repeated_failures_stop_the_loop_and_are_recorded(self):
        clock=FakeClock()
        attempts=[]
        def step(*,through):
            attempts.append(through)
            raise DataError('network_unavailable')
        summary=follow(step,lambda:head(500),lag=100,max_passes=3,poll_seconds=5,
                       max_consecutive_failures=2,sleep=clock.sleep,clock=clock)
        self.assertEqual(len(attempts),2)
        self.assertEqual([item['reason'] for item in summary['failures']],['network_unavailable']*2)
        self.assertEqual(summary['stoppedBecause'],'failures')
        self.assertEqual(clock.slept,[5])

    def test_a_success_clears_the_consecutive_failure_count(self):
        clock=FakeClock()
        outcomes=[DataError('network_unavailable'),{'status':'indexed','through':10},
                  DataError('network_unavailable'),{'status':'indexed','through':11}]
        def step(*,through):
            outcome=outcomes.pop(0)
            if isinstance(outcome,Exception):raise outcome
            return outcome
        summary=follow(step,lambda:head(500),lag=100,max_passes=4,poll_seconds=5,
                       max_consecutive_failures=2,sleep=clock.sleep,clock=clock)
        self.assertEqual(summary['stoppedBecause'],'max_passes')
        self.assertEqual(len(summary['failures']),2)
        self.assertEqual(summary['indexedPasses'],2)

    def test_rewinds_and_invalid_step_results_are_not_silent(self):
        clock=FakeClock()
        results=[{'status':'rewound','through':900},{'status':'finished','through':900}]
        def step(*,through):
            return results.pop(0)
        summary=follow(step,lambda:head(1000),lag=100,max_passes=2,poll_seconds=5,
                       max_consecutive_failures=2,sleep=clock.sleep,clock=clock)
        self.assertEqual(len(summary['rewinds']),1)
        self.assertEqual(summary['failures'][0]['reason'],'invalid_follow_step_result')

    def test_multiple_targets_each_run_every_round_and_do_not_starve(self):
        clock=FakeClock()
        calls={'a':[],'b':[]}
        def catching(*,through):
            calls['a'].append(through)
            return {'status':'indexed','through':through-1}
        def current(*,through):
            calls['b'].append(through)
            return {'status':'caught_up_to_target','through':through}
        summary=follow_many((('a',catching),('b',current)),lambda:head(1000),lag=100,
                            max_passes=3,poll_seconds=5,sleep=clock.sleep,clock=clock)
        self.assertEqual(calls['a'],[900,900,900])
        self.assertEqual(calls['b'],[900,900,900])
        self.assertEqual(summary['targets']['a']['indexedPasses'],3)
        self.assertEqual(summary['targets']['b']['indexedPasses'],0)
        # One target still catching up keeps the round busy: no idle wait.
        self.assertEqual(clock.slept,[])

    def test_one_stuck_target_stops_the_loop_instead_of_hiding_it(self):
        clock=FakeClock()
        def broken(*,through):
            raise DataError('activity_range_budget_exhausted')
        def healthy(*,through):
            return {'status':'caught_up_to_target','through':through}
        summary=follow_many((('broken',broken),('healthy',healthy)),lambda:head(1000),lag=100,
                            max_passes=5,poll_seconds=5,max_consecutive_failures=2,
                            sleep=clock.sleep,clock=clock)
        self.assertEqual(summary['stoppedBecause'],'failures')
        self.assertEqual(len(summary['targets']['broken']['failures']),2)
        self.assertEqual(summary['targets']['healthy']['lastResult']['status'],'caught_up_to_target')

    def test_empty_or_unnamed_targets_are_rejected(self):
        with self.assertRaises(DataError):
            follow_many((),lambda:head(1000),lag=10,max_passes=1,poll_seconds=1)
        with self.assertRaises(DataError):
            follow_many((('a',None),),lambda:head(1000),lag=10,max_passes=1,poll_seconds=1)


if __name__=='__main__':unittest.main()
