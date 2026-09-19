"""Focused offline enable package, boundary and revocation ordering checks."""
from contextlib import ExitStack
import copy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import stat
import sys
import itertools
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_enable as d


class EnableTests(unittest.TestCase):
    def test_domino_rpc_token_path_is_accepted_only_by_explicit_host_pin(self):
        endpoint = 'https://rpc.domino.money/' + 'SYNTHETIC_ONLY_01' + '/'
        d.endpoint(endpoint, {'rpc.domino.money'})
        with self.assertRaises(d.n.Refused):
            d.endpoint(endpoint, {'robinhood-mainnet.g.alchemy.com'})
        c, b, p, _, _ = self.fixture()
        b['snapshot']['rpcHosts'].append('rpc.domino.money')
        value = d.n.parse(p['files'][d.READER]['bytes'])
        value['rpcUrls'].insert(0, endpoint)
        value['inventoryUrl'] = 'https://robinhood-mainnet.g.alchemy.com/v2/offline-fixture'
        self.changed_artifact(p, d.READER, value)
        self.load(c, b, p)

    def test_domino_rpc_token_paths_and_transport_fail_closed_without_echo(self):
        token = 'PRIVATE_CANARY_123456789'
        good = 'https://rpc.domino.money/' + token + '/'
        for endpoint in ('https://rpc.domino.money/', 'https://rpc.domino.money/short/',
                         good[:-1], good + 'extra', good + '?secret=' + token,
                         good + '#' + token, good.replace('https:', 'http:'),
                         good.replace('https:', 'wss:'),
                         good.replace('rpc.domino.money', 'rpc.domino.money.evil.example'),
                         'https://rpc.domino.money/' + 'a' * 257 + '/'):
            with self.subTest(endpoint=endpoint), self.assertRaises(d.n.Refused) as raised:
                d.endpoint(endpoint, {'rpc.domino.money'})
            self.assertNotIn(token, str(raised.exception))
        for size in (16, 256):
            d.endpoint('https://rpc.domino.money/' + 'a' * size + '/', {'rpc.domino.money'})

    def fixture(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        auth = {'authorizationId': 'a'*64, 'grantedAt': now.isoformat(),
                'expiresAt': (now+timedelta(days=7)).isoformat(), 'revoked': False}
        files, manifest = d.n.infra.generate({'version': 1, 'releaseCommit': d.n.RELEASE,
            'contractManifestSha256': 'b'*64, 'issuer': d.ISSUER, 'audience': d.AUDIENCE,
            'serviceId': 'pending-dev-provisioning'})
        c = {'digest': 'c'*64, 'files': files, 'manifest': manifest,
             'sql': {'expectedAfter': {'offlineExpectedAcl': True}}}
        policy = '/etc/domino/dev/off-policy.nft'
        artifacts = {policy: 'positive'}
        for role in d.ROLES:
            artifacts['/etc/domino/dev/' + role + '/hosts'] = '127.0.0.1 localhost\n'
            artifacts['/etc/systemd/system/' + d.n.infra.USERS[role] + '.service.d/50-dev-egress.conf'] = (
                '[Service]\nIPAddressAllow=\nIPAddressAllow=127.0.0.1/32\nIPAddressAllow=1.1.1.1/32\n')
        b = {'path': Path('/private/network'), 'digest': 'd'*64,
             'snapshot': {'operatorAuthorization': auth, 'rpcHosts': ['robinhood-mainnet.g.alchemy.com'],
                          'inventoryHost': 'robinhood-mainnet.g.alchemy.com'},
             'result': {'artifacts': artifacts, 'expiresAt': auth['expiresAt']}}
        expires = int(d.stamp(auth['expiresAt']).timestamp())
        reader = {'version': 1, 'kind': 'domino-development-reader', 'enabled': True,
            'runtimeDirectory': '/var/lib/domino-dev/reader',
            'rpcUrls': ['https://robinhood-mainnet.g.alchemy.com/v2/offline-fixture'],
            'inventoryUrl': None, 'catalogue': {'host': '/run/postgresql-domino', 'port': 8877, 'dbname': 'domino_catalogue'},
            'quotaQualification': {'approved': True, 'expiresAt': expires, 'receiptSha256': 'e'*64}}
        gateway = d.n.parse(files[d.GATEWAY]['bytes']); gateway['serviceId'] = d.SERVICE_ID
        raw = {d.READER: d.n.encode(reader), d.GATEWAY: d.n.encode(gateway),
               d.ADMISSION: d.n.encode({'version': 1, 'enabled': True, 'serviceId': d.SERVICE_ID, 'expiresAt': expires}),
               d.TUNNEL: files[d.TUNNEL]['bytes'], **{p: d.enable_dropin(r) for r, p in d.DROPINS.items()}}
        doc = {'version': 1, 'kind': 'domino-dev-enable-v1', 'nativeCandidateSha256': c['digest'],
               'networkResultSha256': b['digest'], 'releaseCommit': d.n.RELEASE,
               'authorizationId': auth['authorizationId'], 'expiresAt': auth['expiresAt'], 'tokenSha256': 'f'*64,
               'artifacts': {p: {**d.metadata(p), 'text': value.decode(), 'sha256': d.n.sha(value)} for p, value in raw.items()}}
        package = {'path': Path('/private/enable'), 'digest': '9'*64, 'document': doc,
                   'files': {p: {**d.metadata(p), 'bytes': value} for p, value in raw.items()}}
        state = {'phase': 'installed_off', 'productionExtra': {},
                 'network': {'phase': 'enabled_apps', 'resultSha256': b['digest'], 'offKernel': {}, 'positiveKernel': {}},
                 'enable': {'packageSha256': package['digest'], 'phase': 'enabled'}}
        network = Mock(POLICY=policy)
        return c, b, package, state, network

    def load(self, c, b, package):
        info = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_gid=0)
        with patch.object(d.n, 'parents'), patch.object(Path, 'lstat', return_value=info), \
             patch.object(d.n, 'checked_document', return_value=package['document']):
            return d.load(package['path'], package['digest'], c, b)

    def changed_artifact(self, package, target, value):
        raw = d.n.encode(value) if isinstance(value, dict) else value
        package['document']['artifacts'][target].update(text=raw.decode(), sha256=d.n.sha(raw))

    def test_exact_package_and_alias_commands(self):
        c, b, p, _, _ = self.fixture()
        result = self.load(c, b, p)
        self.assertEqual(result['files'], p['files'])
        reader = d.enable_dropin('reader').decode()
        self.assertIn('ExecStart=\nExecStart=/usr/bin/env -i ', reader)
        self.assertIn('--enable --profile /run/domino-dev-reader-config/profile.json', reader)
        self.assertNotIn('--port', reader)
        gateway = d.enable_dropin('gateway').decode()
        self.assertIn('--runtime-dir /var/lib/domino-dev/dev-read-gateway --port 8891 --reader-port 8890 --enable', gateway)
        self.assertIn('--profile /run/domino-dev-gateway-config/profile.json', gateway)
        self.assertNotIn('--enable', d.enable_dropin('tunnel').decode())

    def test_only_gateway_service_id_may_change(self):
        for key, value in [('audience', '0'*64), ('readerPort', 8876), ('burst', 5), ('enabled', True)]:
            c, b, p, _, _ = self.fixture()
            profile = d.n.parse(p['files'][d.GATEWAY]['bytes']); profile[key] = value
            self.changed_artifact(p, d.GATEWAY, profile)
            with self.subTest(key=key), self.assertRaises(d.n.Refused): self.load(c, b, p)

    def test_package_rejects_other_source_token_hash_or_extra_target(self):
        for key, value in [('releaseCommit', '0'*40), ('tokenSha256', 'invalid'),
                           ('networkResultSha256', '0'*64), ('authorizationId', '0'*64)]:
            c, b, p, _, _ = self.fixture(); p['document'][key] = value
            with self.subTest(key=key), self.assertRaises(d.n.Refused): self.load(c, b, p)
        c, b, p, _, _ = self.fixture()
        p['document']['artifacts']['/etc/domino/credentials/forbidden'] = {}
        with self.assertRaises(d.n.Refused): self.load(c, b, p)

    def test_provider_and_runtime_scope_not_broadened(self):
        cases = [('rpcUrls', ['https://rpc.mainnet.chain.robinhood.com']),
                 ('rpcUrls', ['https://robinhood-mainnet.g.alchemy.com.evil/v2/key']),
                 ('rpcUrls', ['https://robinhood-mainnet.g.alchemy.com/v2/key?secret=x']),
                 ('runtimeDirectory', '/opt/domino/releases/runtime'),
                 ('catalogue', {'host': '/run/postgresql-domino', 'port': 8877, 'dbname': 'domino_catalogue', 'user': 'postgres'})]
        for key, value in cases:
            c, b, p, _, _ = self.fixture(); reader = d.n.parse(p['files'][d.READER]['bytes']); reader[key] = value
            self.changed_artifact(p, d.READER, reader)
            with self.subTest(key=key), self.assertRaises(d.n.Refused): self.load(c, b, p)

    def test_absolute_authorization_binds_both_admission_and_qualification(self):
        for target in (d.READER, d.ADMISSION):
            c, b, p, _, _ = self.fixture(); value = d.n.parse(p['files'][target]['bytes'])
            selected = value['quotaQualification'] if target == d.READER else value
            selected['expiresAt'] += 1
            self.changed_artifact(p, target, value)
            with self.subTest(target=target), self.assertRaises(d.n.Refused): self.load(c, b, p)

    def test_disable_flags_and_changed_tunnel_config_refused(self):
        for target in (d.READER, d.ADMISSION, d.TUNNEL, d.DROPINS['reader']):
            c, b, p, _, _ = self.fixture()
            if target in (d.READER, d.ADMISSION):
                value = d.n.parse(p['files'][target]['bytes']); value['enabled'] = False
            elif target == d.TUNNEL: value = b'ingress: []\n'
            else: value = d.enable_dropin('reader').replace(b' --enable', b'')
            self.changed_artifact(p, target, value)
            with self.subTest(target=target), self.assertRaises(d.n.Refused): self.load(c, b, p)

    def test_token_content_is_bound_without_output(self):
        _, _, p, _, _ = self.fixture(); p['document']['tokenSha256'] = d.n.sha(b'offline-token')
        directory = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_gid=0)
        leaf = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0, st_nlink=1, st_size=13)
        with patch.object(d.n, 'parents'), patch.object(Path, 'lstat', side_effect=[directory, leaf]), \
             patch.object(d.n, 'read', return_value=b'offline-token'), patch('builtins.print') as output:
            d.token_metadata(p)
        output.assert_not_called()
        with patch.object(d.n, 'parents'), patch.object(Path, 'lstat', side_effect=[directory, leaf]), \
             patch.object(d.n, 'read', return_value=b'different'), self.assertRaises(d.n.Refused):
            d.token_metadata(p)

    def test_effective_unit_command_and_network_must_match(self):
        _, b, _, _, _ = self.fixture(); host = Mock()
        command = d.enable_dropin('reader').decode().split('ExecStart=')[-1].strip()
        values = {'ExecStart': '{ path=/usr/bin/env ; argv[]=' + command + ' ; ignore_errors=no ; pid=0 ; }',
                  'User': 'domino-dev-read', 'Group': 'domino-dev-read', 'WorkingDirectory': str(d.n.SOURCE),
                  'Slice': 'dominodev.slice', 'IPAddressDeny': '0.0.0.0/0 ::/0',
                  'IPAddressAllow': '1.1.1.1/32 127.0.0.1/32', 'ProtectSystem': 'strict',
                  'ReadWritePaths': '/var/lib/domino-dev/reader'}
        host.properties.return_value = values
        d.effective_unit(host, 'reader', b, enabled=True)
        for key, value in [('ExecStart', values['ExecStart'].replace(' --enable', '')),
                           ('IPAddressAllow', '0.0.0.0/0'), ('User', 'root')]:
            host.properties.return_value = {**values, key: value}
            with self.subTest(key=key), self.assertRaises(d.n.Refused): d.effective_unit(host, 'reader', b, enabled=True)

    def revoke(self, *, recovery=False, admission_error=False, policy_error=False, drift=False, journal_error=False):
        c, b, p, state, network = self.fixture(); sequence = []; host = Mock()
        if recovery: state['enable']['phase'] = 'enabling'
        host.run.side_effect = lambda args: sequence.append('nft' if args[0].endswith('/nft') else 'run')
        host.drain.side_effect = lambda: sequence.append('drain')
        def replace(path, *args, **kwargs):
            label = 'admission' if path == d.ADMISSION else 'policy'; sequence.append(label)
            if admission_error and label == 'admission' or policy_error and label == 'policy': raise OSError()
        with ExitStack() as stack:
            guard = stack.enter_context(patch.object(d, 'guard', side_effect=d.n.Refused('drift') if drift else None))
            stack.enter_context(patch.object(d, 'kernel_guard'))
            stack.enter_context(patch.object(d.n, 'read', return_value=c['files'][network.POLICY]['bytes']))
            stack.enter_context(patch.object(d.n, 'journal', side_effect=OSError() if journal_error else None))
            stack.enter_context(patch.object(d.n, 'replace', side_effect=replace))
            stack.enter_context(patch.object(d, 'restore', side_effect=lambda *args: sequence.append('restore')))
            if admission_error or policy_error or drift or journal_error:
                with self.assertRaises((OSError, d.n.Refused)): d.revoke(c, b, p, network, host, state, recovery=recovery)
            else: d.revoke(c, b, p, network, host, state, recovery=recovery)
        network.authorization.assert_not_called(); network.guard.assert_not_called()
        host.snapshot_sql.assert_not_called()
        return sequence, state, guard

    def test_revoke_closes_admission_and_network_before_drain(self):
        sequence, state, _ = self.revoke()
        self.assertEqual(sequence, ['admission', 'nft', 'policy', 'drain', 'restore'])
        self.assertEqual(state['enable']['phase'], 'revoked_off_stopped')
        self.assertEqual(state['network']['phase'], 'revoked_off_stopped')

    def test_revoke_still_closes_network_and_drains_if_admission_write_fails(self):
        sequence, state, _ = self.revoke(admission_error=True)
        self.assertEqual(sequence, ['admission', 'nft', 'policy', 'drain'])
        self.assertEqual(state['enable']['phase'], 'revoking')

    def test_revoke_still_drains_if_off_file_persistence_fails(self):
        sequence, _, _ = self.revoke(policy_error=True)
        self.assertEqual(sequence, ['admission', 'nft', 'policy', 'drain'])

    def test_revoke_journal_failure_still_closes_both_controls_and_drains(self):
        sequence, state, _ = self.revoke(journal_error=True)
        self.assertEqual(sequence, ['admission', 'nft', 'policy', 'drain'])
        self.assertEqual(state['enable']['phase'], 'revoking')
        self.assertEqual(state['network']['phase'], 'enabled_apps')

    def test_apply_recovery_closes_controls_despite_persistent_journal_failure(self):
        c, b, p, state, network = self.fixture(); del state['enable']
        state['network']['phase'] = 'positive_network_off_apps'
        host = Mock(); host.snapshot_sql.return_value = c['sql']['expectedAfter']; events = []
        def journal(*args):
            if 'failureCode' in state['enable']:
                events.append('journal_failed'); raise OSError()
        def replace(path, *args, **kwargs):
            if state['enable']['phase'] == 'revoking':
                events.append('admission' if path == d.ADMISSION else 'policy')
        host.run.side_effect = lambda args: events.append('nft') if args[0].endswith('/nft') else None
        host.drain.side_effect = lambda: events.append('drain') if state['enable']['phase'] == 'revoking' else None
        with ExitStack() as stack:
            for name in ('guard', 'kernel_guard', 'source_and_identities', 'token_metadata'):
                stack.enter_context(patch.object(d, name))
            stack.enter_context(patch.object(d, 'running', side_effect=d.n.Refused('enable_start_timeout')))
            stack.enter_context(patch.object(d.n, 'read', return_value=c['files'][network.POLICY]['bytes']))
            stack.enter_context(patch.object(d.n, 'replace', side_effect=replace))
            stack.enter_context(patch.object(d.n, 'write_new'))
            stack.enter_context(patch.object(d.n, 'journal', side_effect=journal))
            restore = stack.enter_context(patch.object(d, 'restore'))
            with self.assertRaisesRegex(d.n.Refused, '^enable_failed_cleanup_incomplete$'):
                d.apply(c, b, p, network, host, state)
        self.assertEqual(events, ['journal_failed', 'journal_failed', 'admission', 'nft', 'policy', 'drain'])
        self.assertEqual(state['enable']['phase'], 'revoking')
        self.assertEqual(state['enable']['failureCode'], 'enable_start_timeout')
        self.assertEqual(state['network']['phase'], 'enabled_apps')
        restore.assert_not_called()

    def test_unknown_drift_causes_no_mutation(self):
        sequence, _, _ = self.revoke(drift=True)
        self.assertEqual(sequence, [])

    def test_recovery_uses_narrow_partial_guard(self):
        _, _, guard = self.revoke(recovery=True)
        self.assertEqual(guard.call_args.kwargs, {'phase': 'partial'})

    def test_forward_does_not_recheck_dns_adoption_and_journals_before_mutation(self):
        c, b, p, state, network = self.fixture(); del state['enable']
        state['network']['phase'] = 'positive_network_off_apps'
        host = Mock(); sequence = []
        host.snapshot_sql.return_value = c['sql']['expectedAfter']
        host.drain.side_effect = lambda: sequence.append(('drain', state['network']['phase']))
        with ExitStack() as stack:
            for name in ('guard', 'kernel_guard', 'source_and_identities', 'token_metadata', 'running'):
                stack.enter_context(patch.object(d, name))
            stack.enter_context(patch.object(d.n, 'replace'))
            stack.enter_context(patch.object(d.n, 'write_new'))
            stack.enter_context(patch.object(d.n, 'journal', side_effect=lambda *args: sequence.append(('journal', state['network']['phase']))))
            d.apply(c, b, p, network, host, state)
        self.assertEqual(sequence[:2], [('journal', 'enabled_apps'), ('drain', 'enabled_apps')])
        self.assertEqual(state['enable']['phase'], 'enabled')
        self.assertTrue(all(call.kwargs == {'adoption': False} for call in network.authorization.call_args_list))
        commands = [call.args[0] for call in host.run.call_args_list]
        self.assertLess(commands.index(['/usr/bin/systemctl', 'start', 'domino-dev-off.target']),
                        commands.index(['/usr/bin/systemctl', 'start', 'domino-dev-tunnel.service']))
        network.guard.assert_not_called()

    def test_sql_drift_refuses_enable_before_any_mutation(self):
        c, b, p, state, network = self.fixture(); del state['enable']
        state['network']['phase'] = 'positive_network_off_apps'
        original = copy.deepcopy(state)
        host = Mock(); host.snapshot_sql.return_value = {'offlineExpectedAcl': False}
        with ExitStack() as stack:
            for name in ('guard', 'kernel_guard', 'source_and_identities'):
                stack.enter_context(patch.object(d, name))
            mutations = [stack.enter_context(patch.object(d.n, name))
                         for name in ('journal', 'replace', 'write_new')]
            with self.assertRaisesRegex(d.n.Refused, '^enable_sql_post_state_drift$'):
                d.apply(c, b, p, network, host, state)
        host.snapshot_sql.assert_called_once_with()
        for mutation in mutations: mutation.assert_not_called()
        host.drain.assert_not_called()
        host.run.assert_not_called()
        host.off_health.assert_not_called()
        self.assertEqual(state, original)

    def readiness_host(self):
        host = Mock()
        def show(args, *, timeout):
            unit = args[2]
            role = next(role for role in d.ROLES if unit == d.n.infra.USERS[role] + '.service')
            uid = d.ROLES[role][0]
            self.assertGreater(timeout, 0); self.assertLessEqual(timeout, 3)
            return '\n'.join(['MainPID=' + str(uid), 'ActiveState=active', 'User=' + d.n.infra.USERS[role],
                              'Group=' + d.n.infra.USERS[role], 'ControlGroup=/dominodev.slice/' + unit])
        host.run.side_effect = show
        return host

    def test_readiness_waits_for_root_setup_to_final_identity(self):
        host = self.readiness_host(); seen = {}
        def status(path):
            uid = path.parts[2]; seen[uid] = seen.get(uid, 0) + 1
            value = '0' if seen[uid] == 1 else uid
            return 'Uid:\t' + '\t'.join([value]*4) + '\n'
        with patch.object(Path, 'read_text', status), \
             patch.object(d.time, 'monotonic', side_effect=itertools.count(0, .01)), patch.object(d.time, 'sleep') as sleep:
            d.running(host)
        self.assertEqual(seen, {'974': 2, '975': 2, '976': 2})
        sleep.assert_called_once()

    def test_readiness_root_setup_cannot_outlive_total_deadline(self):
        host = self.readiness_host(); clock = [0.0]
        def sleep(seconds): clock[0] += seconds
        with patch.object(Path, 'read_text', return_value='Uid:\t0\t0\t0\t0\n'), \
             patch.object(d.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(d.time, 'sleep', side_effect=sleep), \
             self.assertRaisesRegex(d.n.Refused, '^enable_start_timeout$'):
            d.running(host)
        self.assertEqual(clock[0], 15)

    def test_readiness_rejects_foreign_uid_without_retry(self):
        host = self.readiness_host()
        with patch.object(Path, 'read_text', return_value='Uid:\t777\t777\t777\t777\n'), \
             patch.object(d.time, 'sleep') as sleep, self.assertRaisesRegex(d.n.Refused, '^enable_process_uid_drift$'):
            d.running(host)
        sleep.assert_not_called()
        self.assertEqual(host.run.call_count, 1)

    def test_readiness_retries_process_disappearance(self):
        for error in (FileNotFoundError, ProcessLookupError):
            host = self.readiness_host(); seen = {}
            def status(path):
                uid = path.parts[2]; seen[uid] = seen.get(uid, 0) + 1
                if uid == '974' and seen[uid] == 1: raise error()
                return 'Uid:\t' + '\t'.join([uid]*4) + '\n'
            with self.subTest(error=error.__name__), patch.object(Path, 'read_text', status), \
                 patch.object(d.time, 'monotonic', side_effect=itertools.count(0, .01)), patch.object(d.time, 'sleep') as sleep:
                d.running(host)
            self.assertEqual(seen['974'], 2)
            sleep.assert_called_once()

    def test_failure_code_never_copies_free_exception_text(self):
        for error in (ValueError('enable_start_timeout'), d.n.Refused('https://provider.invalid/private-value'),
                      d.n.Refused('enable_start_timeout\nprivate-value'), d.n.Refused('enable_start_timeout', 'extra')):
            self.assertEqual(d.failure_code(error), 'enable_unclassified_failure')
        self.assertEqual(d.failure_code(d.n.Refused('enable_process_uid_drift')), 'enable_process_uid_drift')

    def test_failure_stage_and_safe_code_are_journaled_before_cleanup(self):
        for error, code in [(d.n.Refused('enable_start_timeout'), 'enable_start_timeout'),
                            (ValueError('private-free-text'), 'enable_unclassified_failure')]:
            c, b, p, state, network = self.fixture(); del state['enable']
            state['network']['phase'] = 'positive_network_off_apps'
            host = Mock(); host.snapshot_sql.return_value = c['sql']['expectedAfter']; events = []
            with self.subTest(code=code), ExitStack() as stack:
                for name in ('guard', 'kernel_guard', 'source_and_identities', 'token_metadata'):
                    stack.enter_context(patch.object(d, name))
                stack.enter_context(patch.object(d, 'running', side_effect=error))
                stack.enter_context(patch.object(d.n, 'replace'))
                stack.enter_context(patch.object(d.n, 'write_new'))
                stack.enter_context(patch.object(d.n, 'journal', side_effect=lambda *args: events.append(copy.deepcopy(state['enable']))))
                stack.enter_context(patch.object(d, 'revoke', side_effect=lambda *args, **kwargs: events.append('cleanup')))
                with self.assertRaisesRegex(d.n.Refused, '^enable_failed_revoked$'):
                    d.apply(c, b, p, network, host, state)
            self.assertEqual(events[-1], 'cleanup')
            self.assertEqual(events[-2]['stage'], 'await_identity')
            self.assertEqual(events[-2]['failureCode'], code)
            self.assertNotIn('private-free-text', str(events))


if __name__ == '__main__': unittest.main()
