"""Offline security boundaries for the generated development-only OFF bundle."""
import copy
import hashlib
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_infrastructure as d


SPEC = {'version': 1, 'releaseCommit': 'a' * 40,
        'contractManifestSha256': 'b' * 64,
        'issuer': 'https://example.cloudflareaccess.com',
        'audience': 'c' * 64, 'serviceId': 'development-example.access'}


def properties(raw):
    props = {}
    for line in raw.decode().splitlines():
        if line and not line.startswith(('#', '[')) and '=' in line:
            k, v = line.split('=', 1)
            props.setdefault(k, []).append(v)
    return props


class DevInfrastructureTests(unittest.TestCase):
    def setUp(self):
        self.files, self.manifest = d.generate(SPEC)

    def role(self, role):
        return properties(self.files['/etc/systemd/system/' + d.USERS[role] + '.service']['bytes'])

    def test_rejects_secrets_unknown_controls_and_false_types(self):
        for key, value in [('clientSecret', 'must-not-pass'), ('rpcUrls', []), ('enabled', True),
                           ('ports', [8876]), ('version', True), ('releaseCommit', 'main')]:
            with self.subTest(key=key):
                bad = {**SPEC, key: value}
                with self.assertRaises(d.InvalidPlan):
                    d.generate(bad)

    def test_metadata_cannot_inject_unit_or_network_configuration(self):
        for key, values in {
            'issuer': ['https://example.cloudflareaccess.com/path', 'https://user@example.cloudflareaccess.com',
                       'http://example.cloudflareaccess.com', 'https://127.0.0.1',
                       'https://example.cloudflareaccess.com\nExecStart=/bin/sh'],
            'serviceId': ['x\nEnvironment=TOKEN=bad', 'x y', '${TOKEN}', 'x;curl'],
            'releaseCommit': ['../' + 'a'*40, 'a'*40 + '\n', 'A'*40],
            'audience': ['c'*63, 'c'*64 + '\n'],
        }.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    with self.assertRaises(d.InvalidPlan):
                        d.generate({**SPEC, key: value})

    def test_no_production_targets_are_emitted(self):
        for path in self.files:
            self.assertTrue(path.startswith('/etc/domino/dev/') or
                path.startswith('/etc/systemd/system/domino-dev-') or
                path == '/etc/systemd/system/dominodev.slice', path)
        self.assertEqual(self.manifest['productionChanges'], [])
        self.assertFalse(self.manifest['enabled'])
        self.assertEqual(self.manifest['providerPermissions'], [])

    def test_exact_dedicated_identities_and_fixed_ports(self):
        self.assertEqual({r: (x['uid'], x['gid'], x['port']) for r, x in self.manifest['roles'].items()},
                         {'reader': (974, 974, 8890), 'gateway': (975, 975, 8891), 'tunnel': (976, 976, 20242)})
        for role in d.ROLES:
            p = self.role(role)
            self.assertEqual(p['User'], [d.USERS[role]])
            self.assertEqual(p['Group'], [d.USERS[role]])
            self.assertEqual(p['Slice'], ['dominodev.slice'])

    def test_reader_and_gateway_have_no_enable_or_inherited_environment(self):
        for role in d.ROLES:
            command = self.role(role)['ExecStart'][0]
            self.assertTrue(command.startswith('/usr/bin/env -i '))
            self.assertNotIn('--enable', command)
            self.assertNotIn('/opt/domino/releases/', command)
        self.assertNotIn('--profile', self.role('reader')['ExecStart'][0])

    def test_operator_directory_replacement_visible_and_not_service_writable(self):
        for role in d.ROLES:
            p = self.role(role)
            self.assertEqual(p['BindReadOnlyPaths'], [d.ROOT + '/' + role])
            self.assertEqual(p['ProtectSystem'], ['strict'])
            self.assertEqual(p['ReadWritePaths'], [d.STATE + ('/dev-read-gateway' if role == 'gateway' else '/' + role)])
            self.assertNotIn('EnvironmentFile', p)
        for name in ('profile', 'admission'):
            item = self.files[d.ROOT + '/gateway/' + name + '.json']
            self.assertEqual((item['uid'], item['gid'], item['mode']), (975, 975, 0o600))
        self.assertEqual(json.loads(self.files[d.ROOT + '/gateway/admission.json']['bytes'])['enabled'], False)

    def test_credential_and_production_runtime_isolation(self):
        for role in d.ROLES:
            blocked = ' '.join(self.role(role)['InaccessiblePaths'])
            for root in ('/opt/domino/releases', '/etc/domino/continuous-reads', '/etc/domino/credentials', '/etc/domino/dev/tunnel-private'):
                self.assertIn(root, blocked)
            for sibling in set(d.ROLES) - {role}:
                self.assertIn(d.ROOT + '/' + sibling, blocked)
        tunnel = self.role('tunnel')
        self.assertEqual(tunnel['LoadCredential'], ['dev-tunnel-token:/etc/domino/dev/tunnel-private/token'])
        self.assertIn('${CREDENTIALS_DIRECTORY}/dev-tunnel-token', tunnel['ExecStart'][0])
        self.assertFalse(any(p.endswith('/token') for p in self.files))
        self.assertFalse(self.manifest['privateInputs']['windowsServiceSecret']['vmStorageAllowed'])

    def test_only_reader_can_traverse_database_socket(self):
        self.assertEqual(self.role('reader')['SupplementaryGroups'], ['domino-db'])
        for role in ('gateway', 'tunnel'):
            self.assertNotIn('SupplementaryGroups', self.role(role))
            self.assertIn('/run/postgresql-domino', self.role(role)['InaccessiblePaths'])

    def test_off_network_has_no_external_dns_or_production_original_destination(self):
        raw = self.files[d.ROOT + '/off-policy.nft']['bytes'].decode()
        self.assertEqual(set(re.findall(r'meta skuid (\d+)', raw)), {'974', '975', '976'})
        self.assertEqual(re.findall(r'tcp dport (\d+)', raw), ['8890'])
        self.assertEqual(set(re.findall(r'tcp sport (\d+)', raw)), {'8890', '8891', '20242'})
        for port in ('8876', '8878', '8879', '8880', '8881', '20241', '7844', '443'):
            self.assertNotRegex(raw, r'(?:dport|sport) ' + port + r'\b')
        self.assertNotIn('udp dport', raw)
        self.assertEqual(raw.count(' ct direction reply ct state established '), 3)
        self.assertEqual(raw.count('counter name denied_'), 3)
        self.assertNotIn('domino_continuous_reads', raw)
        for role in d.ROLES:
            self.assertEqual(self.role(role)['IPAddressDeny'], ['any'])
            self.assertEqual(self.role(role)['IPAddressAllow'], ['127.0.0.1/32'])

    def test_connector_not_selected_or_automatically_startable(self):
        target = self.files['/etc/systemd/system/domino-dev-off.target']['bytes'].decode()
        self.assertNotIn('domino-dev-tunnel.service', target)
        self.assertFalse(self.manifest['connectorSelected'])
        tunnel = self.role('tunnel')
        self.assertIn('/run/domino-dev-connector.reviewed', tunnel['ConditionPathExists'])
        self.assertIn('--metrics 127.0.0.1:20242', tunnel['ExecStart'][0])
        self.assertIn('--management-diagnostics=false', tunnel['ExecStart'][0])
        for path, item in self.files.items():
            if path.endswith(('.service', '.target', '.slice')):
                self.assertNotIn('[Install]', item['bytes'].decode())

    def test_resource_envelope_and_drain(self):
        p = properties(self.files['/etc/systemd/system/dominodev.slice']['bytes'])
        self.assertEqual(p['CPUQuota'], ['50%'])
        self.assertEqual(p['MemoryMax'], ['1G'])
        self.assertEqual(p['MemoryHigh'], ['768M'])
        self.assertEqual(p['TasksMax'], ['64'])
        for role in d.ROLES:
            self.assertEqual(self.role(role)['KillMode'], ['control-group'])
            self.assertEqual(self.role(role)['Restart'], ['no'])
            self.assertEqual(self.role(role)['MemorySwapMax'], ['0'])
        policy_unit = properties(self.files['/etc/systemd/system/domino-dev-egress.service']['bytes'])
        self.assertEqual(policy_unit['ExecStop'], ['/usr/bin/rm -f /run/domino-dev-off.ready'])

    def test_hashes_bind_every_file_and_the_review_procedure(self):
        self.assertEqual(d.generate(copy.deepcopy(SPEC)), (self.files, self.manifest))
        for entry in self.manifest['files']:
            self.assertEqual(entry['sha256'], hashlib.sha256(self.files[entry['target']]['bytes']).hexdigest())
        plan = d.procedure(self.manifest)
        self.assertEqual(plan['manifestSha256'], d.sha(d.canonical(self.manifest)))
        self.assertFalse(plan['liveApplyImplemented'])
        changed = copy.deepcopy(self.manifest)
        changed['releaseCommit'] = 'd'*40
        self.assertNotEqual(d.procedure(changed)['manifestSha256'], plan['manifestSha256'])

    def test_local_generation_is_exclusive_private_and_never_invokes_a_tool(self):
        with tempfile.TemporaryDirectory() as parent, patch('subprocess.run', side_effect=AssertionError('no commands')):
            out = Path(parent)/'bundle'
            result = d.write_bundle(SPEC, out)
            self.assertFalse(result['installed'])
            self.assertEqual(result['manifestSha256'], d.sha((out/'manifest.json').read_bytes()))
            self.assertEqual(result['procedureSha256'], d.sha((out/'procedure.json').read_bytes()))
            for path in out.rglob('*'):
                if path.is_file():
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                d.write_bundle(SPEC, out)
            link = Path(parent)/'link'
            link.symlink_to(out, target_is_directory=True)
            with self.assertRaises(FileExistsError):
                d.write_bundle(SPEC, link)

    def test_duplicate_input_keys_are_refused(self):
        with tempfile.TemporaryDirectory() as parent:
            p = Path(parent)/'input.json'
            p.write_text(json.dumps(SPEC)[:-1] + ', "version": 1}')
            with self.assertRaises(d.InvalidPlan):
                d.load_spec(p)


if __name__ == '__main__':
    unittest.main()
