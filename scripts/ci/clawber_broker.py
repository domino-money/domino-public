#!/usr/bin/env python3
"""Root-owned, outbound-only broker for two disposable Domino CI guests.

Install this code and its policy outside CI checkouts. The App key and one-hour
installation tokens remain on the host; only a one-use JIT crosses guest stdin.
No job content, labels or webhook payload can supply a host command or path.
"""
from __future__ import annotations

import argparse
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
from datetime import datetime
import urllib.error
import urllib.request

API = 'https://api.github.com'
API_VERSION = '2026-03-10'
MAX_PAGES = 10
MAX_BYTES = 8 * 1024 * 1024
PREFIX = 'domino-broker-'
PROFILES = {'normal', 'systemd', 'deploy'}
ACTIVE = {'queued', 'in_progress'}


class BrokerError(Exception):
    """Fixed error codes only: never print API bodies or credentials."""


class ApiError(BrokerError):
    def __init__(self, status):
        self.status = status
        super().__init__('github_api_failed')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise BrokerError('api_redirect_refused')


def need(value, code):
    if not value:
        raise BrokerError(code)


def error_event(event, error, **fields):
    fields.update(event=event, code=str(error) if isinstance(error, BrokerError) else 'operation_failed')
    if isinstance(error, ApiError):
        fields['http_status'] = error.status
    print(json.dumps(fields), flush=True)


def controller_receipt(stdout, stderr):
    """Export only the controller's fixed status codes, never raw subprocess data."""
    receipt = {}
    for raw in (stdout, stderr):
        if not raw or len(raw) > 4096:
            continue
        try:
            value = json.loads(raw)
        except (TypeError, ValueError, UnicodeError):
            continue
        if not isinstance(value, dict):
            continue
        code = value.get('error')
        if isinstance(code, str) and re.fullmatch(r'[a-z][a-z0-9_]{0,80}', code):
            receipt['code'] = code
        if value.get('lifecycle') in ('guest_stopped', 'slot_cleaned'):
            receipt['lifecycle'] = value['lifecycle']
    return receipt


def secure_path(value, *, directory=False, secret=False):
    path = Path(value)
    need(path.is_absolute() and path.resolve() == path, 'unsafe_owned_path')
    for parent in (path, *path.parents):
        info = parent.lstat()
        need(info.st_uid == 0 and not info.st_mode & 0o022
             and not stat.S_ISLNK(info.st_mode), 'unsafe_owned_path')
    info = path.stat()
    need(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode),
         'unsafe_owned_path')
    if secret:
        need(not info.st_mode & 0o077, 'credential_permissions')
    return path


def load_policy(document):
    need(document.get('version') == 1, 'policy_version')
    need(document.get('repository') == 'domino-money/domino'
         and document.get('repository_id') == 1363307729, 'policy_repository')
    need(document.get('base_labels') == ['self-hosted', 'Linux', 'X64', 'domino-ci']
         and document.get('run_label_template') == 'domino-ci-{run_id}-{run_attempt}',
         'policy_labels')
    jobs = document.get('jobs')
    need(isinstance(jobs, list) and 1 <= len(jobs) <= 100, 'policy_jobs')
    identities, labels = set(), set()
    for entry in jobs:
        need(isinstance(entry, dict), 'policy_job')
        workflow, name, label = (entry.get(k) for k in ('workflow', 'job_name', 'job_label'))
        need(isinstance(workflow, str) and re.fullmatch(r'\.github/workflows/[a-z0-9-]+\.yml', workflow)
             and isinstance(name, str) and 1 <= len(name) <= 160
             and isinstance(label, str) and re.fullmatch(r'domino-job-[a-z0-9-]{1,90}', label)
             and entry.get('profile') in PROFILES
             and type(entry.get('lifetime_seconds')) is int
             and 60 <= entry['lifetime_seconds'] <= 5400, 'policy_job')
        need((workflow, name) not in identities and label not in labels, 'policy_duplicate')
        identities.add((workflow, name))
        labels.add(label)
    return document


def expected_labels(policy, run, entry):
    return set(policy['base_labels']) | {
        policy['run_label_template'].format(run_id=run['id'], run_attempt=run['run_attempt']),
        'domino-ci-' + entry['profile'], entry['job_label']}


def workflow_path(value, repository):
    # REST examples also permit repo/path@ref. The ref is not an authorization
    # shortcut: repository, immutable SHA, event and branch are checked apart.
    if not isinstance(value, str):
        return None
    pattern = (r'(?:' + re.escape(repository) + r'/)?'
               r'(\.github/workflows/[a-z0-9-]+\.yml)(?:@[^@\s]+)?')
    match = re.fullmatch(pattern, value)
    return match[1] if match else None


def authorize(policy, repository, run, job, peers, permissions, workflow):
    """All identity checks precede registration; labels alone never authorize."""
    repo_id, repo = policy['repository_id'], policy['repository']
    need(repository.get('id') == repo_id and repository.get('full_name') == repo
         and repository.get('private') is True and repository.get('fork') is False
         and repository.get('allow_forking') is False, 'repository_not_private_closed')
    need(run.get('repository', {}).get('id') == repo_id
         and run.get('repository', {}).get('full_name') == repo
         and run.get('head_repository', {}).get('id') == repo_id
         and run.get('head_repository', {}).get('fork') is False
         and run.get('status') in ACTIVE and type(run.get('id')) is int
         and type(run.get('run_attempt')) is int and run['run_attempt'] > 0
         and isinstance(run.get('head_sha'), str)
         and re.fullmatch(r'[0-9a-f]{40}', run['head_sha']), 'run_identity')
    for key in ('actor', 'triggering_actor'):
        actor = run.get(key, {}).get('login')
        need(isinstance(actor, str) and permissions.get(actor) in ('write', 'maintain', 'admin'),
             'actor_not_trusted')
    path = workflow_path(run.get('path'), repo)
    need(workflow.get('id') == run.get('workflow_id')
         and workflow_path(workflow.get('path'), repo) == path and path is not None
         and workflow.get('state') == 'active', 'workflow_identity')
    entry = [e for e in policy['jobs'] if e['workflow'] == path
             and e['job_name'] == job.get('name')]
    need(len(entry) == 1, 'job_not_allowed')
    entry = entry[0]
    event = run.get('event')
    need(event in ('push', 'pull_request', 'workflow_dispatch'), 'event_not_allowed')
    if event == 'push' or entry['profile'] == 'deploy':
        need(event != 'pull_request' and run.get('head_branch') == 'main', 'main_required')
    if event == 'pull_request':
        prs = run.get('pull_requests')
        need(isinstance(prs, list) and len(prs) == 1, 'pr_identity')
        pr = prs[0]
        need(pr.get('base', {}).get('ref') == 'main'
             and pr.get('base', {}).get('repo', {}).get('id') == repo_id
             and pr.get('head', {}).get('repo', {}).get('id') == repo_id
             and pr.get('head', {}).get('sha') == run['head_sha'], 'pr_identity')
    labels = job.get('labels', [])
    required = expected_labels(policy, run, entry)
    need(isinstance(labels, list) and len(labels) == len(required) and set(labels) == required,
         'job_labels')
    need(job.get('status') == 'queued' and type(job.get('id')) is int
         and job.get('run_id') == run['id'] and job.get('run_attempt') == run['run_attempt']
         and job.get('head_sha') == run['head_sha']
         and job.get('head_branch') == run.get('head_branch'), 'job_identity')
    compatible = [peer for peer in peers if peer.get('status') == 'queued'
                  and set(peer.get('labels', [])) == required]
    need(len(compatible) == 1 and compatible[0].get('id') == job['id'], 'duplicate_job_labels')
    return entry, sorted(required)


def b64url(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=')


class GitHub:
    def __init__(self, config, policy, *, clock=time.time, transport=None):
        self.config, self.policy, self.clock = config, policy, clock
        self.transport = transport or self._http
        self.token = None
        self.expires = 0

    @staticmethod
    def _http(method, path, credential, payload):
        need(path.startswith('/') and not path.startswith('//') and '\n' not in path,
             'api_path')
        request = urllib.request.Request(API + path,
            data=json.dumps(payload).encode() if payload is not None else None, method=method,
            headers={'Authorization': 'Bearer ' + credential, 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'domino-clawber-broker',
                     'Content-Type': 'application/json'})
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
                raw = response.read(MAX_BYTES + 1)
                need(len(raw) <= MAX_BYTES, 'api_response_limit')
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            raise ApiError(error.code) from None
        except (urllib.error.URLError, OSError, ValueError):
            raise BrokerError('github_transport_failed') from None

    def jwt(self):
        now = int(self.clock())
        header = b64url(b'{"alg":"RS256","typ":"JWT"}')
        claims = b64url(json.dumps({'iat': now - 60, 'exp': now + 540,
            'iss': str(self.config['app_id'])}, separators=(',', ':')).encode())
        signing = header + b'.' + claims
        try:
            result = subprocess.run(['/usr/bin/openssl', 'dgst', '-sha256', '-sign',
                self.config['private_key']], input=signing, capture_output=True, timeout=10)
            need(result.returncode == 0 and result.stdout, 'app_signing_failed')
        except (OSError, subprocess.TimeoutExpired):
            raise BrokerError('app_signing_failed') from None
        return (signing + b'.' + b64url(result.stdout)).decode('ascii')

    def request(self, method, path, payload=None):
        if self.token is None or self.clock() >= self.expires - 120:
            permissions = {'actions': 'read', 'metadata': 'read'}
            permissions['organization_self_hosted_runners' if self.config['runner_scope'] == 'organization'
                        else 'administration'] = 'write'
            answer = self.transport('POST', f"/app/installations/{self.config['installation_id']}/access_tokens",
                self.jwt(), {'repository_ids': [self.policy['repository_id']], 'permissions': permissions})
            token = answer.get('token')
            need(isinstance(token, str) and 1 <= len(token) <= 8192, 'app_token_invalid')
            try:
                expiry = datetime.fromisoformat(answer['expires_at'].replace('Z', '+00:00')).timestamp()
            except (KeyError, TypeError, ValueError):
                raise BrokerError('app_token_expiry_invalid') from None
            need(self.clock() + 120 < expiry <= self.clock() + 3660, 'app_token_expiry_invalid')
            need({r.get('id') for r in answer.get('repositories', [])} == {self.policy['repository_id']},
                 'app_token_repository_invalid')
            # Do not assume a token's format or length; GitHub's formats change.
            self.token, self.expires = token, expiry
        try:
            return self.transport(method, path, self.token, payload)
        except ApiError as error:
            if error.status == 401:
                self.token, self.expires = None, 0
            raise

    def pages(self, path, key):
        values, identifiers = [], set()
        separator = '&' if '?' in path else '?'
        for page in range(1, MAX_PAGES + 1):
            answer = self.request('GET', f'{path}{separator}per_page=100&page={page}')
            rows, total = answer.get(key), answer.get('total_count')
            need(isinstance(rows, list) and type(total) is int and 0 <= total <= 1000,
                 'api_pagination_shape')
            for row in rows:
                need(isinstance(row, dict) and type(row.get('id')) is int
                     and row['id'] not in identifiers, 'api_pagination_duplicate')
                identifiers.add(row['id'])
            values.extend(rows)
            if len(values) == total:
                return values
            need(rows and len(values) < total, 'api_pagination_incomplete')
        raise BrokerError('api_pagination_incomplete')


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.data = {'version': 1, 'active': {}, 'completed': {}, 'retries': {}}
        if self.path.exists():
            self.data = json.loads(self.path.read_text())
            need(self.data.get('version') == 1 and isinstance(self.data.get('active'), dict)
                 and isinstance(self.data.get('completed'), dict), 'state_shape')
            for slot, record in self.data['active'].items():
                need(slot in ('1', '2') and isinstance(record, dict)
                     and type(record.get('job_id')) is int
                     and re.fullmatch(PREFIX + r'[0-9]+-[0-9]+-[0-9]+', record.get('runner_name', ''))
                     and (record.get('runner_id') is None or type(record['runner_id']) is int),
                     'state_shape')
        self.data.setdefault('retries', {})
        need(isinstance(self.data['retries'], dict), 'state_shape')

    def save(self):
        temporary = self.path.with_name(self.path.name + '.new')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(self.data, stream, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.path)
        directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


class Broker:
    def __init__(self, config, policy, api, store, *, popen=subprocess.Popen, run=subprocess.run,
                 clock=time.time):
        self.config, self.policy, self.api, self.store = config, policy, api, store
        self.popen, self.run, self.clock = popen, run, clock
        self.children = {}
        self.stopping = False
        self.repo_path = '/repos/' + policy['repository']
        self.runner_path = ('/orgs/' + config['runner_owner'] if config['runner_scope'] == 'organization'
                            else self.repo_path) + '/actions/runners'

    def controller(self, slot, *, entry=None):
        command = ['/usr/bin/python3', self.config['controller'], '--slot', str(slot)]
        if entry is None:
            return command + ['--cleanup-slot']
        command += ['--guest-profile', 'systemd' if entry['profile'] == 'systemd' else 'normal',
                    '--base-sha256', self.config['base_sha256'],
                    '--timeout-seconds', str(entry['lifetime_seconds'])]
        if self.config.get('base_image'):
            command += ['--base-image', self.config['base_image']]
        return command

    def cleanup_runner(self, record):
        runner_id = record.get('runner_id')
        try:
            if runner_id is not None:
                runner = self.api.request('GET', self.runner_path + '/' + str(runner_id))
                need(runner.get('name') == record['runner_name'], 'runner_cleanup_identity')
                self.api.request('DELETE', self.runner_path + '/' + str(runner_id))
            else:
                # Covers a lost POST response: only delete the persisted exact
                # unique name, never all runners with a convenient prefix.
                matches = [r for r in self.api.pages(self.runner_path, 'runners')
                           if r.get('name') == record['runner_name']]
                need(len(matches) <= 1, 'runner_cleanup_duplicate')
                if matches:
                    self.api.request('DELETE', self.runner_path + '/' + str(matches[0]['id']))
        except ApiError as error:
            if error.status != 404:
                raise

    def finish(self, slot):
        key = str(slot)
        record = self.store.data['active'][key]
        child = self.children.get(slot)
        if child is not None and child.poll() is not None:
            streams = [getattr(child, name, None) for name in ('stdout', 'stderr')]
            raw = [stream.read(4097) if stream is not None else b'' for stream in streams]
            print(json.dumps({'event': 'controller_exit', 'slot': slot, 'job_id': record['job_id'],
                'returncode': child.poll(), **controller_receipt(*raw)}), flush=True)
        result = self.run(self.controller(slot), capture_output=True, timeout=120)
        if result.returncode:
            print(json.dumps({'event': 'controller_recovery_failed', 'slot': slot,
                **controller_receipt(result.stdout, result.stderr)}), flush=True)
        need(result.returncode == 0, 'slot_cleanup_failed')
        self.cleanup_runner(record)
        job_key = str(record['job_id'])
        try:
            job = self.api.request('GET', self.repo_path + '/actions/jobs/' + job_key)
        except ApiError as error:
            if error.status != 404:
                raise
            job = {'status': 'completed'}
        if job.get('status') == 'queued':
            # A crash between JIT creation and guest boot must not permanently
            # consume a still-queued job. Back off failed startup attempts.
            count = self.store.data['retries'].get(job_key, {}).get('count', 0) + 1
            self.store.data['retries'][job_key] = {'count': count,
                'after': self.clock() + min(900, 60 * 2 ** min(count - 1, 4))}
        else:
            self.store.data['completed'][job_key] = int(self.clock())
            self.store.data['retries'].pop(job_key, None)
        self.store.data['completed'] = dict(sorted(self.store.data['completed'].items(),
            key=lambda item: item[1], reverse=True)[:2048])
        del self.store.data['active'][key]
        self.store.save()
        self.children.pop(slot, None)
        print(json.dumps({'event': 'job_released', 'slot': slot, 'job_id': record['job_id']}), flush=True)

    def recover(self):
        # Controller cleanup locks fail closed if an old controller is alive.
        for slot in (1, 2):
            if str(slot) in self.store.data['active']:
                self.finish(slot)
            else:
                result = self.run(self.controller(slot), capture_output=True, timeout=120)
                if result.returncode:
                    print(json.dumps({'event': 'controller_recovery_failed', 'slot': slot,
                        **controller_receipt(result.stdout, result.stderr)}), flush=True)
                need(result.returncode == 0, 'slot_recovery_failed')

    def repository(self):
        return self.api.request('GET', self.repo_path)

    def identity(self, run, jobs, job):
        permissions = {}
        for key in ('actor', 'triggering_actor'):
            name = run.get(key, {}).get('login', '')
            need(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9\[\]-]{0,100}', name),
                 'actor_identity')
            permissions[name] = self.api.request('GET', self.repo_path + '/collaborators/'
                                                 + name + '/permission').get('permission')
        workflow_id = run.get('workflow_id')
        need(type(workflow_id) is int, 'workflow_identity')
        workflow = self.api.request('GET', self.repo_path + '/actions/workflows/' + str(workflow_id))
        return authorize(self.policy, self.repository(), run, job, jobs, permissions, workflow)

    def queued(self):
        runs = {}
        for status in ('queued', 'in_progress'):
            for run in self.api.pages(self.repo_path + '/actions/runs?status=' + status, 'workflow_runs'):
                runs[run['id']] = run
        result = []
        for run in runs.values():
            if workflow_path(run.get('path'), self.policy['repository']) not in {
                    e['workflow'] for e in self.policy['jobs']}:
                continue
            jobs = self.attempt_jobs(run)
            for job in jobs:
                if job.get('status') == 'queued' and 'domino-ci' in job.get('labels', []):
                    result.append((job.get('created_at', run.get('created_at', '')), job['id'], run['id']))
        return sorted(result)

    def attempt_jobs(self, run):
        attempt, run_id = run.get('run_attempt'), run.get('id')
        need(type(attempt) is int and attempt > 0 and type(run_id) is int and run_id > 0,
             'run_identity')
        rows = self.api.pages(self.repo_path + f'/actions/runs/{run_id}/attempts/{attempt}/jobs', 'jobs')
        jobs = []
        for row in rows:
            # run_attempt is optional in the REST schema. Its omission is bound
            # by this authoritative attempt-specific endpoint, never guessed
            # from an untrusted queued job or a previous attempt's history.
            need(row.get('run_attempt', attempt) == attempt and row.get('run_id') == run_id,
                 'job_attempt_identity')
            jobs.append(dict(row, run_attempt=attempt))
        return jobs

    def check_group(self):
        if self.config['runner_scope'] != 'organization':
            return
        group = f"/orgs/{self.config['runner_owner']}/actions/runner-groups/{self.config['runner_group_id']}"
        info = self.api.request('GET', group)
        need(info.get('visibility') == 'selected' and info.get('allows_public_repositories') is False,
             'runner_group_not_restricted')
        repos = self.api.pages(group + '/repositories', 'repositories')
        need({r['id'] for r in repos} == {self.policy['repository_id']}, 'runner_group_repository')

    def launch(self, slot, run_id, job_id):
        # Refetch every source immediately before creating the registration.
        run = self.api.request('GET', self.repo_path + f'/actions/runs/{run_id}')
        need(run.get('id') == run_id, 'run_identity')
        jobs = self.attempt_jobs(run)
        selected = [j for j in jobs if j['id'] == job_id]
        need(len(selected) == 1, 'job_no_longer_queued')
        entry, labels = self.identity(run, jobs, selected[0])
        self.check_group()
        name = f"{PREFIX}{run_id}-{run['run_attempt']}-{job_id}"
        record = {'run_id': run_id, 'run_attempt': run['run_attempt'], 'head_sha': run['head_sha'],
                  'job_id': job_id, 'runner_name': name, 'runner_id': None,
                  'started': self.clock(), 'lifetime_seconds': entry['lifetime_seconds']}
        self.store.data['active'][str(slot)] = record
        self.store.save()  # Crash before/after POST remains recoverable by name.
        try:
            answer = self.api.request('POST', self.runner_path + '/generate-jitconfig',
                {'name': name, 'runner_group_id': self.config['runner_group_id'],
                 'labels': labels, 'work_folder': '_work'})
            runner_id = answer.get('runner', {}).get('id')
            need(type(runner_id) is int and runner_id > 0, 'jit_response_invalid')
            record['runner_id'] = runner_id
            self.store.save()
            jit = answer.get('encoded_jit_config')
            need(isinstance(jit, str) and 0 < len(jit) <= 1_048_576 and jit.isascii(),
                 'jit_response_invalid')
            need(not self.stopping, 'broker_stopping')
            child = self.popen(self.controller(slot, entry=entry), stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            self.children[slot] = child
            child.stdin.write(jit.encode('ascii'))
            child.stdin.close()
            print(json.dumps({'event': 'job_started', 'slot': slot, 'job_id': job_id,
                              'profile': entry['profile']}), flush=True)
        except BaseException:
            child = self.children.get(slot)
            if child is not None:
                self.stop_child(child)
            self.finish(slot)
            raise

    @staticmethod
    def stop_child(child):
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                child.wait(timeout=10)
                return
            try:
                child.wait(timeout=120)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=10)

    def cycle(self):
        for slot, record in list(self.store.data['active'].items()):
            slot = int(slot)
            child = self.children.get(slot)
            if child is None or child.poll() is not None:
                self.finish(slot)
                continue
            job = self.api.request('GET', self.repo_path + f"/actions/jobs/{record['job_id']}")
            run = self.api.request('GET', self.repo_path + f"/actions/runs/{record['run_id']}")
            if (job.get('status') == 'completed' or run.get('status') == 'completed'
                    or run.get('run_attempt') != record['run_attempt']
                    or job.get('run_id') != record['run_id'] or job.get('head_sha') != record['head_sha']
                    or self.clock() > record['started'] + record['lifetime_seconds'] + 120):
                self.stop_child(child)
                self.finish(slot)
        if self.stopping or len(self.store.data['active']) >= 2:
            return
        for _, job_id, run_id in self.queued():
            if (str(job_id) in self.store.data['completed']
                    or self.store.data['retries'].get(str(job_id), {}).get('after', 0) > self.clock()
                    or any(r['job_id'] == job_id for r in self.store.data['active'].values())):
                continue
            slots = [s for s in (1, 2) if str(s) not in self.store.data['active']]
            if not slots:
                break
            try:
                self.launch(slots[0], run_id, job_id)
            except BrokerError as error:
                error_event('job_deferred', error, job_id=job_id)

    def shutdown(self):
        self.stopping = True
        # Stop both guests even if one API cleanup is temporarily unavailable.
        failed = False
        for child in list(self.children.values()):
            try:
                self.stop_child(child)
            except (OSError, subprocess.SubprocessError):
                failed = True
        for slot in list(self.children):
            try:
                self.finish(slot)
            except (BrokerError, OSError, ValueError, KeyError, subprocess.SubprocessError):
                failed = True
        need(not failed, 'shutdown_cleanup_pending')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--policy', type=Path, required=True)
    args = parser.parse_args()
    broker = None
    try:
        need(os.geteuid() == 0, 'root_required')
        secure_path(Path(__file__).absolute())
        config = json.loads(secure_path(args.config, secret=True).read_text())
        policy = load_policy(json.loads(secure_path(args.policy).read_text()))
        config.setdefault('runner_scope', 'organization')
        config.setdefault('runner_owner', 'domino-money')
        need(config['runner_scope'] in ('organization', 'repository')
             and config['runner_owner'] == 'domino-money'
             and type(config.get('app_id')) in (int, str)
             and re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', str(config['app_id']))
             and type(config.get('installation_id')) is int and config['installation_id'] > 0
             and type(config.get('runner_group_id')) is int and config['runner_group_id'] > 0
             and re.fullmatch(r'[0-9a-f]{64}', config.get('base_sha256', '')), 'config_shape')
        key = config.get('private_key') or str(Path(os.environ.get('CREDENTIALS_DIRECTORY',
            '/run/credentials/domino-clawber-broker.service')) / 'github-app.pem')
        config['private_key'] = str(secure_path(key, secret=True))
        config['controller'] = str(secure_path(config['controller']))
        if config.get('base_image'):
            secure_path(config['base_image'])
        state_dir = secure_path(config.get('state_directory', '/var/lib/domino-clawber-broker'), directory=True)
        lock = os.open(state_dir / 'broker.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state_path = state_dir / 'state.json'
        if state_path.exists():
            secure_path(state_path, secret=True)
        store = Store(state_path)
        broker = Broker(config, policy, GitHub(config, policy), store)
        broker.recover()
        def stop(signum, frame):
            broker.stopping = True
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        while not broker.stopping:
            try:
                broker.cycle()
            except (BrokerError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
                error_event('broker_retry', error)
            # Sleep in short slices so termination does not wait for a poll.
            for _ in range(30):
                if broker.stopping:
                    break
                time.sleep(1)
        broker.shutdown()
        return 0
    except (BrokerError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        error_event('broker_failed', error)
        return 1
    finally:
        if broker is not None and broker.children:
            try:
                broker.shutdown()
            except (BrokerError, OSError, ValueError, KeyError, subprocess.SubprocessError):
                print('{"event":"broker_failed","code":"shutdown_cleanup_pending"}', file=sys.stderr)


if __name__ == '__main__':
    raise SystemExit(main())
