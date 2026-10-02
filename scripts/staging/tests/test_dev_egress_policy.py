"""Offline development network boundary checks; no kernel/provider qualification."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_egress_policy as policy
import dev_infrastructure as off

NOW = datetime(2026, 9, 12, 12, 0, 0, tzinfo=timezone.utc)
SCRIPT = Path(policy.__file__)


def stamp(value):
    return value.strftime('%Y-%m-%dT%H:%M:%SZ')


def snapshot():
    observed, expires = stamp(NOW - timedelta(seconds=5)), stamp(NOW + timedelta(seconds=295))
    values = {'robinhood-mainnet.g.alchemy.com': ['1.1.1.1'],
              'api.geckoterminal.com': ['8.8.8.8'], 'api.dexscreener.com': ['9.9.9.9'],
              'example.cloudflareaccess.com': ['1.0.0.1'],
              'region1.v2.argotunnel.com': ['198.41.192.7'],
              'region2.v2.argotunnel.com': ['198.41.200.13']}
    return {'version': 1, 'observedAt': observed, 'expiresAt': expires,
            'offManifestSha256': 'a' * 64, 'rpcHosts': ['robinhood-mainnet.g.alchemy.com'],
            'inventoryHost': 'robinhood-mainnet.g.alchemy.com',
            'accessIssuer': 'example.cloudflareaccess.com', 'tunnel': {},
            'hosts': [{'hostname': host, 'addresses': ips, 'observedAt': observed, 'expiresAt': expires}
                      for host, ips in values.items()]}


def continuous_snapshot():
    data = snapshot()
    data['profile'] = 'continuous_operator_pins'
    data['operatorAuthorization'] = {'authorizationId': 'b' * 64,
        'grantedAt': stamp(NOW - timedelta(seconds=1)),
        'expiresAt': stamp(NOW - timedelta(seconds=1) + timedelta(days=7)), 'revoked': False}
    data['expiresAt'] = data['operatorAuthorization']['expiresAt']
    for source in data['hosts']:
        source['expiresAt'] = stamp(NOW + timedelta(seconds=55))
    return data


class DevEgressPolicyTests(unittest.TestCase):
    def setUp(self):
        self.data = snapshot()

    def test_domino_rpc_uses_exact_pins_with_existing_rpc_and_inventory(self):
        self.data['rpcHosts'] += ['rpc.domino.money']
        for host, address in (('rpc.domino.money', '11.0.0.1'),):
            self.data['hosts'].append({'hostname': host, 'addresses': [address],
                                      'observedAt': self.data['observedAt'],
                                      'expiresAt': self.data['expiresAt']})
        result = self.render()
        reader = result['artifacts']['/etc/domino/dev/reader/hosts']
        for host in self.data['rpcHosts']:
            self.assertIn(host, reader)
        self.assertIn('11.0.0.1 rpc.domino.money\n', reader)
        self.assertIn('IPAddressAllow=11.0.0.1/32', self.dropin('reader'))
        self.assertNotIn('ws.domino.money', json.dumps(result))
        self.assertIn('tcp dport 443', self.nft())
        self.assertIn('drop', self.nft())

    def test_domino_rpc_does_not_expand_inventory_or_admit_other_hosts(self):
        for host in ('ws.domino.money', 'other.domino.money', 'rpc.domino.money.evil.example'):
            self.data = snapshot()
            self.data['rpcHosts'].append(host)
            with self.subTest(host=host):
                self.reject()
        self.data = snapshot()
        self.data['inventoryHost'] = 'rpc.domino.money'
        self.reject()

    def render(self, now=NOW):
        return policy.render(self.data, now=now)

    def reject(self):
        with self.assertRaises(policy.InvalidSnapshot):
            self.render()

    def nft(self):
        return self.render()['artifacts'][policy.NFT_TARGET]

    def dropin(self, role):
        return self.render()['artifacts']['/etc/systemd/system/' + off.USERS[role] + '.service.d/50-dev-egress.conf']

    def hosts(self, role):
        return self.render()['artifacts'][off.ROOT + '/' + role + '/hosts']

    def test_finite_candidate_has_no_activation_or_observed_qualification(self):
        result = self.render()
        self.assertEqual(result, policy.render(deepcopy(self.data), now=NOW))
        for key in ('applied', 'policyQualified', 'activationSelected'):
            self.assertIs(result[key], False)
        targets = {policy.NFT_TARGET}
        for role in off.ROLES:
            targets.add(off.ROOT + '/' + role + '/hosts')
            targets.add('/etc/systemd/system/' + off.USERS[role] + '.service.d/50-dev-egress.conf')
        self.assertEqual(set(result['artifacts']), targets)
        self.assertEqual(len(targets), 7)

    def test_only_dev_table_is_replaced_atomically_and_other_uids_are_unmatched(self):
        commands = [line for line in self.nft().splitlines() if not line.startswith('#')]
        self.assertEqual(commands[:3], ['add table inet domino_dev_off',
            'delete table inet domino_dev_off', 'add table inet domino_dev_off'])
        self.assertTrue(all(' inet domino_dev_off ' in line or line.endswith(' inet domino_dev_off') for line in commands))
        self.assertEqual(set(re.findall(r'meta skuid (\d+)', self.nft())), {'974', '975', '976'})
        self.assertIn('hook output priority 11; policy accept;', self.nft())
        for word in ('flush ', 'include ', 'domino_continuous_reads', 'domino_egress_window'):
            self.assertNotIn(word, self.nft())
        self.assertEqual(self.nft().count('counter name denied_'), 3)

    def test_reader_gateway_and_connector_destinations_do_not_merge(self):
        nft = self.nft()
        self.assertIn('reader_https { type ipv4_addr; flags timeout; size 3;', nft)
        self.assertIn('gateway_https { type ipv4_addr; flags timeout; size 1;', nft)
        self.assertIn('tunnel_edges { type ipv4_addr; flags timeout; size 2;', nft)
        for role, name in (('reader', 'reader_https'), ('gateway', 'gateway_https')):
            rules = [x for x in nft.splitlines() if x.startswith(f'add rule inet domino_dev_off {role} ')]
            external = [x for x in rules if 'oifname != "lo"' in x]
            self.assertEqual(len(external), 1)
            self.assertIn(f'ip daddr @{name} tcp dport 443 ct direction original', external[0])
        self.assertNotIn('tunnel_jwks', nft)
        tunnel = [x for x in nft.splitlines() if x.startswith('add rule inet domino_dev_off tunnel ') and 'oifname != "lo"' in x]
        self.assertEqual(len(tunnel), 2)
        self.assertTrue(all('ip daddr @tunnel_edges' in x and 'dport 7844' in x for x in tunnel))
        self.assertEqual({re.search(r'(tcp|udp) dport', x)[1] for x in tunnel}, {'tcp', 'udp'})

    def test_connector_jwks_is_separate_exact_issuer_opt_in(self):
        self.data['tunnel']['accessJwks'] = True
        nft = self.nft()
        self.assertIn('add set inet domino_dev_off tunnel_jwks { type ipv4_addr; flags timeout; size 1; elements = { 1.0.0.1 timeout 295s }; }', nft)
        self.assertIn('ip daddr @tunnel_jwks tcp dport 443 ct direction original', nft)
        self.assertNotRegex(nft, r'@tunnel_edges tcp dport 443')
        self.assertIn('1.0.0.1 example.cloudflareaccess.com', self.hosts('tunnel'))
        self.assertIn('IPAddressAllow=1.0.0.1/32', self.dropin('tunnel'))
        self.assertNotIn('127.0.0.53', nft)

    def test_dns_is_default_denied_and_only_exact_connector_stub_when_selected(self):
        self.assertNotIn('dport 53', self.nft())
        self.assertEqual(self.render()['tunnelPermissions'], {'dnsStub': False, 'accessJwks': False})
        self.data['tunnel']['dnsStub'] = True
        dns = [line for line in self.nft().splitlines() if 'dport 53' in line]
        self.assertEqual(len(dns), 2)
        for line in dns:
            self.assertIn(' domino_dev_off tunnel meta time ', line)
            self.assertIn('oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.53', line)
            self.assertIn('ct direction original', line)
        self.assertIn('IPAddressAllow=127.0.0.53/32', self.dropin('tunnel'))
        for role in ('reader', 'gateway'):
            self.assertNotIn('127.0.0.53', self.dropin(role))
        self.assertNotIn('tunnel_jwks', self.nft())

    def test_local_origins_are_only_gateway_to_reader_and_connector_to_gateway(self):
        origins = [line for line in self.nft().splitlines() if 'window local origin' in line]
        self.assertEqual(len(origins), 2)
        self.assertTrue(any(' gateway ' in line and 'tcp dport 8890 ct direction original' in line for line in origins))
        self.assertTrue(any(' tunnel ' in line and 'tcp dport 8891 ct direction original' in line for line in origins))
        for port in (8876, 8878, 8879, 8880, 8881, 20241, 8765, 22, 5432):
            self.assertNotRegex(self.nft(), rf'(?:dport|sport) {port}\b')

    def test_listener_reply_cannot_be_repurposed_as_bound_source_port_egress(self):
        replies = [line for line in self.nft().splitlines() if 'loopback listener reply' in line]
        self.assertEqual(len(replies), 3)
        for role, (_, listener) in off.ROLES.items():
            self.assertTrue(any(f' {role} oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp sport {listener} ct direction reply ct state established ' in line for line in replies))
        self.assertNotIn('established,related', self.nft())
        self.assertNotIn('ct state established accept', self.nft())

    def test_all_original_traffic_expires_without_established_bypass(self):
        self.data['tunnel'] = {'dnsStub': True, 'accessJwks': True}
        begin = int((NOW - timedelta(seconds=5)).timestamp())
        end = int((NOW + timedelta(seconds=295)).timestamp())
        for line in self.nft().splitlines():
            if 'counter accept' in line and 'loopback listener reply' not in line:
                self.assertIn(f'meta time >= {begin} meta time < {end}', line)
                self.assertIn('ct direction original', line)

    def test_delayed_rendering_never_extends_deadline_or_set_lifetime(self):
        first = self.render()
        later = self.render(NOW + timedelta(seconds=100, microseconds=500000))
        self.assertEqual(first['expiresAt'], later['expiresAt'])
        self.assertEqual(later['remainingSeconds'], 194)
        self.assertIn('timeout 194s', later['artifacts'][policy.NFT_TARGET])
        self.assertEqual(set(re.findall(r'meta time < (\d+)', first['artifacts'][policy.NFT_TARGET])),
                         set(re.findall(r'meta time < (\d+)', later['artifacts'][policy.NFT_TARGET])))
        self.assertNotEqual(first['artifactSha256'][policy.NFT_TARGET], later['artifactSha256'][policy.NFT_TARGET])
        with self.assertRaises(policy.InvalidSnapshot):
            self.render(NOW + timedelta(seconds=286))

    def test_dns_ttl_can_bound_a_short_window_without_being_extended(self):
        self.data['expiresAt'] = stamp(NOW + timedelta(seconds=55))
        for source in self.data['hosts']:
            source['expiresAt'] = self.data['expiresAt']
        result = self.render(NOW + timedelta(seconds=12, microseconds=500000))
        self.assertEqual(result['remainingSeconds'], 42)
        self.assertIn('timeout 42s', result['artifacts'][policy.NFT_TARGET])

    def test_role_specific_host_mounts_preserve_private_directory_bind(self):
        reader = self.hosts('reader')
        for host in ('robinhood-mainnet.g.alchemy.com', 'api.geckoterminal.com', 'api.dexscreener.com'):
            self.assertIn(host, reader)
        self.assertNotIn('cloudflareaccess', reader)
        self.assertNotIn('argotunnel', reader)
        self.assertNotIn('alchemy', self.hosts('gateway'))
        self.assertNotIn('cloudflareaccess', self.hosts('tunnel'))
        for role in off.ROLES:
            dropin = self.dropin(role)
            self.assertIn(f'BindReadOnlyPaths={off.ROOT}/{role}/hosts:/etc/hosts\n', dropin)
            self.assertNotIn('BindReadOnlyPaths=\n', dropin)
            self.assertTrue(self.hosts(role).splitlines()[1] == '127.0.0.1 localhost')
            for value in ('::', 'ExecStart=', 'User=', 'Group=', 'ReadWritePaths=', 'Environment=', '--enable'):
                self.assertNotIn(value, dropin)
            self.assertIn('IPAddressAllow=\nIPAddressDeny=\nIPAddressDeny=any\nIPAddressAllow=127.0.0.1/32', dropin)

    def test_fixed_identity_cgroup_and_database_membership_requirements(self):
        identities = self.render()['identities']
        self.assertEqual(set(identities), {'reader', 'gateway', 'tunnel'})
        for role, uid in (('reader', 974), ('gateway', 975), ('tunnel', 976)):
            item = identities[role]
            self.assertEqual((item['realUid'], item['effectiveUid'], item['gid']), (uid, uid, uid))
            self.assertEqual(item['cgroup'], '/dominodev.slice/' + item['unit'])
            self.assertEqual(item['supplementaryGids'], [988] if role == 'reader' else [])

    def test_hashes_and_rollback_bind_exact_off_policy_and_only_six_new_files(self):
        result = self.render()
        for target, body in result['artifacts'].items():
            self.assertEqual(result['artifactSha256'][target], hashlib.sha256(body.encode()).hexdigest())
            self.assertEqual(result['artifactMetadata'][target], {'uid': 0, 'gid': 0, 'mode': 0o600 if target == policy.NFT_TARGET else 0o644})
        rollback = result['rollback']
        self.assertEqual(rollback['restoreArtifacts'], {policy.NFT_TARGET: off.policy().decode()})
        self.assertEqual(rollback['offPolicySha256'], hashlib.sha256(off.policy()).hexdigest())
        self.assertEqual(rollback['offManifestSha256'], self.data['offManifestSha256'])
        self.assertEqual(rollback['removeArtifacts'], {p: v for p, v in result['artifactSha256'].items() if p != policy.NFT_TARGET})
        self.assertEqual(len(rollback['removeArtifacts']), 6)

    def test_the_public_rpc_is_not_an_rpc_host(self):
        # The same snapshot rendered while Robinhood's public RPC was a default; now it is refused.
        self.data['rpcHosts'].append('rpc.mainnet.chain.robinhood.com')
        self.data['hosts'].append({**self.data['hosts'][0], 'hostname': 'rpc.mainnet.chain.robinhood.com',
                                   'addresses': ['8.8.4.4']})
        with self.assertRaises(policy.InvalidSnapshot) as raised:
            self.render()
        self.assertEqual(str(raised.exception), 'invalid_rpc_hosts')

    def test_reader_inventory_is_explicit_and_exact_with_both_rpc_hosts(self):
        self.data['rpcHosts'].append('rpc.domino.money')
        self.data['hosts'].append({**self.data['hosts'][0], 'hostname': 'rpc.domino.money', 'addresses': ['8.8.4.4']})
        self.assertIn('8.8.4.4 rpc.domino.money', self.hosts('reader'))
        self.data['inventoryHost'] = None
        self.render()
        self.data['rpcHosts'] = ['rpc.domino.money']
        self.data['hosts'] = [x for x in self.data['hosts'] if x['hostname'] != 'robinhood-mainnet.g.alchemy.com']
        self.assertNotIn('alchemy', self.hosts('reader'))

    def test_unknown_fields_ids_ports_urls_and_false_types_are_rejected(self):
        cases = [('version', True), ('offManifestSha256', 'main'), ('offManifestSha256', 'a'*64+'\n'),
                 ('rpcHosts', []), ('rpcHosts', ['rpc.example.com']), ('rpcHosts', ['rpc.mainnet.chain.robinhood.com']), ('rpcHosts', ['robinhood-mainnet.g.alchemy.com']*2),
                 ('rpcHosts', [{'hostname': 'secret'}]), ('inventoryHost', False),
                 ('inventoryHost', 'https://robinhood-mainnet.g.alchemy.com/v2/secret'),
                 ('accessIssuer', 'https://example.cloudflareaccess.com'), ('accessIssuer', 'example.cloudflareaccess.com/path'),
                 ('accessIssuer', 'example.cloudflareaccess.com\nExecStart=bad'), ('accessIssuer', '*.cloudflareaccess.com'),
                 ('tunnel', {'dnsStub': 1}), ('tunnel', {'accessJwks': 'true'}),
                 ('tunnel', {'resolver': '8.8.8.8'}), ('tunnel', []),
                 ('identities', {'reader': {'uid': 0}}), ('ports', [8876]), ('providerSecret', 'do-not-echo')]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                self.data = snapshot()
                self.data[key] = value
                self.reject()

    def test_missing_duplicate_extra_or_unapproved_host_pins_are_rejected(self):
        self.data['hosts'].pop()
        self.reject()
        self.data = snapshot()
        self.data['hosts'][-1] = deepcopy(self.data['hosts'][0])
        self.reject()
        for value in ('https://example.com/key', 'evil.example', 'rpc.mainnet.chain.robinhood.com'):
            self.data = snapshot()
            self.data['hosts'][0]['hostname'] = value
            self.reject()
        self.data = snapshot()
        self.data['hosts'][0]['tlsSecret'] = 'must-not-pass'
        self.reject()

    def test_only_canonical_global_unique_bounded_ipv4_is_accepted(self):
        for values in (['127.0.0.1'], ['10.0.0.1'], ['169.254.169.254'], ['0.0.0.0'], ['224.0.0.1'],
                       ['::1'], ['1.1.1.1/32'], ['001.1.1.1'], ['1.1.1.1', '1.1.1.1'],
                       [True], '1.1.1.1', [], ['1.1.1.1'] * 65):
            with self.subTest(values=values):
                self.data = snapshot()
                self.data['hosts'][0]['addresses'] = values
                self.reject()
        self.data = snapshot()
        self.data['hosts'][-1]['addresses'] = ['1.1.1.1']
        self.reject()

    def test_future_expired_long_and_stale_source_windows_fail_closed(self):
        for start, end in ((1, 300), (-600, -1), (-5, 596), (-5, 9)):
            self.data = snapshot()
            self.data['observedAt'] = stamp(NOW + timedelta(seconds=start))
            self.data['expiresAt'] = stamp(NOW + timedelta(seconds=end))
            self.reject()
        for field, value in (('observedAt', stamp(NOW)),
                             ('observedAt', stamp(NOW - timedelta(seconds=606))),
                             ('expiresAt', stamp(NOW + timedelta(seconds=294)))):
            self.data = snapshot()
            self.data['hosts'][0][field] = value
            self.reject()

    def test_parser_and_cli_bound_input_without_echoing_invalid_secrets(self):
        raw = json.dumps(snapshot()).encode()
        self.assertEqual(policy.parse(raw), snapshot())
        for invalid in (raw[:-1] + b', "version": 1}', b'{"secret":"DO_NOT_ECHO", "x": NaN}',
                        b'['*10 + b'0' + b']'*10, b' '*(policy.MAX_BYTES+1)):
            with self.assertRaises(policy.InvalidSnapshot):
                policy.parse(invalid)
        result = subprocess.run([sys.executable, '-B', str(SCRIPT)], input=b'{"secret":"DO_NOT_ECHO"}',
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(b'DO_NOT_ECHO', result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['error'], 'invalid_snapshot_fields')
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), 'DO_NOT_ECHO'], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(b'DO_NOT_ECHO', result.stdout + result.stderr)

    def test_render_is_pure_and_does_not_resolve_write_or_run_commands(self):
        with patch('socket.getaddrinfo', side_effect=AssertionError('no DNS')), \
             patch('socket.create_connection', side_effect=AssertionError('no connection')), \
             patch('subprocess.run', side_effect=AssertionError('no native command')), \
             patch.object(Path, 'write_text', side_effect=AssertionError('no file write')):
            self.render()

    def test_stdin_cli_renders_current_candidate_without_extra_modes(self):
        now = datetime.now(timezone.utc)
        self.data['observedAt'], self.data['expiresAt'] = stamp(now - timedelta(seconds=5)), stamp(now + timedelta(seconds=55))
        for source in self.data['hosts']:
            source['observedAt'], source['expiresAt'] = self.data['observedAt'], self.data['expiresAt']
        result = subprocess.run([sys.executable, '-B', str(SCRIPT)], input=json.dumps(self.data).encode(),
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(len(output['artifacts']), 7)
        self.assertIs(output['applied'], False)
        self.assertEqual(output['offManifestSha256'], self.data['offManifestSha256'])
        self.assertGreaterEqual(output['remainingSeconds'], 10)
        self.assertLessEqual(output['remainingSeconds'], 55)

    def test_short_profile_remains_default_and_explicit_form_has_same_enforcement(self):
        default = self.render()
        self.data['profile'] = 'dns_expiring_qualification'
        explicit = self.render()
        self.assertEqual(default['profile'], explicit['profile'])
        self.assertEqual(default['artifacts'], explicit['artifacts'])
        self.assertIsNone(default['operatorAuthorization'])
        self.assertEqual(default['adoptionDeadline'], default['effectivePermissionExpiry'])

    def test_continuous_authority_expiry_is_separate_from_fresh_dns_adoption(self):
        self.data = continuous_snapshot()
        result = self.render()
        self.assertEqual(result['profile'], 'continuous_operator_pins')
        self.assertEqual(result['adoptionDeadline'], stamp(NOW + timedelta(seconds=55)))
        self.assertEqual(result['effectivePermissionExpiry'], self.data['operatorAuthorization']['expiresAt'])
        self.assertEqual(result['remainingSeconds'], 7*24*60*60 - 1)
        self.assertEqual(result['operatorAuthorization'], self.data['operatorAuthorization'])
        nft = result['artifacts'][policy.NFT_TARGET]
        self.assertIn('timeout 604799s', nft)
        end = int((NOW - timedelta(seconds=1) + timedelta(days=7)).timestamp())
        self.assertEqual(set(re.findall(r'meta time < (\d+)', nft)), {str(end)})
        for line in nft.splitlines():
            if 'counter accept' in line and 'loopback listener reply' not in line:
                self.assertIn(f'meta time < {end}', line)
        # The renderer does not grant a new adoption after the DNS handoff
        # expires, even while the old installed authorization could remain held.
        with self.assertRaises(policy.InvalidSnapshot):
            self.render(NOW + timedelta(seconds=56))

    def test_continuous_adoption_requires_recent_unexpired_sources_and_handoff_margin(self):
        cases = [('observedAt', stamp(NOW + timedelta(seconds=1))),
                 ('observedAt', stamp(NOW - timedelta(seconds=601))),
                 ('expiresAt', stamp(NOW - timedelta(seconds=1))),
                 ('expiresAt', stamp(NOW + timedelta(seconds=9)))]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                self.data = continuous_snapshot()
                self.data['hosts'][0][field] = value
                self.reject()
        self.data = continuous_snapshot()
        self.data['observedAt'] = stamp(NOW - timedelta(seconds=580))
        for source in self.data['hosts']:
            source['observedAt'] = self.data['observedAt']
            source['expiresAt'] = stamp(NOW + timedelta(hours=1))
        self.assertEqual(self.render()['adoptionDeadline'], stamp(NOW + timedelta(seconds=20)))

    def test_unknown_profile_or_authority_without_explicit_continuous_selection_fails(self):
        for value in ('continuous', 'disabled_expiry', '', False, {}, None):
            self.data = snapshot()
            self.data['profile'] = value
            self.reject()
        self.data = continuous_snapshot()
        del self.data['profile']
        self.reject()
        self.data = continuous_snapshot()
        del self.data['operatorAuthorization']
        self.reject()
        self.data = continuous_snapshot()
        self.data['profile'] = 'dns_expiring_qualification'
        self.reject()

    def test_revoked_invalid_future_expired_or_long_operator_authority_is_rejected(self):
        changes = [('revoked', True), ('revoked', 0), ('revoked', None),
                   ('authorizationId', ''), ('authorizationId', 'b'*64+'\n'),
                   ('authorizationId', 'https://secret.example'),
                   ('grantedAt', stamp(NOW + timedelta(seconds=1))),
                   ('grantedAt', stamp(NOW - timedelta(seconds=2))),
                   ('expiresAt', stamp(NOW + timedelta(days=7))),
                   ('expiresAt', stamp(NOW - timedelta(seconds=1))), ('extra', False)]
        for field, value in changes:
            with self.subTest(field=field, value=value):
                self.data = continuous_snapshot()
                self.data['operatorAuthorization'][field] = value
                self.reject()
        self.data = continuous_snapshot()
        self.data['operatorAuthorization']['expiresAt'] = stamp(NOW + timedelta(days=7))
        self.data['expiresAt'] = self.data['operatorAuthorization']['expiresAt']
        self.reject()  # Seven days plus one second from the original grant.

    def test_continuous_permissions_start_no_earlier_than_operator_grant(self):
        self.data = continuous_snapshot()
        self.data['operatorAuthorization']['grantedAt'] = stamp(NOW)
        nft = self.nft()
        self.assertEqual(set(re.findall(r'meta time >= (\d+)', nft)), {str(int(NOW.timestamp()))})

    def test_unchanged_pins_keep_hosts_and_bpf_bytes_across_new_dns_and_authorization(self):
        self.data = continuous_snapshot()
        first = self.render()
        later = NOW + timedelta(minutes=3)
        self.data['observedAt'] = stamp(later - timedelta(seconds=5))
        for source in self.data['hosts']:
            source['observedAt'], source['expiresAt'] = self.data['observedAt'], stamp(later + timedelta(seconds=55))
        self.data['operatorAuthorization'] = {'authorizationId': 'c'*64, 'grantedAt': stamp(later),
            'expiresAt': stamp(later + timedelta(days=7)), 'revoked': False}
        self.data['expiresAt'] = self.data['operatorAuthorization']['expiresAt']
        renewed = self.render(later)
        self.assertEqual(first['pinSetSha256'], renewed['pinSetSha256'])
        for target in first['artifacts']:
            if target != policy.NFT_TARGET:
                self.assertEqual(first['artifacts'][target], renewed['artifacts'][target])
                self.assertEqual(first['artifactSha256'][target], renewed['artifactSha256'][target])
        self.assertNotEqual(first['artifactSha256'][policy.NFT_TARGET], renewed['artifactSha256'][policy.NFT_TARGET])
        self.assertNotEqual(first['snapshotSha256'], renewed['snapshotSha256'])

    def test_continuous_pin_or_tunnel_scope_change_is_detectable_and_still_separate(self):
        self.data = continuous_snapshot()
        first = self.render()
        self.data['hosts'][0]['addresses'] = ['8.8.4.4']
        self.assertNotEqual(first['pinSetSha256'], self.render()['pinSetSha256'])
        self.data = continuous_snapshot()
        for flags in ({'dnsStub': True}, {'accessJwks': True}, {'dnsStub': True, 'accessJwks': True}):
            self.data['tunnel'] = flags
            changed = self.render()
            self.assertNotEqual(first['pinSetSha256'], changed['pinSetSha256'])
            self.assertNotIn('127.0.0.53', self.dropin('reader'))
            self.assertNotIn('127.0.0.53', self.dropin('gateway'))
            self.assertNotRegex(self.nft(), r'@tunnel_edges tcp dport 443')
            self.assertEqual('window connector JWKS' in self.nft(), flags.get('accessJwks', False))


if __name__ == '__main__':
    unittest.main()
