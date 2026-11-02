"""Offline authorization, credential boundary, queue and recovery checks."""
import base64
import copy
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import clawber_broker as broker

POLICY_PATH = Path(__file__).with_name('runner-policy.json')


def fixtures(profile='normal', event='push'):
    policy = broker.load_policy(json.loads(POLICY_PATH.read_text()))
    entry = next(e for e in policy['jobs'] if e['profile'] == profile)
    repository = {'id': policy['repository_id'], 'full_name': policy['repository'],
                  'private': True, 'fork': False, 'allow_forking': False}
    run = {'id': 100, 'run_attempt': 2, 'head_sha': 'a' * 40, 'head_branch': 'main',
           'repository': repository, 'head_repository': repository, 'event': event,
           'status': 'in_progress', 'actor': {'login': 'rugged97'},
           'triggering_actor': {'login': 'OxDecimal'}, 'path': entry['workflow'],
           'workflow_id': 5, 'created_at': '2026-11-02T00:00:00Z'}
    job = {'id': 200, 'run_id': 100, 'run_attempt': 2, 'head_sha': 'a' * 40,
           'head_branch': 'main', 'status': 'queued', 'name': entry['job_name'],
           'labels': sorted(broker.expected_labels(policy, run, entry))}
    workflow = {'id': 5, 'path': entry['workflow'], 'state': 'active'}
    permissions = {'rugged97': 'admin', 'OxDecimal': 'write'}
    config = {'app_id': 'Iv1.test', 'installation_id': 77, 'private_key': '/unused/key.pem',
              'runner_scope': 'repository', 'runner_owner': 'domino-money',
              'runner_group_id': 1, 'controller': '/owned/controller.py',
              'base_sha256': 'b' * 64}
    return policy, repository, run, job, workflow, permissions, config


class FakeApi:
    def __init__(self, values):
        self.values = values
        self.calls = []

    def request(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        key = (method, path)
        if key not in self.values:
            raise AssertionError('Unexpected API request: ' + method + ' ' + path)
        value = self.values[key]
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)

    def pages(self, path, key):
        return self.request('GET', path)[key]


class FakeChild:
    pid = 999999

    def __init__(self):
        self.stdin = io.BytesIO()
        self.code = None

    def poll(self):
        return self.code


class AdmissionTests(unittest.TestCase):
    def admit(self, values):
        policy, repository, run, job, workflow, permissions, _ = values
        return broker.authorize(policy, repository, run, job, [job], permissions, workflow)

    def test_current_policy_and_trusted_rerun_actor_are_accepted(self):
        entry, labels = self.admit(fixtures())
        self.assertEqual(entry['profile'], 'normal')
        self.assertEqual(len(labels), 7)

    def test_repo_actor_source_attempt_and_labels_fail_closed(self):
        cases = [
            (1, 'private', False), (1, 'allow_forking', True),
            (2, 'event', 'pull_request_target'), (2, 'head_branch', 'other'),
            (2, 'head_sha', 'z' * 40), (3, 'run_attempt', 1),
            (3, 'head_sha', 'b' * 40), (3, 'run_id', 101),
            (3, 'labels', ['self-hosted', 'Linux', 'X64', 'domino-ci']),
            (4, 'path', '.github/workflows/attacker.yml'), (5, 'OxDecimal', 'read')]
        for index, key, value in cases:
            with self.subTest(index=index, key=key):
                values = fixtures()
                values[index][key] = value
                with self.assertRaises(broker.BrokerError):
                    self.admit(values)

    def test_same_repository_pr_main_base_allowed_without_credentials(self):
        values = fixtures(event='pull_request')
        run, job = values[2], values[3]
        run['head_branch'] = job['head_branch'] = 'codex/change'
        run['pull_requests'] = [{'base': {'ref': 'main', 'repo': {'id': 1363307729}},
                                 'head': {'sha': 'a' * 40, 'repo': {'id': 1363307729}}}]
        self.admit(values)
        run['pull_requests'][0]['head']['repo']['id'] = 8
        with self.assertRaisesRegex(broker.BrokerError, 'pr_identity'):
            self.admit(values)

    def test_deploy_cannot_admit_pr_or_nonmain_dispatch(self):
        for event, branch in [('pull_request', 'main'), ('workflow_dispatch', 'branch')]:
            values = fixtures(profile='deploy', event=event)
            values[2]['head_branch'] = values[3]['head_branch'] = branch
            with self.assertRaisesRegex(broker.BrokerError, 'main_required'):
                self.admit(values)

    def test_duplicate_compatible_job_is_rejected(self):
        policy, repo, run, job, workflow, permissions, _ = fixtures()
        duplicate = dict(job, id=201)
        with self.assertRaisesRegex(broker.BrokerError, 'duplicate_job_labels'):
            broker.authorize(policy, repo, run, job, [job, duplicate], permissions, workflow)

    def test_documented_workflow_path_suffix_does_not_change_identity(self):
        values = fixtures()
        values[2]['path'] = 'domino-money/domino/' + values[2]['path'] + '@refs/heads/main'
        self.admit(values)
        values[2]['path'] = 'other/repository/.github/workflows/ci.yml@main'
        with self.assertRaisesRegex(broker.BrokerError, 'workflow_identity'):
            self.admit(values)


class AuthTests(unittest.TestCase):
    def test_jwt_signature_is_valid_rsa_and_claims_are_bounded(self):
        policy, *_, config = fixtures()
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory) / 'private.pem'
            public = Path(directory) / 'public.pem'
            subprocess.run(['openssl', 'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048',
                            '-out', str(private)], check=True, capture_output=True)
            subprocess.run(['openssl', 'pkey', '-in', str(private), '-pubout', '-out', str(public)],
                           check=True, capture_output=True)
            config['private_key'] = str(private)
            token = broker.GitHub(config, policy, clock=lambda: 1000).jwt()
            header, claims, signature = token.split('.')
            claims = json.loads(base64.urlsafe_b64decode(claims + '=' * (-len(claims) % 4)))
            self.assertEqual(claims, {'iat': 940, 'exp': 1540, 'iss': 'Iv1.test'})
            signature_file = Path(directory) / 'signature'
            signature_file.write_bytes(base64.urlsafe_b64decode(signature + '=' * (-len(signature) % 4)))
            result = subprocess.run(['openssl', 'dgst', '-sha256', '-verify', str(public),
                '-signature', str(signature_file)], input='.'.join(token.split('.')[:2]).encode(),
                capture_output=True)
            self.assertEqual(result.returncode, 0)

    def test_installation_token_is_repo_scoped_cached_and_refreshed(self):
        policy, *_, config = fixtures()
        config['runner_scope'] = 'organization'
        now, calls = [1000], []
        def transport(method, path, credential, payload):
            calls.append((method, path, credential, payload))
            if path.startswith('/app/installations/'):
                return {'token': 'temporary-token', 'expires_at': '1970-01-01T01:16:40Z',
                        'repositories': [{'id': 1363307729}]}
            return {'ok': True}
        api = broker.GitHub(config, policy, clock=lambda: now[0], transport=transport)
        with patch.object(api, 'jwt', return_value='signed-jwt'):
            api.request('GET', '/repos/domino-money/domino')
            api.request('GET', '/repos/domino-money/domino')
            self.assertEqual(len(calls), 3)
            self.assertEqual(calls[0][3], {'repository_ids': [1363307729], 'permissions': {
                'actions': 'read', 'metadata': 'read', 'organization_self_hosted_runners': 'write'}})
            self.assertEqual(calls[1][2], 'temporary-token')
            now[0] = 4500
            # The fixture's old expiry must not be silently accepted on refresh.
            with self.assertRaisesRegex(broker.BrokerError, 'app_token_expiry_invalid'):
                api.request('GET', '/repos/domino-money/domino')

    def test_pagination_cannot_silently_drop_queue_entries(self):
        policy, *_, config = fixtures()
        api = broker.GitHub(config, policy)
        with patch.object(api, 'request', side_effect=[{'total_count': 2, 'jobs': [{'id': 1}]},
                                                      {'total_count': 2, 'jobs': []}]):
            with self.assertRaisesRegex(broker.BrokerError, 'api_pagination_incomplete'):
                api.pages('/jobs', 'jobs')

    def test_redirect_never_forwards_auth_to_another_origin(self):
        with self.assertRaisesRegex(broker.BrokerError, 'api_redirect_refused'):
            broker.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://untrusted.invalid/')


class LifecycleTests(unittest.TestCase):
    def configured(self, directory):
        policy, repo, run, job, workflow, permissions, config = fixtures()
        prefix = '/repos/domino-money/domino'
        values = {('GET', prefix): repo, ('GET', prefix + '/actions/runs/100'): run,
            ('GET', prefix + '/actions/runs/100/attempts/2/jobs'): {'jobs': [job]},
            ('GET', prefix + '/actions/runs?status=queued'): {'workflow_runs': []},
            ('GET', prefix + '/actions/runs?status=in_progress'): {'workflow_runs': []},
            ('GET', prefix + '/actions/workflows/5'): workflow,
            ('GET', prefix + '/actions/jobs/200'): dict(job, status='completed'),
            ('GET', prefix + '/collaborators/rugged97/permission'): {'permission': 'admin'},
            ('GET', prefix + '/collaborators/OxDecimal/permission'): {'permission': 'write'},
            ('POST', prefix + '/actions/runners/generate-jitconfig'): {
                'runner': {'id': 300}, 'encoded_jit_config': 'one-use-jit'},
            ('GET', prefix + '/actions/runners/300'): {'id': 300, 'name': 'domino-broker-100-2-200'},
            ('DELETE', prefix + '/actions/runners/300'): None}
        api = FakeApi(values)
        store = broker.Store(Path(directory) / 'state.json')
        fake_run = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0)
        instance = broker.Broker(config, policy, api, store, run=fake_run, clock=lambda: 1000)
        return instance, api, store

    def test_launch_rechecks_auth_and_never_puts_jit_in_argv_or_state(self):
        with tempfile.TemporaryDirectory() as directory:
            instance, api, store = self.configured(directory)
            captured = []
            class Input(io.BytesIO):
                def close(self):
                    self.saved = self.getvalue()
                    super().close()
            child = FakeChild()
            child.stdin = Input()
            def popen(command, **kwargs):
                captured.append((command, kwargs))
                return child
            instance.popen = popen
            instance.launch(1, 100, 200)
            self.assertEqual(child.stdin.saved, b'one-use-jit')
            self.assertNotIn('one-use-jit', json.dumps(captured, default=str))
            self.assertNotIn('one-use-jit', store.path.read_text())
            self.assertIn('--slot', captured[0][0])
            child.code = 0
            instance.cycle()
            self.assertEqual(store.data['active'], {})
            self.assertIn('200', store.data['completed'])
            self.assertTrue(any(call[0] == 'DELETE' for call in api.calls))

    def test_launch_failure_cleans_registration_and_recovers_still_queued_job(self):
        with tempfile.TemporaryDirectory() as directory:
            instance, api, store = self.configured(directory)
            api.values[('GET', instance.repo_path + '/actions/jobs/200')]['status'] = 'queued'
            def broken(*args, **kwargs):
                raise OSError('synthetic spawn failure')
            instance.popen = broken
            with self.assertRaises(OSError):
                instance.launch(1, 100, 200)
            self.assertEqual(store.data['active'], {})
            self.assertNotIn('200', store.data['completed'])
            self.assertGreater(store.data['retries']['200']['after'], 1000)
            self.assertTrue(any(call[0] == 'DELETE' for call in api.calls))

    def test_recovery_refuses_busy_controller_without_deleting_runner(self):
        with tempfile.TemporaryDirectory() as directory:
            instance, api, store = self.configured(directory)
            store.data['active']['1'] = {'job_id': 200, 'runner_id': 300,
                                        'runner_name': 'domino-broker-100-2-200'}
            store.save()
            instance.run = lambda *a, **k: subprocess.CompletedProcess(a[0], 1)
            with self.assertRaisesRegex(broker.BrokerError, 'slot_cleanup_failed'):
                instance.recover()
            self.assertFalse(any(call[0] == 'DELETE' for call in api.calls))
            self.assertIn('1', broker.Store(store.path).data['active'])

    def test_optional_job_attempt_is_bound_only_by_attempt_specific_endpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            instance, api, _ = self.configured(directory)
            path = instance.repo_path + '/actions/runs/100/attempts/2/jobs'
            del api.values[('GET', path)]['jobs'][0]['run_attempt']
            rows = instance.attempt_jobs({'id': 100, 'run_attempt': 2})
            self.assertEqual(rows[0]['run_attempt'], 2)
            api.values[('GET', path)]['jobs'][0]['run_attempt'] = 1
            with self.assertRaisesRegex(broker.BrokerError, 'job_attempt_identity'):
                instance.attempt_jobs({'id': 100, 'run_attempt': 2})

    def test_organization_group_cannot_become_available_to_other_repositories(self):
        with tempfile.TemporaryDirectory() as directory:
            instance, api, _ = self.configured(directory)
            instance.config['runner_scope'] = 'organization'
            path = '/orgs/domino-money/actions/runner-groups/1'
            api.values[('GET', path)] = {'visibility': 'selected', 'allows_public_repositories': False}
            api.values[('GET', path + '/repositories')] = {'repositories': [{'id': 1363307729}]}
            instance.check_group()
            api.values[('GET', path + '/repositories')]['repositories'].append({'id': 2})
            with self.assertRaisesRegex(broker.BrokerError, 'runner_group_repository'):
                instance.check_group()

    def test_controller_diagnostics_drop_raw_text_and_unknown_fields(self):
        raw = json.dumps({'error': 'guest_crashed', 'secret': 'never-copy-this'})
        self.assertEqual(broker.controller_receipt(None, raw), {'code': 'guest_crashed'})
        self.assertEqual(broker.controller_receipt(None, 'never-copy-this'), {})

    def test_exit_race_is_reaped_without_signalling_a_different_process(self):
        child = FakeChild()
        child.wait = lambda timeout: 0
        with patch.object(broker.os, 'killpg', side_effect=ProcessLookupError()) as kill:
            broker.Broker.stop_child(child)
        self.assertEqual(kill.call_count, 1)

    def test_shutdown_attempts_both_slots_even_when_first_stop_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            instance, _, _ = self.configured(directory)
            first, second = FakeChild(), FakeChild()
            instance.children = {1: first, 2: second}
            stopped, finished = [], []
            def stop(child):
                stopped.append(child)
                if child is first:
                    raise OSError('synthetic failure')
            instance.stop_child = stop
            instance.finish = finished.append
            with self.assertRaisesRegex(broker.BrokerError, 'shutdown_cleanup_pending'):
                instance.shutdown()
            self.assertEqual(stopped, [first, second])
            self.assertEqual(finished, [1, 2])

    def test_two_slots_and_oldest_first_without_duplicate_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            instance, _, store = self.configured(directory)
            instance.queued = lambda: [('2026-01-01', 1, 100), ('2026-01-02', 2, 100),
                                       ('2026-01-03', 3, 100)]
            launched = []
            def launch(slot, run_id, job_id):
                launched.append((slot, job_id))
                store.data['active'][str(slot)] = {'job_id': job_id}
            instance.launch = launch
            instance.cycle()
            self.assertEqual(launched, [(1, 1), (2, 2)])

    def test_cancellation_terminates_only_the_owning_child(self):
        with tempfile.TemporaryDirectory() as directory:
            instance, api, store = self.configured(directory)
            first, second = FakeChild(), FakeChild()
            instance.children = {1: first, 2: second}
            store.data['active'] = {'1': {'run_id': 100, 'run_attempt': 2, 'job_id': 200,
                'head_sha': 'a' * 40, 'started': 1000, 'lifetime_seconds': 900},
                '2': {'run_id': 100, 'run_attempt': 2, 'job_id': 201,
                'head_sha': 'a' * 40, 'started': 1000, 'lifetime_seconds': 900}}
            api.values[('GET', instance.repo_path + '/actions/jobs/201')] = {'status': 'in_progress',
                'run_id': 100, 'head_sha': 'a' * 40}
            stopped, finished = [], []
            instance.stop_child = stopped.append
            instance.finish = finished.append
            instance.cycle()
            self.assertEqual(stopped, [first])
            self.assertEqual(finished, [1])


if __name__ == '__main__':
    unittest.main()
