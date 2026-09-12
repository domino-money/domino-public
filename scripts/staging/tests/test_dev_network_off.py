"""Offline transaction ordering/adoption boundaries; no native execution."""
from datetime import datetime, timedelta, timezone
from contextlib import nullcontext
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_network_off as d


class NetworkOffTests(unittest.TestCase):
    def bundle(self):
        now = datetime.now(timezone.utc)
        auth = {'authorizationId': 'a'*64, 'grantedAt': (now-timedelta(hours=1)).isoformat(),
                'expiresAt': (now+timedelta(hours=1)).isoformat(), 'revoked': False}
        return {'path': Path('/private/network'), 'digest': 'b'*64, 'renderer': Mock(),
                'snapshot': {'operatorAuthorization': auth},
                'result': {'expiresAt': auth['expiresAt'], 'artifacts': {p: 'reviewed' for p in d.TARGETS}}}

    def test_dns_window_checked_for_initial_adoption_only(self):
        b = self.bundle()
        with patch.object(d.n, 'read', return_value=json.dumps(b['snapshot']['operatorAuthorization']).encode()):
            d.authorization(b)
            b['renderer'].validate.assert_called_once()
            b['renderer'].validate.side_effect = ValueError('DNS expired after selection')
            d.authorization(b, adoption=False)
            with self.assertRaises(ValueError): d.authorization(b)

    def test_held_pins_still_require_current_unrevoked_authorization(self):
        b = self.bundle()
        for change in ('revoked', 'different', 'expired'):
            auth = dict(b['snapshot']['operatorAuthorization'])
            if change == 'revoked': auth['revoked'] = True
            elif change == 'different': auth['authorizationId'] = 'c'*64
            else:
                auth['expiresAt'] = (datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()
                b['snapshot']['operatorAuthorization'] = dict(auth)
            with self.subTest(change=change), patch.object(d.n, 'read', return_value=json.dumps(auth).encode()), \
                 self.assertRaises(d.n.Refused):
                d.authorization(b, adoption=False)

    def test_shape_ignores_counters_handles_expiry_but_retains_permissions(self):
        def data(uid=974, address='1.1.1.1'):
            return {'nftables': [{'set': {'name': 'pins', 'elem': [{'val': address, 'expires': 42}]}},
                {'rule': {'handle': 1, 'expr': [{'counter': {'packets': 1, 'bytes': 12}},
                                              {'match': {'right': uid}}, {'accept': None}]}}]}
        changed = data(); changed['nftables'][1]['rule']['handle'] = 9
        changed['nftables'][0]['set']['elem'][0]['expires'] = 1
        self.assertEqual(d.table_shape(data()), d.table_shape(changed))
        self.assertNotEqual(d.table_shape(data()), d.table_shape(data(uid=0)))
        self.assertNotEqual(d.table_shape(data()), d.table_shape(data(address='8.8.8.8')))
        expired = data(); del expired['nftables'][0]['set']['elem']
        self.assertEqual(d.table_shape(data(), expired=True), d.table_shape(expired, expired=True))

    def test_set_elements_may_reorder_but_rules_may_not(self):
        a = {'nftables': [{'set': {'elem': ['1.1.1.1', '2.2.2.2']}},
                         {'rule': {'expr': [{'counter': {}}, {'drop': None}]}}]}
        b = {'nftables': [{'set': {'elem': ['2.2.2.2', '1.1.1.1']}},
                         {'rule': {'expr': [{'counter': {}}, {'drop': None}]}}]}
        self.assertEqual(d.table_shape(a), d.table_shape(b))
        b['nftables'][1]['rule']['expr'].reverse()
        self.assertNotEqual(d.table_shape(a), d.table_shape(b))
        b['nftables'].reverse()
        self.assertNotEqual(d.table_shape(a), d.table_shape(b))

    def test_network_scope_binds_installed_issuer_and_operator_rpc_inventory(self):
        c = {'files': {'/etc/domino/dev/gateway/profile.json': {'bytes': b'{"issuer":"https://ordio-hq.cloudflareaccess.com"}'}},
             'baseline': {'manifest': {'pins': {'robinhood-mainnet.g.alchemy.com': []}}}}
        b = self.bundle(); b['renderer'].RPC_HOSTS = {'robinhood-mainnet.g.alchemy.com', 'rpc.mainnet.chain.robinhood.com'}
        b['snapshot'].update(accessIssuer='ordio-hq.cloudflareaccess.com', rpcHosts=['robinhood-mainnet.g.alchemy.com'], inventoryHost=None)
        d.scope(c, b)
        for key, value in [('accessIssuer', 'other.cloudflareaccess.com'),
                           ('rpcHosts', ['rpc.mainnet.chain.robinhood.com']),
                           ('inventoryHost', 'other.example')]:
            original = b['snapshot'][key]; b['snapshot'][key] = value
            with self.subTest(key=key), self.assertRaises(d.n.Refused): d.scope(c, b)
            b['snapshot'][key] = original

    def test_non_role_units_cannot_gain_loaded_overrides(self):
        for changed in ('dominodev.slice', 'domino-dev-egress.service', 'domino-dev-off.target'):
            host = Mock()
            def props(unit, keys):
                return {'FragmentPath': '/etc/systemd/system/' + unit,
                        'DropInPaths': '/run/systemd/system/foreign.conf' if unit == changed else '',
                        'MainPID': '0', 'ActiveState': 'inactive'}
            host.properties.side_effect = props
            with self.subTest(changed=changed), self.assertRaises(d.n.Refused):
                d.guard({'files': {}}, self.bundle(), host, {'phase': 'installed_off', 'productionExtra': {}})
            host.drain.assert_not_called()
            host.run.assert_not_called()

    def test_cli_revoke_recovers_only_recognized_interrupted_phases(self):
        for phase, recovery in [('adopting', True), ('revoking', True), ('positive_network_off_apps', False)]:
            c = {'plan': {'manifestSha256': d.OFF_MANIFEST_SHA}}
            b = self.bundle(); state = {'network': {'phase': phase}}
            args = ['dev_network_off.py', 'revoke', '--native-candidate', '/private/off',
                    '--network', '/private/network', '--result-sha256', b['digest']]
            with self.subTest(phase=phase), patch.object(d.sys, 'argv', args), \
                 patch.object(d.os, 'geteuid', return_value=0), patch.object(d.os, 'umask'), \
                 patch.object(d.n, 'candidate', return_value=c), patch.object(d, 'load', return_value=b), \
                 patch.object(d, 'scope'), patch.object(d.n, 'locked', return_value=nullcontext()), \
                 patch.object(d.n, 'journal', return_value=state), patch.object(d, 'revoke') as revoke, \
                 patch('builtins.print'):
                d.main()
            self.assertEqual(revoke.call_args.kwargs, {'recovery': recovery})

    def test_revocation_loads_off_before_drain_and_ignores_current_authorization(self):
        b = self.bundle(); c = {'files': {d.POLICY: {'bytes': b'OFF'}}}
        state = {'productionExtra': {}, 'network': {'phase': 'positive_network_off_apps', 'resultSha256': b['digest'], 'positiveKernel': {}, 'offKernel': {}}}
        host = Mock(); sequence = []
        host.run.side_effect = lambda args: sequence.append(args[0:3])
        host.drain.side_effect = lambda: sequence.append('drain')
        with patch.object(d, 'guard'), patch.object(d, 'table_guard'), \
             patch.object(d.n, 'read', return_value=b'OFF'), patch.object(d.n, 'journal'), \
             patch.object(d.n, 'replace', side_effect=lambda *a: sequence.append('persist-OFF')), \
             patch.object(d.n, 'installed_known'), patch.object(d, 'EXTRA', set()), \
             patch.object(d, 'authorization', side_effect=AssertionError('must not read authorization')):
            d.revoke(c, b, host, state)
        self.assertEqual(sequence[:3], [['/usr/sbin/nft', '-f', '/private/network/prepared/off.nft'], 'persist-OFF', 'drain'])
        self.assertEqual(state['network']['phase'], 'revoked_off_stopped')

    def test_off_file_failure_still_drains_after_hot_revocation(self):
        b = self.bundle(); c = {'files': {d.POLICY: {'bytes': b'OFF'}}}
        state = {'productionExtra': {}, 'network': {'phase': 'positive_network_off_apps', 'resultSha256': b['digest'], 'positiveKernel': {}, 'offKernel': {}}}
        host = Mock()
        with patch.object(d, 'guard'), patch.object(d, 'table_guard'), \
             patch.object(d.n, 'read', return_value=b'OFF'), patch.object(d.n, 'journal'), \
             patch.object(d.n, 'replace', side_effect=OSError()), self.assertRaises(OSError):
            d.revoke(c, b, host, state)
        host.run.assert_called_once_with(['/usr/sbin/nft', '-f', '/private/network/prepared/off.nft'])
        host.drain.assert_called_once()

    def test_exactly_seven_artifacts_and_no_enable_or_admission_targets(self):
        self.assertEqual(len(d.TARGETS), 7)
        self.assertEqual({p for p in d.TARGETS if p.endswith('.nft')}, {d.POLICY})
        self.assertEqual(len([p for p in d.TARGETS if p.endswith('/hosts')]), 3)
        self.assertEqual(len([p for p in d.TARGETS if p.endswith('/50-dev-egress.conf')]), 3)
        self.assertTrue(all('admission' not in p and 'profile.json' not in p and 'token' not in p for p in d.TARGETS))


if __name__ == '__main__': unittest.main()
