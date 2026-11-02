"""Check the operator authorization boundary without GitHub or host access."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('start_pilot', Path(__file__).with_name('start-clawber-pilot.py'))
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)


class OperatorAuthorization(unittest.TestCase):
    def setUp(self):
        self.run = {'id': 123, 'run_attempt': 2, 'event': 'workflow_dispatch',
                    'head_branch': 'main', 'head_sha': 'a' * 40, 'path': launch.WORKFLOW,
                    'repository': {'full_name': launch.REPO}, 'actor': {'login': 'operator'},
                    'triggering_actor': {'login': 'operator'}, 'status': 'in_progress'}
        self.jobs = [{'name': 'Require a dispatched main commit', 'conclusion': 'success'},
                     {'name': 'read-worker (clawber)', 'status': 'queued',
                      'labels': ['self-hosted', 'Linux', 'X64', 'domino-ci-pilot', 'domino-ci-123-2']}]

    def check(self, run=None, jobs=None):
        return launch.authorize(run or self.run, jobs or self.jobs,
                                actor='operator', sha='a' * 40, workload='read-worker')

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


if __name__ == '__main__':
    unittest.main()
