#!/usr/bin/env python3
"""Operator-side launch for an already dispatched, trusted main-only pilot.

GitHub CLI authentication stays on this computer. Only the one-use runner JIT
configuration crosses SSH stdin. No PAT is sent to Clawber or a CI guest.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

REPO = 'domino-money/domino'
WORKFLOW = '.github/workflows/clawber-ci-pilot.yml'
LIFETIMES = {'read-worker': 900, 'contracts-v1': 5400, 'contracts-v2-audit': 5400, 'browser-finance-create': 2100, 'backend': 3000}
WORKLOADS = set(LIFETIMES)


def gh(path, *, method='GET', payload=None):
    args = ['gh', 'api', '--method', method, path]
    if payload is not None:
        args += ['--input', '-']
    result = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                            text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('GitHub API request failed; no credential was printed')
    return json.loads(result.stdout) if result.stdout.strip() else None


def all_attempt_jobs(run_id):
    """Read complete job history, with a bounded fail-closed pagination limit."""
    jobs = []
    for page in range(1, 11):
        reply = gh(f'repos/{REPO}/actions/runs/{run_id}/jobs?filter=all&per_page=100&page={page}')
        jobs.extend(reply['jobs'])
        if len(jobs) >= reply['total_count']:
            return jobs
        if not reply['jobs']:
            break
    raise ValueError('Incomplete or excessive workflow job history')


def authorize(run, jobs, *, actor, sha, workload, prior_jobs=()):
    # The workflow's main-only preflight must have passed before any runner is
    # registered. Its immutable SHA is checked again by both comparison jobs.
    if (run.get('event') != 'workflow_dispatch' or run.get('head_branch') != 'main'
            or run.get('head_sha') != sha or run.get('path') != WORKFLOW
            or run.get('repository', {}).get('full_name') != REPO
            or run.get('actor', {}).get('login') != actor
            or run.get('triggering_actor', {}).get('login') != actor
            or run.get('status') not in ('queued', 'in_progress')
            or workload not in WORKLOADS):
        raise ValueError('Run is not this operator\'s dispatched main-only pilot')
    run_label = f"domino-ci-{run['id']}-{run['run_attempt']}"
    legacy = {'self-hosted', 'Linux', 'X64', 'domino-ci-pilot', run_label}
    current = {'self-hosted', 'Linux', 'X64', 'domino-ci', run_label,
               'domino-ci-normal', f'domino-job-pilot-{workload}'}
    def same_source(job, attempt):
        return (job.get('run_id') == run['id'] and job.get('run_attempt') == attempt
                and job.get('head_sha') == sha and job.get('head_branch') == 'main')

    preflight = [j for j in jobs if j.get('name') == 'Require a dispatched main commit']
    preflight_attempt = run['run_attempt']
    if not preflight:
        # Rerunning only a failed comparison does not rerun its successful
        # prerequisite. Reuse only the latest prior preflight for this run;
        # a failed/pending preflight in the current attempt is never bypassed.
        historical = [j for j in prior_jobs if j.get('name') == 'Require a dispatched main commit'
                      and isinstance(j.get('run_attempt'), int)
                      and 0 < j['run_attempt'] < run['run_attempt']]
        if historical:
            preflight_attempt = max(j['run_attempt'] for j in historical)
            preflight = [j for j in historical if j['run_attempt'] == preflight_attempt]
    queued = [j for j in jobs if j.get('name') == f'{workload} (clawber)'
              and j.get('status') == 'queued' and same_source(j, run['run_attempt'])
              and set(j.get('labels', [])) in (legacy, current)]
    if (len(preflight) != 1 or preflight[0].get('status') != 'completed'
            or preflight[0].get('conclusion') != 'success'
            or not same_source(preflight[0], preflight_attempt) or len(queued) != 1):
        raise ValueError('Require one queued matching job after a successful trusted-main preflight')
    return sorted(queued[0]['labels'])


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run-id', type=int, required=True)
    p.add_argument('--sha', required=True, help='Reviewed full main commit SHA')
    p.add_argument('--workload', choices=sorted(WORKLOADS), required=True)
    p.add_argument('--ssh-config', type=Path, required=True)
    p.add_argument('--ssh-host', required=True)
    p.add_argument('--base-sha256', required=True)
    p.add_argument('--timeout-seconds', type=int, help='Override the workload-specific bounded VM lifetime')
    args = p.parse_args()
    if args.timeout_seconds is None:
        args.timeout_seconds = LIFETIMES[args.workload]
    if (args.run_id < 1 or not re.fullmatch('[0-9a-f]{40}', args.sha)
            or not re.fullmatch('[0-9a-f]{64}', args.base_sha256)
            or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]*', args.ssh_host)
            or not 1 <= args.timeout_seconds <= 5400 or not args.ssh_config.is_file()):
        p.error('Invalid run, hash, SSH profile or lifetime')
    runner_id = None
    try:
        actor = gh('user')['login']
        permission = gh(f'repos/{REPO}/collaborators/{actor}/permission')['permission']
        if permission not in ('admin', 'maintain', 'write'):
            raise ValueError('Operator must be a repository maintainer')
        run = gh(f'repos/{REPO}/actions/runs/{args.run_id}')
        jobs = gh(f'repos/{REPO}/actions/runs/{args.run_id}/attempts/{run["run_attempt"]}/jobs?per_page=100')['jobs']
        prior_jobs = (all_attempt_jobs(args.run_id)
                      if not any(j.get('name') == 'Require a dispatched main commit' for j in jobs) else [])
        labels = authorize(run, jobs, actor=actor, sha=args.sha, workload=args.workload, prior_jobs=prior_jobs)
        response = gh(f'repos/{REPO}/actions/runners/generate-jitconfig', method='POST', payload={
            'name': f'domino-ci-{args.run_id}-{run["run_attempt"]}',
            'runner_group_id': 1, 'labels': labels, 'work_folder': '_work'})
        runner_id = response['runner']['id']
        # All interpolated remote values are validated numeric/hex constants.
        command = ('sudo -n python3 /mnt/narrative-ssd/domino-ci-pilot/source/clawber_pilot.py '
                   f'--base-sha256 {args.base_sha256} --timeout-seconds {args.timeout_seconds}')
        result = subprocess.run(['ssh', '-T', '-F', str(args.ssh_config), '-o', 'BatchMode=yes',
                                 '-o', 'StrictHostKeyChecking=yes', args.ssh_host, command],
                                input=response['encoded_jit_config'].encode('ascii'))
        return result.returncode
    except (ValueError, RuntimeError, KeyError, OSError):
        print('Pilot launch failed; check run identity, preflight, permissions and host lifecycle output.', file=sys.stderr)
        return 1
    finally:
        if runner_id is not None:
            # A completed JIT runner normally deregisters itself. If startup
            # failed, remove the unused registration rather than leaving it.
            subprocess.run(['gh', 'api', '--method', 'DELETE',
                            f'repos/{REPO}/actions/runners/{runner_id}'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    raise SystemExit(main())
