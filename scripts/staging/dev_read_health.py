#!/usr/bin/env python3
"""Observe the DEV reader without changing services, firewall or configuration.

Only private status/cache files under --state-dir are written. Run from a root
systemd timer; stdout contains a sanitized journal event only when issues change.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


ROOT = Path('/etc/domino/dev')
CONTROL = Path('/etc/domino/dev-maintenance/control.json')
ACCESS = Path('/etc/domino/dev-maintenance/access.json')
PUBLIC_STATUS = 'https://dev-read.domino.money/internal/dev/v1/status'
WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
UNITS = ('domino-dev-read.service', 'domino-dev-gateway.service', 'domino-dev-tunnel.service')
TOKEN_INTERVAL = 900


def read_json(path, *, credential=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError('invalid_file')
        if credential and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError('invalid_permissions')
        raw = stream.read(262145)
    if len(raw) > 262144:
        raise ValueError('oversized_file')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('invalid_object')
    return value


def atomic_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream, sort_keys=True, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def http_json(url, *, payload=None, headers=None):
    """Bounded request; never follow an Access redirect carrying credentials."""
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, headers={
        'Accept': 'application/json', 'User-Agent': 'Domino-dev-health/1.0',
        **({'Content-Type': 'application/json'} if data else {}),
        **(headers or {})})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        response = opener.open(request, timeout=18 if payload else 3)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(32769)
        if len(raw) > 32768:
            raise ValueError('oversized_response')
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeError):
            body = None
        return response.code, body


def command(argv):
    return subprocess.run(argv, check=True, capture_output=True, text=True,
                          timeout=3, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'TZ': 'UTC'}).stdout


def epoch(value):
    if type(value) is int and value > 0:
        return value
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp())
    raise ValueError('invalid_deadline')


def nft_deadline(document):
    """Require a finite matching deadline on each effective DEV permission."""
    ends, roles = set(), set()
    for entry in document.get('nftables', []):
        rule = entry.get('rule', {})
        if rule.get('family') != 'inet' or rule.get('table') != 'domino_dev_off':
            continue
        role = rule.get('chain')
        if role not in ('reader', 'gateway', 'tunnel'):
            continue
        expressions = rule.get('expr', [])
        if not any('accept' in item for item in expressions):
            continue
        if rule.get('comment') == 'loopback listener reply':
            continue
        rule_ends = []
        for item in expressions:
            match = item.get('match', {})
            if match.get('left') == {'meta': {'key': 'time'}} and match.get('op') == '<':
                rule_ends.append(epoch(match['right']))
        if len(rule_ends) != 1:
            raise ValueError('ungated_effective_permission')
        ends.update(rule_ends)
        roles.add(role)
    if len(ends) != 1 or roles != {'reader', 'gateway', 'tunnel'}:
        raise ValueError('inconsistent_effective_deadline')
    return ends.pop()


def valid_token(status, body):
    if status != 200 or not isinstance(body, dict):
        return False
    asset, snapshot = body.get('asset'), body.get('snapshot')
    return (body.get('mode') == 'public_token_read_only' and body.get('chainId') == 4663
            and body.get('liveExecution') is False and isinstance(asset, dict)
            and isinstance(asset.get('address'), str) and asset['address'].lower() == WETH
            and asset.get('readStatus') == 'available'
            and isinstance(snapshot, dict) and type(snapshot.get('number')) is int
            and 0 <= snapshot['number'] <= 2**53 - 1)


def collect(state_dir, previous, now):
    sample = {'errors': [], 'deadlines': {}, 'units': {}, 'external': {'state': 'not_verified'}}

    def observe(name, action):
        try:
            return action()
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            sample['errors'].append(name)
            return None

    reader_path = ROOT / 'reader/profile.json'
    reader = observe('reader_profile_unavailable', lambda: read_json(reader_path))
    admission = observe('gateway_admission_unavailable', lambda: read_json(ROOT / 'gateway/admission.json'))
    control = observe('maintenance_control_unavailable', lambda: read_json(CONTROL))
    lease = observe('maintenance_lease_unavailable', lambda: read_json(state_dir / 'lease.json'))
    for name, value in (('reader', reader), ('gateway', admission), ('lease', lease)):
        if value is not None:
            source = value.get('quotaQualification', {}) if name == 'reader' else value
            deadline = observe(name + '_deadline_invalid', lambda: epoch(source.get('expiresAt')))
            if deadline is not None:
                sample['deadlines'][name] = deadline
    sample['readerEnabled'] = reader is not None and reader.get('enabled') is True and reader.get('quotaQualification', {}).get('approved') is True
    sample['gatewayEnabled'] = admission is not None and admission.get('enabled') is True
    sample['managerEnabled'] = control is not None and control.get('enabled') is True
    saved = observe('saved_firewall_unavailable', lambda: (ROOT / 'off-policy.nft').read_text())
    if saved is not None:
        ends = set(re.findall(r'meta time < ([0-9]+)', saved))
        if len(ends) == 1:
            sample['deadlines']['savedFirewall'] = int(ends.pop())
        else:
            sample['errors'].append('saved_firewall_deadline_invalid')
    effective = observe('effective_firewall_unavailable', lambda: nft_deadline(json.loads(
        command(['/usr/sbin/nft', '-j', 'list', 'table', 'inet', 'domino_dev_off']))))
    if effective is not None:
        sample['deadlines']['effectiveFirewall'] = effective
    if (state_dir / 'transaction.json').exists():
        transaction = observe('maintenance_transaction_invalid', lambda: read_json(state_dir / 'transaction.json'))
        if transaction is not None:
            started = observe('maintenance_transaction_time_invalid', lambda: epoch(transaction.get('startedAt')))
            if started is not None and started <= now:
                sample['transactionAgeSeconds'] = max(0, now - started)
            elif started is not None:
                sample['errors'].append('maintenance_transaction_time_in_future')
    if (state_dir / 'last-error.json').exists():
        failure = observe('maintenance_failure_record_invalid', lambda: read_json(state_dir / 'last-error.json'))
        if failure is not None:
            failed_at = observe('maintenance_failure_time_invalid', lambda: epoch(failure.get('at', failure.get('timestamp'))))
            if failed_at is not None and failed_at >= (lease or {}).get('updatedAt', 0):
                code = failure.get('code')
                sample['managerFailure'] = {'at': failed_at, 'code': code if isinstance(code, str)
                    and re.fullmatch(r'[a-zA-Z0-9_:-]{1,100}', code) else 'unclassified'}
    uptime = observe('system_uptime_unavailable', lambda: float(Path('/proc/uptime').read_text().split()[0]))
    for unit in UNITS:
        raw = observe('unit_observation_failed:' + unit, lambda: command([
            '/usr/bin/systemctl', 'show', unit, '--property=ActiveState,ActiveEnterTimestampMonotonic']))
        if raw is not None:
            values = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
            sample['units'][unit] = values.get('ActiveState')
            if unit == UNITS[0] and uptime is not None:
                entered = observe('reader_start_time_invalid', lambda: int(values['ActiveEnterTimestampMonotonic']) / 1_000_000)
                if entered is not None and entered > 0:
                    sample['readerUptimeSeconds'] = max(0, uptime - entered)
                    mtime = observe('reader_profile_stat_failed', lambda: reader_path.stat().st_mtime)
                    if mtime is not None:
                        sample['readerProfileAfterStart'] = mtime > now - sample['readerUptimeSeconds'] + 1
    health = observe('reader_health_unavailable', lambda: http_json('http://127.0.0.1:8890/health'))
    if health is not None:
        status, body = health
        valid = (isinstance(body, dict) and body.get('status') == 'ok'
                 and body.get('mode') == 'local_read_only' and isinstance(body.get('devAdmission'), dict))
        admission_state = body['devAdmission'].get('state') if valid else None
        if admission_state not in ('ready', 'cooldown', 'qualification_disabled', 'qualification_expired'):
            admission_state = 'invalid'
        sample['readerHealth'] = {'httpStatus': status, 'state': admission_state}
    denial = observe('gateway_probe_unavailable', lambda: http_json('http://127.0.0.1:8891/internal/dev/v1/status'))
    if denial is not None:
        sample['gatewayDenial'] = denial[0] == 403
    ready = observe('tunnel_ready_unavailable', lambda: http_json('http://127.0.0.1:20242/ready'))
    if ready is not None:
        status, body = ready
        count = body.get('readyConnections') if isinstance(body, dict) else None
        if type(count) is int and count >= 0 and status == (200 if count else 503):
            sample['haConnections'] = count
        else:
            sample['errors'].append('tunnel_ready_invalid')
    cached = previous.get('tokenProbe')
    last_probe = previous.get('lastTokenProbeAt', 0)
    # Persist an attempted read as well as a successful one to bound quota usage.
    if (sample.get('readerHealth', {}).get('state') == 'ready'
            and (type(last_probe) not in (int, float) or now - last_probe >= TOKEN_INTERVAL or last_probe > now)):
        token = observe('token_probe_transport_failed', lambda: http_json(
            'http://127.0.0.1:8890/v1/read/token', payload={'token': WETH}))
        cached = {'at': now, 'ok': token is not None and valid_token(*token)}
        if token is not None:
            cached['httpStatus'] = token[0]
        if cached['ok']:
            cached['snapshotNumber'] = token[1]['snapshot']['number']
        sample['lastTokenProbeAt'] = now
    else:
        sample['lastTokenProbeAt'] = last_probe
    sample['tokenProbe'] = cached
    try:
        credential = read_json(ACCESS, credential=True)
        if (set(credential) not in ({'clientId', 'clientSecret'}, {'version', 'clientId', 'clientSecret'}) or
                ('version' in credential and (type(credential['version']) is not int or credential['version'] != 1)) or
                any(not isinstance(value, str) or not value or len(value) > 8192 or '\n' in value or '\r' in value
                    for value in (credential.get('clientId'), credential.get('clientSecret')))):
            raise ValueError('invalid_credential')
    except FileNotFoundError:
        sample['external'] = {'state': 'credential_missing'}
    except (OSError, ValueError):
        sample['external'] = {'state': 'credential_invalid'}
    else:
        public = observe('external_status_unavailable', lambda: http_json(PUBLIC_STATUS, headers={
            'CF-Access-Client-Id': credential['clientId'], 'CF-Access-Client-Secret': credential['clientSecret']}))
        if public is not None:
            status, body = public
            valid = (status == 200 and isinstance(body, dict) and body.get('schemaVersion') == 1
                     and body.get('environment') == 'development' and body.get('authenticated') is True
                     and body.get('readEnabled') is True and isinstance(body.get('readerConnection'), dict)
                     and body['readerConnection'].get('state') == 'ready')
            sample['external'] = {'state': 'verified' if valid else 'failed', 'httpStatus': status}
    return sample


def assess(sample, previous, now):
    issues = []
    fresh_transaction = 0 <= sample.get('transactionAgeSeconds', 180) < 180
    transient_codes = {'deadline_mismatch', 'reader_profile_newer_than_process', 'reader_not_ready',
                       'reader_health_unavailable', 'tunnel_ready_unavailable', 'gateway_probe_unavailable',
                       'tunnel_disconnected', 'tunnel_degraded', 'lease_expired', 'functional_token_failed',
                       'functional_token_not_verified', 'token_probe_transport_failed'}

    def issue(code, severity='critical'):
        if fresh_transaction and (code in transient_codes or code.startswith('unit_inactive:')):
            severity = 'info'
        issues.append({'code': code, 'severity': severity})

    for error in sample.get('errors', []):
        issue(error)
    for unit in UNITS:
        if sample.get('units', {}).get(unit) != 'active':
            issue('unit_inactive:' + unit)
    for enabled, name in (('readerEnabled', 'reader_disabled'), ('gatewayEnabled', 'gateway_disabled')):
        if not sample.get(enabled):
            issue(name)
    if not sample.get('managerEnabled'):
        issue('automatic_renewal_disabled', 'warning')
    deadlines = sample.get('deadlines', {})
    if len(deadlines) != 5:
        issue('deadline_evidence_incomplete')
    elif len(set(deadlines.values())) != 1:
        issue('deadline_mismatch')
    remaining = min(deadlines.values()) - now if deadlines else None
    if remaining is not None:
        if remaining <= 0:
            issue('lease_expired')
        elif remaining <= 3600:
            issue('lease_expires_within_1h', 'warning')
        elif remaining <= 86400:
            issue('lease_expires_within_24h', 'warning')
        elif remaining <= 172800:
            issue('lease_expires_within_48h', 'warning')
    if sample.get('managerFailure'):
        issue('renewal_blocked', 'critical' if remaining is not None and remaining <= 3600 else 'warning')
    if 'transactionAgeSeconds' in sample:
        issue('maintenance_in_progress' if sample['transactionAgeSeconds'] < 180 else 'maintenance_transaction_stale',
              'info' if sample['transactionAgeSeconds'] < 180 else 'critical')
    if sample.get('readerProfileAfterStart'):
        issue('reader_profile_newer_than_process')
    health = sample.get('readerHealth', {})
    warming = health.get('state') == 'cooldown' and sample.get('readerUptimeSeconds', 91) <= 90
    if warming:
        issue('reader_startup_cooldown', 'info')
    elif health != {'httpStatus': 200, 'state': 'ready'}:
        issue('reader_not_ready')
    if sample.get('gatewayDenial') is False:
        issue('gateway_missing_assertion_not_denied')
    state = {'schemaVersion': 1, 'lastTokenProbeAt': sample.get('lastTokenProbeAt', 0), 'tokenProbe': sample.get('tokenProbe')}
    connections = sample.get('haConnections', 0)
    for key, failing, seconds, code, severity in (
            ('zeroConnectionsSince', connections == 0, 60, 'tunnel_disconnected', 'critical'),
            ('degradedConnectionsSince', connections < 4, 120, 'tunnel_degraded', 'warning')):
        if failing:
            since = previous.get(key, now)
            since = since if type(since) in (int, float) and 0 <= since <= now else now
            state[key] = since
            if now - since >= seconds:
                issue(code, severity)
    token = sample.get('tokenProbe')
    if not isinstance(token, dict):
        if not warming:
            issue('functional_token_not_verified', 'warning')
    elif token.get('httpStatus') == 429:
        issue('functional_token_probe_rate_limited', 'warning')
    elif token.get('ok') is not True:
        issue('functional_token_failed')
    elif now - token.get('at', 0) > 1800:
        issue('functional_token_evidence_stale', 'warning')
    external = sample.get('external', {'state': 'not_verified'})
    if external['state'] == 'credential_missing':
        issue('external_not_verified_access_credential_missing', 'warning')
    elif external['state'] != 'verified':
        issue('external_not_verified:' + external['state'])
    issues.sort(key=lambda item: item['code'])
    severity = ('critical' if any(x['severity'] == 'critical' for x in issues) else
                'warning' if any(x['severity'] == 'warning' for x in issues) else 'healthy')
    report = {'schemaVersion': 1, 'checkedAt': now, 'severity': severity, 'issues': issues,
              'deadlines': deadlines, 'leaseRemainingSeconds': remaining,
              'externalVerification': external,
              'checks': {'units': sample.get('units', {}), 'reader': health,
                         'haConnections': sample.get('haConnections'),
                         'functionalToken': token, 'gatewayMissingAssertionDenied': sample.get('gatewayDenial'),
                         'transactionAgeSeconds': sample.get('transactionAgeSeconds'),
                         'readerProfileAfterStart': sample.get('readerProfileAfterStart'),
                         'readerUptimeSeconds': sample.get('readerUptimeSeconds'),
                         'managerFailure': sample.get('managerFailure')}}
    return report, state


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/domino-dev-maintenance'))
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        parser.error('run as root to inspect private DEV configuration')
    args.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = args.state_dir.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        parser.error('state directory must be a root-owned private directory')
    fd = os.open(args.state_dir / 'health.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        try:
            previous = read_json(args.state_dir / 'health-state.json')
        except (OSError, ValueError):
            previous = {}
        now = int(time.time())
        report, state = assess(collect(args.state_dir, previous, now), previous, now)
        fingerprint = {'severity': report['severity'], 'issues': report['issues']}
        state['lastTransition'] = fingerprint
        atomic_json(args.state_dir / 'status.json', report)
        atomic_json(args.state_dir / 'health-state.json', state)
        if previous.get('lastTransition') != fingerprint:
            print(json.dumps({'event': 'domino_dev_health_transition', **fingerprint}, sort_keys=True))
        return 1 if report['severity'] == 'critical' else 0


if __name__ == '__main__':
    raise SystemExit(main())
