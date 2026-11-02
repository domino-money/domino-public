"""Check the operator authorization boundary without GitHub or host access."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('start_pilot', Path(__file__).with_name('start-clawber-pilot.py'))
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)


class OperatorAuthorization(unittest.TestCase):
    def setUp(self):
        self.run = {'id': 123, 'run_attempt': 2, 'event': 'workflow_dispatch',
                    'head_branch': 'main', 'head_sha': 'a' * 40, 'path': launch.WORKFLOW,
                    'repository': {'full_name': launch.REPO}, 'actor': {'login': 'operator'},
                    'triggering_actor': {'login': 'operator'}, 'status': 'in_progress'}
        source = {'run_id': 123, 'run_attempt': 2, 'head_sha': 'a' * 40, 'head_branch': 'main'}
        self.jobs = [{**source, 'name': 'Require a dispatched main commit', 'status': 'completed', 'conclusion': 'success'},
                     {**source, 'name': 'read-worker (clawber)', 'status': 'queued',
                      'labels': ['self-hosted', 'Linux', 'X64', 'domino-ci-pilot', 'domino-ci-123-2']}]

    def check(self, run=None, jobs=None, prior_jobs=()):
        return launch.authorize(self.run if run is None else run, self.jobs if jobs is None else jobs,
                                actor='operator', sha='a' * 40, workload='read-worker', prior_jobs=prior_jobs)

    def test_exact_trusted_dispatch(self):
        self.assertIn('domino-ci-123-2', self.check())

    def test_other_event_branch_workflow_sha_or_repository(self):
        for key, value in [('event', 'pull_request'), ('head_branch', 'feature'),
                           ('path', '.github/workflows/ci.yml'), ('head_sha', 'b' * 40),
                           ('repository', {'full_name': 'someone/domino'}), ('status', 'completed')]:
            with self.subTest(key=key):
                run = copy.deepcopy(self.run); run[key] = value
                with self.assertRaises(ValueError): self.check(run=run)

    def test_other_actor_or_rerun_operator(self):
        for field in ('actor', 'triggering_actor'):
            run = copy.deepcopy(self.run); run[field] = {'login': 'another'}
            with self.assertRaises(ValueError): self.check(run=run)

    def test_preflight_must_have_succeeded(self):
        jobs = copy.deepcopy(self.jobs); jobs[0]['conclusion'] = 'failure'
        with self.assertRaises(ValueError): self.check(jobs=jobs)

    def test_matching_job_is_not_already_running(self):
        jobs = copy.deepcopy(self.jobs); jobs[1]['status'] = 'in_progress'
        with self.assertRaises(ValueError): self.check(jobs=jobs)

    def test_labels_are_unique_to_run_attempt(self):
        for label in ('domino-ci-123-1', 'domino-ci-124-2'):
            jobs = copy.deepcopy(self.jobs); jobs[1]['labels'][-1] = label
            with self.assertRaises(ValueError): self.check(jobs=jobs)

    def test_duplicate_or_wrong_workload_job_is_rejected(self):
        jobs = copy.deepcopy(self.jobs); jobs.append(copy.deepcopy(jobs[1]))
        with self.assertRaises(ValueError): self.check(jobs=jobs)
        jobs = copy.deepcopy(self.jobs); jobs[1]['name'] = 'backend (clawber)'
        with self.assertRaises(ValueError): self.check(jobs=jobs)


    def prior_preflight(self, **overrides):
        prior = {**copy.deepcopy(self.jobs[0]), 'run_attempt': 1}
        prior.update(overrides)
        return prior

    def test_job_only_rerun_reuses_successful_same_source_prior_preflight(self):
        self.assertIn('domino-ci-123-2', self.check(jobs=[self.jobs[1]],
                                                 prior_jobs=[self.prior_preflight()]))

    def test_prior_preflight_cannot_cross_source_run_or_branch(self):
        for key, value in [('run_id', 124), ('head_sha', 'b' * 40), ('head_branch', 'feature'),
                           ('run_attempt', 2), ('status', 'in_progress'), ('conclusion', 'failure')]:
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    self.check(jobs=[self.jobs[1]], prior_jobs=[self.prior_preflight(**{key: value})])

    def test_present_failed_or_pending_current_preflight_never_uses_history(self):
        for status, conclusion in [('completed', 'failure'), ('in_progress', None)]:
            jobs = copy.deepcopy(self.jobs)
            jobs[0].update(status=status, conclusion=conclusion)
            with self.subTest(status=status):
                with self.assertRaises(ValueError):
                    self.check(jobs=jobs, prior_jobs=[self.prior_preflight()])

    def test_latest_prior_failure_and_duplicate_preflight_are_rejected(self):
        run = {**self.run, 'run_attempt': 3}
        queued = {**self.jobs[1], 'run_attempt': 3,
                  'labels': ['self-hosted', 'Linux', 'X64', 'domino-ci-pilot', 'domino-ci-123-3']}
        with self.assertRaises(ValueError):
            self.check(run=run, jobs=[queued], prior_jobs=[self.prior_preflight(),
                       self.prior_preflight(run_attempt=2, conclusion='failure')])
        prior = self.prior_preflight()
        with self.assertRaises(ValueError):
            self.check(jobs=[self.jobs[1]], prior_jobs=[prior, copy.deepcopy(prior)])

    def test_queued_job_source_and_attempt_stay_strict_when_using_history(self):
        for key, value in [('run_id', 124), ('head_sha', 'b' * 40), ('head_branch', 'feature'), ('run_attempt', 1)]:
            queued = {**copy.deepcopy(self.jobs[1]), key: value}
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    self.check(jobs=[queued], prior_jobs=[self.prior_preflight()])

    def test_all_attempt_history_is_paginated_and_bounded(self):
        with patch.object(launch, 'gh', side_effect=[{'jobs': [{'id': 1}], 'total_count': 2},
                                                   {'jobs': [{'id': 2}], 'total_count': 2}]) as api:
            self.assertEqual(launch.all_attempt_jobs(123), [{'id': 1}, {'id': 2}])
            self.assertIn('filter=all', api.call_args_list[0].args[0])
            self.assertIn('page=2', api.call_args_list[1].args[0])
        with patch.object(launch, 'gh', return_value={'jobs': [{'id': 1}], 'total_count': 1001}) as api:
            with self.assertRaises(ValueError): launch.all_attempt_jobs(123)
            self.assertEqual(api.call_count, 10)


if __name__ == '__main__':
    unittest.main()
