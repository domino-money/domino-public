"""Offline adversarial tests; not kernel/BPF or endpoint qualification."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'egress_policy.py'
SPEC = importlib.util.spec_from_file_location('egress_policy', SCRIPT)
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)
NOW = datetime(2026, 9, 11, 12, 0, 0, tzinfo=timezone.utc)


def stamp(value):
    return value.strftime('%Y-%m-%dT%H:%M:%SZ')


def snapshot():
    observed = stamp(NOW - timedelta(seconds=5))
    expires = stamp(NOW + timedelta(seconds=295))
    identities = {}
    for index, role in enumerate(policy.ROLES):
        unit = None if role in policy.NO_UNIT else f'domino-{role}.service'
        identities[role] = {'user': 'domino-' + role, 'realUid': 2000 + index,
            'effectiveUid': 2000 + index, 'gid': 3000 + index,
            'supplementaryGids': [4000] if role in ('read', 'auth') else [],
            'unit': unit, 'cgroup': '/system.slice/' + unit if unit else None}

    def source(hostname, values, **extra):
        return {'hostname': hostname, 'addresses': values, 'observedAt': observed,
                'expiresAt': expires, **extra}

    return {'version': 1, 'observedAt': observed, 'expiresAt': expires,
        'resolver': '127.0.0.53', 'identities': identities,
        'https': [source('rpc.example.com', ['1.1.1.1'], role='read', kind='rpc'),
                  source('api.geckoterminal.com', ['8.8.8.8'], role='read', kind='analytics'),
                  source('team-example.cloudflareaccess.com', ['9.9.9.9'],
                         role='gateway', kind='jwks')],
        'edges': [source('region1.v2.argotunnel.com', ['198.41.192.7']),
                  source('region2.v2.argotunnel.com', ['198.41.200.13'])]}


class EgressPolicyTests(unittest.TestCase):
    def setUp(self):
        self.data = snapshot()

    def render(self):
        return policy.render(self.data, now=NOW)

    def reject(self, code=None):
        with self.assertRaises(policy.InvalidSnapshot) as raised:
            self.render()
        if code:
            self.assertEqual(str(raised.exception), code)

    def test_bundle_is_explicitly_unapplied_unqualified_and_only_owned_artifacts(self):
        result = self.render()
        self.assertIs(result['applied'], False)
        self.assertIs(result['policyQualified'], False)
        self.assertEqual(len(result['artifacts']), 7)
        self.assertEqual(set(result['artifacts']), {'domino-egress-window.nft', *(
            'domino-' + role + '.service.d/40-egress-window.conf'
            for role in ('read', 'gateway', 'auth', 'onboarding', 'deposit', 'tunnel'))})

    def test_default_deny_covers_all_nine_distinct_socket_uids(self):
        nft = self.render()['artifacts']['domino-egress-window.nft']
        for role, identity in self.data['identities'].items():
            self.assertIn(f'output meta skuid {identity["realUid"]} jump {role}', nft)
            self.assertIn(f'{role} counter name denied_{role} drop', nft)
        self.assertEqual(nft.count('counter name denied_'), 9)

    def test_no_collision_merge_flush_table_delete_or_other_table_commands(self):
        nft = self.render()['artifacts']['domino-egress-window.nft']
        commands = [line for line in nft.splitlines() if not line.startswith('#')]
        self.assertEqual(commands[0], 'create table inet domino_egress_window')
        self.assertTrue(all(' inet domino_egress_window' in line for line in commands))
        self.assertFalse(any(word in nft for word in ('flush ', 'delete ', 'destroy ', 'include ')))

    def test_external_permissions_are_exact_ports_per_role(self):
        nft = self.render()['artifacts']['domino-egress-window.nft']
        external = [line for line in nft.splitlines() if 'window external' in line]
        self.assertEqual(len(external), 4)
        for role, protocol, port in (('read', 'tcp', 443), ('gateway', 'tcp', 443),
                                      ('tunnel', 'tcp', 7844), ('tunnel', 'udp', 7844)):
            self.assertEqual(sum(f' {role} meta time' in line and
                f'ip daddr @{role}_ipv4 {protocol} dport {port}' in line for line in external), 1)

    def test_all_non_reply_allows_expire_even_established_connections(self):
        nft = self.render()['artifacts']['domino-egress-window.nft']
        end = int(timestamp(self.data['expiresAt']).timestamp())
        for line in nft.splitlines():
            if ' accept ' in line and 'loopback listener reply' not in line:
                self.assertIn(f'meta time < {end}', line)
                self.assertIn('meta time >= ', line)
        self.assertNotIn('established,related', nft)
        self.assertNotIn('ct state established accept', nft)
        for line in nft.splitlines():
            if 'ct state established' in line:
                self.assertIn('ct direction reply', line)
                self.assertIn('oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp sport ', line)

    def test_relative_timeouts_never_replace_absolute_expiry(self):
        first = self.render()
        later = policy.render(self.data, now=NOW + timedelta(seconds=100, microseconds=500000))
        self.assertEqual(first['expiresAt'], later['expiresAt'])
        self.assertEqual(later['remainingSeconds'], 194)
        nft = later['artifacts']['domino-egress-window.nft']
        self.assertIn('timeout 194s', nft)
        self.assertIn(f'meta time < {int(timestamp(first["expiresAt"]).timestamp())}', nft)
        # Installing the first artifact late still compares every packet to this
        # original absolute deadline, regardless of its longer relative timeout.
        self.assertEqual(set(re.findall(r'meta time < (\d+)', nft)),
                         {str(int(timestamp(first['expiresAt']).timestamp()))})

    def test_external_sets_are_expiring_bounded_and_not_dynamic(self):
        nft = self.render()['artifacts']['domino-egress-window.nft']
        sets = [line for line in nft.splitlines() if line.startswith('add set ')]
        self.assertEqual(len(sets), 3)
        for line in sets:
            self.assertIn('type ipv4_addr; flags timeout; size ', line)
            self.assertIn(' timeout 295s', line)
            self.assertNotIn('dynamic', line)

    def test_loopback_origins_exclude_direct_reader_and_deposit_from_tunnel(self):
        nft = self.render()['artifacts']['domino-egress-window.nft']
        origins = [line for line in nft.splitlines() if 'window local origin' in line]
        self.assertEqual(len(origins), 4)
        tunnel = [line for line in origins if ' tunnel ' in line]
        self.assertEqual({int(re.search(r'tcp dport (\d+)', line)[1]) for line in tunnel},
                         {8878, 8879, 8880})
        self.assertTrue(all('ct direction original' in line for line in origins))
        self.assertEqual(len([line for line in origins if ' gateway ' in line and 'dport 8876' in line]), 1)

    def test_dns_only_exact_stub_enabled_roles_and_both_transports(self):
        nft = self.render()['artifacts']['domino-egress-window.nft']
        dns = [line for line in nft.splitlines() if 'window DNS stub' in line]
        self.assertEqual(len(dns), 6)
        for line in dns:
            self.assertIn('oifname "lo" ip daddr 127.0.0.53', line)
            self.assertTrue(any(f' {role} meta time' in line for role in policy.ENABLED))
        self.assertNotIn('::', nft)
        self.assertNotIn('ip6 ', nft)

    def test_dropins_reset_inherited_allowlists_and_deny_ipv6(self):
        artifacts = self.render()['artifacts']
        for role in policy.LISTENERS:
            text = artifacts[f'domino-{role}.service.d/40-egress-window.conf']
            self.assertIn('[Service]\nIPAddressAllow=\nIPAddressDeny=\nIPAddressDeny=any\n', text)
            self.assertIn('IPAddressAllow=127.0.0.1/32', text)
            self.assertNotIn('localhost', text)
            self.assertNotIn('::', text)
            self.assertNotIn('ExecStart=', text)
            self.assertNotIn('User=', text)
            if role not in policy.ENABLED:
                self.assertEqual(text.count('IPAddressAllow='), 2)
                self.assertNotIn('127.0.0.53', text)

    def test_deferred_accounts_cannot_be_assigned_external_destinations(self):
        for role in ('auth', 'onboarding', 'deposit', 'write', 'operator', 'admin', 'tunnel'):
            with self.subTest(role=role):
                self.data = snapshot()
                self.data['https'][0]['role'] = role
                self.reject('invalid_https_role')

    def test_explicit_absent_admin_is_allowed_and_not_fabricated(self):
        self.data['identities']['admin'] = None
        self.assertEqual(self.render()['artifacts']['domino-egress-window.nft'].count('counter name denied_'), 8)
        self.data['identities']['write'] = None
        self.reject('invalid_identity_fields')

    def test_missing_or_unknown_role_rejected(self):
        del self.data['identities']['write']
        self.reject('invalid_identity_roles')
        self.data = snapshot()
        self.data['identities']['random'] = {}
        self.reject('invalid_identity_roles')

    def test_uid_mismatch_duplicate_root_and_nobody_rejected(self):
        self.data['identities']['read']['effectiveUid'] += 1
        self.reject('identity_uid_mismatch')
        for value in (0, -1, 65534, True, '2000', 2**31):
            with self.subTest(value=value):
                self.data = snapshot()
                self.data['identities']['read']['realUid'] = value
                self.reject('invalid_identity_number')
        self.data = snapshot()
        other = self.data['identities']['gateway']
        other['realUid'] = other['effectiveUid'] = 2000
        self.reject('duplicate_uid')

    def test_groups_cannot_hide_root_duplicate_or_unbounded_membership(self):
        for groups, code in (([0], 'invalid_identity_number'), ([4000, 4000], 'duplicate_group'),
                             (list(range(4000, 4017)), 'invalid_group_count'),
                             ('4000', 'invalid_group_count')):
            with self.subTest(groups=groups):
                self.data = snapshot()
                self.data['identities']['read']['supplementaryGids'] = groups
                self.reject(code)

    def test_service_and_cgroup_must_match_exact_named_nonroot_identity(self):
        for cgroup in ('/', '', '/system.slice/', '/system.slice/other.service',
                       '/system.slice/../domino-read.service', '/user.slice/domino-read.service', None):
            with self.subTest(cgroup=cgroup):
                self.data = snapshot()
                self.data['identities']['read']['cgroup'] = cgroup
                self.reject('invalid_service_cgroup')
        self.data = snapshot()
        self.data['identities']['read']['unit'] = 'ssh.service'
        self.reject('invalid_service_unit')
        self.data = snapshot()
        self.data['identities']['operator']['unit'] = 'domino-operator.service'
        self.reject('unexpected_service_unit')

    def test_identity_username_and_extra_fields_rejected(self):
        self.data['identities']['read']['user'] = 'root'
        self.reject('invalid_identity_user')
        self.data = snapshot()
        self.data['identities']['read']['credential'] = 'do-not-echo'
        self.reject('invalid_identity_fields')

    def test_expired_future_too_long_and_short_windows_rejected(self):
        for start, end, code in ((-600, -1, 'expired_or_future_snapshot'),
                                 (1, 300, 'expired_or_future_snapshot'),
                                 (-5, 596, 'window_too_long'),
                                 (-5, 9, 'insufficient_remaining_window')):
            with self.subTest(code=code):
                self.data = snapshot()
                self.data['observedAt'] = stamp(NOW + timedelta(seconds=start))
                self.data['expiresAt'] = stamp(NOW + timedelta(seconds=end))
                self.reject(code)

    def short_dns_window(self):
        # DNS was observed five seconds before rendering with a real 60s TTL.
        self.data['expiresAt'] = stamp(NOW + timedelta(seconds=55))
        for source in self.data['https'] + self.data['edges']:
            source['expiresAt'] = self.data['expiresAt']

    def test_60_second_dns_ttl_survives_collection_delay_without_extension(self):
        self.short_dns_window()
        result = self.render()
        self.assertEqual(result['remainingSeconds'], 55)
        later = policy.render(self.data, now=NOW + timedelta(seconds=12, microseconds=500000))
        self.assertEqual(later['remainingSeconds'], 42)
        self.assertEqual(later['expiresAt'], self.data['expiresAt'])
        nft = later['artifacts']['domino-egress-window.nft']
        self.assertIn('timeout 42s', nft)
        self.assertEqual(set(re.findall(r'meta time < (\d+)', nft)),
                         {str(int(timestamp(self.data['expiresAt']).timestamp()))})

    def test_short_window_requires_ten_full_seconds_and_rejects_fractional_shortfall(self):
        self.short_dns_window()
        boundary = NOW + timedelta(seconds=45)
        self.assertEqual(policy.render(self.data, now=boundary)['remainingSeconds'], 10)
        with self.assertRaisesRegex(policy.InvalidSnapshot, '^insufficient_remaining_window$'):
            policy.render(self.data, now=boundary + timedelta(microseconds=1))

    def test_short_dns_window_is_rejected_at_and_after_its_original_expiry(self):
        self.short_dns_window()
        for delay in (55, 56):
            with self.subTest(delay=delay):
                with self.assertRaisesRegex(policy.InvalidSnapshot, '^expired_or_future_snapshot$'):
                    policy.render(self.data, now=NOW + timedelta(seconds=delay))

    def test_exact_600_second_window_accepted_without_extending_dns_ttl(self):
        self.data['expiresAt'] = stamp(NOW + timedelta(seconds=595))
        for source in self.data['https'] + self.data['edges']:
            source['expiresAt'] = self.data['expiresAt']
        self.assertEqual(self.render()['remainingSeconds'], 595)

    def test_source_expiry_and_observation_apply_to_every_source(self):
        for kind in ('https', 'edges'):
            for index in range(len(self.data[kind])):
                with self.subTest(kind=kind, index=index):
                    self.data = snapshot()
                    self.data[kind][index]['expiresAt'] = stamp(NOW + timedelta(seconds=290))
                    self.reject('window_exceeds_source_expiry')
        self.data = snapshot()
        self.data['https'][0]['observedAt'] = stamp(NOW)
        self.reject('invalid_source_observation')
        self.data = snapshot()
        self.data['https'][0]['observedAt'] = stamp(NOW - timedelta(seconds=606))
        self.reject('source_observation_too_old')

    def test_timestamps_require_utc_exact_seconds_and_valid_dates(self):
        for value in ('2026-09-11', '2026-09-11T12:00:00+00:00',
                       '2026-09-11T12:00:00.000Z', '2026-02-30T12:00:00Z', None):
            with self.subTest(value=value):
                self.data['observedAt'] = value
                self.reject('invalid_timestamp')

    def test_addresses_reject_nonglobal_multicast_ipv6_cidr_and_ambiguity(self):
        for address in ('127.0.0.1', '10.1.2.3', '100.64.1.1', '169.254.169.254',
                         '0.0.0.0', '192.0.2.1', '224.0.0.1', '240.0.0.1',
                         '2001:4860:4860::8888', '1.1.1.1/32', '01.1.1.1', '1.1.1.1; accept'):
            with self.subTest(address=address):
                self.data['https'][0]['addresses'] = [address]
                self.reject()

    def test_address_lists_reject_empty_duplicate_excess_and_nonarray(self):
        for values in ([], ['1.1.1.1', '1.1.1.1'], ['1.1.1.1'] * 65, '1.1.1.1', [None]):
            with self.subTest(values=values):
                self.data['https'][0]['addresses'] = values
                self.reject()

    def test_hostname_input_cannot_contain_url_credentials_paths_or_injection(self):
        for hostname in ('https://rpc.example.com', 'key@rpc.example.com', 'rpc.example.com/key',
                          'rpc.example.com?key=x', 'rpc.example.com\naccept', '1.1.1.1',
                          '*.example.com', 'RPC.example.com', 'rpc.example.com.', None):
            with self.subTest(hostname=hostname):
                self.data['https'][0]['hostname'] = hostname
                self.reject('invalid_hostname')

    def test_purpose_hostnames_and_duplicates_rejected(self):
        self.data['https'][1]['hostname'] = 'other.example.com'
        self.reject('unapproved_analytics_hostname')
        self.data = snapshot()
        self.data['https'][2]['hostname'] = 'cloudflareaccess.com.evil.example.com'
        self.reject('invalid_jwks_hostname')
        self.data = snapshot()
        self.data['https'].append(deepcopy(self.data['https'][0]))
        self.reject('duplicate_hostname')

    def test_https_purposes_and_request_count_bounded(self):
        self.data['https'] = self.data['https'][:2]
        self.reject('invalid_https_purposes')
        self.data = snapshot()
        self.data['https'] *= 3
        self.reject('invalid_https_count')

    def test_tunnel_addresses_require_exact_official_region_membership(self):
        for values in (['1.1.1.1'], ['198.41.200.13'], ['198.41.192.8']):
            with self.subTest(values=values):
                self.data['edges'][0]['addresses'] = values
                self.reject('unapproved_edge_address')
        self.data = snapshot()
        self.data['edges'][0]['hostname'] = 'region2.v2.argotunnel.com'
        self.data['edges'][0]['addresses'] = ['198.41.200.13']
        self.reject('invalid_edge_hostname')

    def test_unknown_fields_version_and_alternate_dns_rejected(self):
        self.data['apiKey'] = 'not-a-real-key'
        self.reject('invalid_snapshot_fields')
        self.data = snapshot()
        self.data['version'] = True
        self.reject('invalid_snapshot_version')
        self.data = snapshot()
        self.data['resolver'] = '8.8.8.8'
        self.reject('invalid_resolver')

    def test_parser_rejects_duplicate_keys_size_nonfinite_bad_utf8_and_depth(self):
        for raw in (b'{"a":1,"a":2}', b' ' * (policy.MAX_BYTES + 1), b'{"a":NaN}',
                    b'\xff', '{}'.encode('utf-16'), b'[' * 2000 + b']' * 2000):
            with self.subTest(size=len(raw)):
                with self.assertRaises(policy.InvalidSnapshot):
                    policy.parse(raw)

    def test_cli_error_never_echoes_supplied_data_or_writes_files(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], input=b'{"secret":"DO-NOT-ECHO"}',
                                capture_output=True, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(b'DO-NOT-ECHO', result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout), {'ok': False, 'error': 'invalid_snapshot_fields'})

    def test_cli_exposes_no_apply_renew_network_or_clock_override_flags(self):
        for argument in ('--apply', '--renew', '--execute', '--now', '--config'):
            result = subprocess.run([sys.executable, str(SCRIPT), argument], input=b'',
                                    capture_output=True, check=False)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)['error'], 'stdin_only_no_arguments')

    def test_render_is_deterministic_and_does_not_mutate_snapshot(self):
        previous = deepcopy(self.data)
        first = self.render()
        self.assertEqual(first, self.render())
        self.assertEqual(self.data, previous)
        self.assertEqual(policy.parse(json.dumps(self.data).encode()), self.data)


timestamp = policy.timestamp


if __name__ == '__main__':
    unittest.main()
