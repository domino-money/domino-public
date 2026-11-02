"""Offline unit/manifest regression checks; no systemd, network or credentials."""
import configparser
import json
from pathlib import Path
import shlex
import unittest

ROOT = Path(__file__).resolve().parents[1]


def parse_unit(text):
    # This candidate intentionally uses no continuations, repeated directives,
    # drop-ins or install section. This parser is not a general systemd parser.
    unit = configparser.ConfigParser(interpolation=None, strict=True,
                                     inline_comment_prefixes=None)
    unit.optionxform = str
    unit.read_string(text)
    if unit.defaults() or set(unit.sections()) != {'Unit', 'Service'}:
        raise ValueError('unexpected_unit_sections')
    return unit


def check_candidate(text, release):
    unit = parse_unit(text)
    service = unit['Service']
    expected = {
        'Type': 'exec', 'User': 'domino-tunnel', 'Group': 'domino-tunnel',
        'LoadCredential': 'cloudflared-token:/etc/domino/credentials/cloudflared-token',
        'UMask': '0077', 'NoNewPrivileges': 'yes', 'ProtectSystem': 'strict',
        'ProtectHome': 'yes', 'PrivateTmp': 'yes', 'PrivateDevices': 'yes',
        'InaccessiblePaths': '/etc/domino/credentials /opt/domino/releases /run/postgresql-domino',
        'CapabilityBoundingSet': '', 'AmbientCapabilities': '',
        'RestrictAddressFamilies': 'AF_UNIX AF_INET AF_INET6', 'RestrictNamespaces': 'yes',
        'RestrictRealtime': 'yes', 'RestrictSUIDSGID': 'yes', 'LockPersonality': 'yes',
        'SystemCallArchitectures': 'native', 'ProtectKernelTunables': 'yes',
        'ProtectKernelModules': 'yes', 'ProtectKernelLogs': 'yes',
        'ProtectControlGroups': 'yes', 'ProtectClock': 'yes',
        'IPAddressDeny': 'any', 'IPAddressAllow': 'localhost', 'LimitCORE': '0',
        'StandardOutput': 'journal', 'StandardError': 'journal', 'SyslogIdentifier': 'domino-tunnel',
        'Restart': 'on-failure', 'RestartSec': '5', 'TimeoutStartSec': '30',
        'TimeoutStopSec': '30', 'KillMode': 'mixed',
    }
    if set(service) != set(expected) | {'ExecStart', 'WorkingDirectory'}:
        raise ValueError('unexpected_service_directives')
    if any(service[name] != value for name, value in expected.items()):
        raise ValueError('service_boundary_changed')
    version = release['version']
    root = '/opt/domino/cloudflared/' + version
    if service['WorkingDirectory'] != root:
        raise ValueError('working_directory_pin_mismatch')
    argv = shlex.split(service['ExecStart'])
    expected_argv = ['/usr/bin/env', '-i', 'HOME=/nonexistent', 'PATH=/usr/bin:/bin',
        root + '/cloudflared', 'tunnel', '--config', root + '/connector.yml',
        '--no-autoupdate', '--loglevel', 'info', '--metrics', '127.0.0.1:20241',
        '--grace-period', '20s', '--management-diagnostics=false', 'run', '--token-file',
        '${CREDENTIALS_DIRECTORY}/cloudflared-token']
    if argv != expected_argv:
        raise ValueError('command_boundary_changed')
    expected_unit = {'Description': 'Domino staging Cloudflare Tunnel (' + version + ')',
        'Wants': 'network-online.target', 'After': 'network-online.target',
        'StartLimitIntervalSec': '60', 'StartLimitBurst': '3'}
    if dict(unit['Unit']) != expected_unit:
        raise ValueError('unit_dependencies_changed')
    return argv


class TunnelCandidateTests(unittest.TestCase):
    def setUp(self):
        self.unit = (ROOT / 'domino-tunnel.service').read_text()
        self.release = json.loads((ROOT / 'release.json').read_text())

    def test_candidate_has_only_secret_path_and_no_default_activation(self):
        argv = check_candidate(self.unit, self.release)
        self.assertNotIn('--token', argv)
        self.assertEqual(argv[0:2], ['/usr/bin/env', '-i'])
        self.assertEqual(argv[-1], '${CREDENTIALS_DIRECTORY}/cloudflared-token')
        self.assertNotIn('[Install]', self.unit)

    def test_boundary_weakening_is_rejected(self):
        mutations = [
            ('User=domino-tunnel', 'User=root'),
            ('Group=domino-tunnel', 'Group=domino-db'),
            ('LoadCredential=cloudflared-token:/etc/domino/credentials/cloudflared-token',
             'EnvironmentFile=/etc/domino/credentials/cloudflared-token'),
            ('/usr/bin/env -i ', '/usr/bin/env '),
            ('--token-file ${CREDENTIALS_DIRECTORY}/cloudflared-token', '--token fixture-value'),
            ('--no-autoupdate ', ''),
            ('--loglevel info', '--loglevel debug'),
            ('--metrics 127.0.0.1:20241', '--metrics 0.0.0.0:20241'),
            ('--management-diagnostics=false', '--management-diagnostics=true'),
            ('IPAddressDeny=any', 'IPAddressDeny='),
            ('IPAddressAllow=localhost', 'IPAddressAllow=any'),
            ('CapabilityBoundingSet=', 'CapabilityBoundingSet=CAP_NET_ADMIN'),
            ('ProtectSystem=strict', 'ProtectSystem=no'),
            ('InaccessiblePaths=/etc/domino/credentials /opt/domino/releases /run/postgresql-domino',
             'InaccessiblePaths='),
            ('TimeoutStopSec=30', 'TimeoutStopSec=infinity'),
            ('--config /opt/domino/cloudflared/2026.10.4/connector.yml', '--config /etc/cloudflared/config.yml'),
            ('cloudflared/2026.10.4/cloudflared', 'cloudflared/latest/cloudflared'),
        ]
        for before, after in mutations:
            with self.subTest(before=before), self.assertRaises(ValueError):
                check_candidate(self.unit.replace(before, after), self.release)

    def test_added_start_hooks_environment_and_install_are_rejected(self):
        for extra in ('ExecStartPre=/usr/bin/true', 'ExecStartPost=/usr/bin/true',
                      'Environment=TUNNEL_TOKEN=fixture-value', 'ReadWritePaths=/opt/domino/releases',
                      'SupplementaryGroups=domino-db', 'PrivateNetwork=yes',
                      '[Install]\nWantedBy=multi-user.target'):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                check_candidate(self.unit + '\n' + extra + '\n', self.release)

    def test_duplicate_security_directives_are_rejected(self):
        for extra in ('User=root', 'IPAddressAllow=any', 'ExecStart=/usr/bin/true'):
            with self.subTest(extra=extra), self.assertRaises(configparser.DuplicateOptionError):
                check_candidate(self.unit + '\n' + extra + '\n', self.release)

    def test_release_matches_official_metadata_pin(self):
        self.assertEqual(self.release['version'], '2026.10.4')
        self.assertEqual(self.release['platform'], 'linux-amd64')
        self.assertEqual(self.release['asset'], 'cloudflared-linux-amd64')
        self.assertEqual(self.release['size'], 40247428)
        self.assertEqual(self.release['sha256'], 'ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42')
        self.assertEqual(self.release['downloadUrl'], 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-linux-amd64')
        self.assertEqual(self.release['sourceCommit'], 'dc3b264da64a801bc3a8d5301a6db21401910ad5')
        self.assertFalse(self.release['tagSignatureVerified'])

    def test_local_config_is_empty_and_cannot_create_remote_routes(self):
        content = '\n'.join(line for line in (ROOT / 'connector.yml').read_text().splitlines()
                            if not line.startswith('#'))
        self.assertEqual(json.loads(content), {})


if __name__ == '__main__':
    unittest.main()
