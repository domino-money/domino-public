"""Offline unit regression checks; no systemd, network, database or credentials."""
import configparser
from pathlib import Path
import shlex
import unittest

ROOT = Path(__file__).resolve().parents[1]


def parse_unit(text, sections):
    # These candidates intentionally use no continuations, repeated directives
    # or drop-ins. This parser is not a general systemd parser.
    unit = configparser.ConfigParser(interpolation=None, strict=True,
                                     inline_comment_prefixes=None)
    unit.optionxform = str
    unit.read_string(text)
    if unit.defaults() or set(unit.sections()) != sections:
        raise ValueError('unexpected_unit_sections')
    return unit


class ReferenceCollectorUnitTests(unittest.TestCase):
    def service(self):
        text = (ROOT / 'domino-reference-collector.service').read_text()
        return parse_unit(text, {'Unit', 'Service'})

    def timer(self):
        text = (ROOT / 'domino-reference-collector.timer').read_text()
        return parse_unit(text, {'Unit', 'Timer', 'Install'})

    def test_the_unit_sections_are_exactly_the_reviewed_candidates(self):
        self.assertEqual(dict(self.service()['Unit']), {
            'Description': 'Domino external market reference collection (one bounded pass)',
            'Wants': 'network-online.target',
            'After': 'network-online.target domino-continuous-egress.service'})
        self.assertEqual(dict(self.timer()['Unit']), {
            'Description': 'Run the Domino reference collection on the five-minute grid'})

    def test_the_service_is_a_bounded_pass_under_the_recorded_hardening(self):
        service = self.service()['Service']
        expected = {
            'Type': 'oneshot', 'User': 'domino-reference', 'Group': 'domino-reference',
            'WorkingDirectory': '/opt/domino/reference-collector/release',
            'UMask': '0077', 'NoNewPrivileges': 'yes', 'ProtectSystem': 'strict',
            'ProtectHome': 'yes', 'PrivateTmp': 'yes', 'PrivateDevices': 'yes',
            # The catalogue socket stays reachable; credentials and the
            # production releases do not.
            'InaccessiblePaths': '/etc/domino/credentials /opt/domino/releases',
            'CapabilityBoundingSet': '', 'AmbientCapabilities': '',
            'RestrictAddressFamilies': 'AF_UNIX AF_INET AF_INET6',
            'RestrictNamespaces': 'yes', 'RestrictRealtime': 'yes',
            'RestrictSUIDSGID': 'yes', 'LockPersonality': 'yes',
            'SystemCallArchitectures': 'native', 'ProtectKernelTunables': 'yes',
            'ProtectKernelModules': 'yes', 'ProtectKernelLogs': 'yes',
            'ProtectControlGroups': 'yes', 'ProtectClock': 'yes',
            'IPAddressDeny': 'any', 'IPAddressAllow': 'localhost', 'LimitCORE': '0',
            'StandardOutput': 'journal', 'StandardError': 'journal',
            'SyslogIdentifier': 'domino-reference-collector',
            'TimeoutStartSec': '150', 'TimeoutStopSec': '30',
        }
        observed = {key: service[key] for key in service if key != 'ExecStart'}
        self.assertEqual(observed, expected)

    def test_the_command_is_the_bounded_every_mapping_pass_with_no_secrets(self):
        command = shlex.split(self.service()['Service']['ExecStart'])
        self.assertEqual(command[:2], ['/usr/bin/env', '-i'])
        self.assertIn('/opt/domino/reference-collector/venv/bin/python3.14', command)
        self.assertIn('backend/collect_reference_prices.py', command)
        for flag in ('--every-mapping', '--store'):
            self.assertIn(flag, command)
        self.assertEqual(command[command.index('--lookback') + 1], '3600')
        self.assertEqual(command[command.index('--provider-config') + 1],
                         '/etc/domino/reference-collector/providers.json')
        lookback = int(command[command.index('--lookback') + 1])
        budget = int(command[command.index('--budget-seconds') + 1])
        # The pass reserves one mapping's bounded worst case before starting
        # it, so budget bounds the whole run; the unit only needs slack for
        # interpreter startup and the report line.
        reserved = 12 + 3 + 5 * (lookback // 300 + 3)
        self.assertLess(reserved, budget)
        self.assertLessEqual(budget + 25, int(self.service()['Service']['TimeoutStartSec']))
        joined = ' '.join(command).lower()
        for forbidden in ('key', 'token', 'secret', 'password'):
            self.assertNotIn(forbidden, joined)

    def test_localhost_only_egress_is_the_shipped_default(self):
        service = self.service()['Service']
        self.assertEqual((service['IPAddressDeny'], service['IPAddressAllow']),
                         ('any', 'localhost'))

    def test_the_timer_is_the_single_activation_point_on_the_grid(self):
        self.assertNotIn('Install', self.service().sections())
        timer = self.timer()
        self.assertEqual(dict(timer['Timer']), {
            'OnCalendar': '*-*-* *:00/5:00', 'AccuracySec': '30',
            'RandomizedDelaySec': '20', 'Persistent': 'true',
            'Unit': 'domino-reference-collector.service'})
        self.assertEqual(dict(timer['Install']), {'WantedBy': 'timers.target'})

    def test_no_restart_policy_competes_with_the_timer(self):
        service = self.service()['Service']
        for directive in ('Restart', 'RestartSec'):
            self.assertNotIn(directive, service)


if __name__ == '__main__':
    unittest.main()
