"""Offline installer boundaries. No root/systemd/PostgreSQL/network execution."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_native_install as d


def baseline():
    values = {
        d.PEERS[0]: b'domino domino-read domino_catalogue_reader\n',
        d.PEERS[1]: b'# preserve this comment\nlocal all postgres peer\nlocal all all reject\nhost all all ::0/0 reject\n',
    }
    return {'peers': {str(p): {'text': raw.decode(), 'sha256': d.sha(raw), 'mode': 0o600,
            'links': 1, 'symlink': False, 'uid': 109, 'gid': 113} for p, raw in values.items()},
            'postgresSnapshot': {'before': True}}


class NativeInstallerTests(unittest.TestCase):
    def test_exact_staged_tree_rejects_content_mode_link_and_inventory_drift(self):
        for change in ('content', 'filemode', 'dirmode', 'extra_file', 'extra_dir', 'missing', 'symlink', 'hardlink'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temp:
                root = Path(temp) / 'root'; root.mkdir(mode=0o700)
                leaf = root / 'known'; leaf.write_bytes(b'reviewed'); leaf.chmod(0o600)
                dirs = {root: (os.geteuid(), os.getegid(), 0o700)}
                files = {leaf: {'uid': os.geteuid(), 'gid': os.getegid(), 'mode': 0o600, 'bytes': b'reviewed'}}
                # Fixture parents are user-owned on developer workstations;
                # native leaf and tree checks still execute without mocks.
                with patch.object(d, 'parents'):
                    d.exact_tree(root, dirs, files)
                    if change == 'content': leaf.write_bytes(b'changed')
                    elif change == 'filemode': leaf.chmod(0o644)
                    elif change == 'dirmode': root.chmod(0o755)
                    elif change == 'extra_file': (root / 'runtime-secret').write_bytes(b'extra')
                    elif change == 'extra_dir': (root / 'runtime').mkdir()
                    elif change == 'missing': leaf.unlink()
                    elif change == 'symlink':
                        leaf.unlink(); leaf.symlink_to(Path(temp) / 'outside')
                    else: os.link(leaf, Path(temp) / 'outside')
                    with self.assertRaises(d.Refused):
                        d.exact_tree(root, dirs, files)

    def test_resume_drift_stops_before_journal_sql_reload_or_cleanup(self):
        host = Mock(); host.staged.side_effect = d.Refused('staged_tree_inventory_drift')
        with patch.object(d, 'journal', return_value={'phase': 'rolled_back', 'unitsInstalled': True}) as journal, \
             patch.object(d, 'recover_failure') as recover, self.assertRaises(d.Refused):
            d.resume_staged({}, host)
        journal.assert_called_once_with({})
        host.sql.assert_not_called(); host.unit_check.assert_not_called(); host.run.assert_not_called()
        recover.assert_not_called()

    def test_resume_port_occupied_by_other_uid_stops_before_sql(self):
        for port in (8890, 8891, 20242):
            host = d.Native()
            state = {'phase': 'rolled_back', 'unitsInstalled': True, 'productionExtra': {}}
            with self.subTest(port=port), patch.object(d, 'journal', return_value=state) as journal, \
                 patch.object(host, 'production'), patch.object(host, 'no_dev_processes'), \
                 patch.object(host, 'run', return_value=f'LISTEN 0 128 127.0.0.1:{port} 0.0.0.0:*'), \
                 patch.object(host, 'sql') as sql, patch.object(host, 'unit_check') as unit_check, \
                 self.assertRaisesRegex(d.Refused, 'development_port_busy'):
                d.resume_staged({}, host)
            journal.assert_called_once_with({})
            sql.assert_not_called(); unit_check.assert_not_called()

    def test_resume_enters_existing_shared_sql_path_after_all_checks(self):
        host = Mock(); state = {'phase': 'rolled_back', 'unitsInstalled': True, 'productionExtra': {}}
        order = []
        host.staged.side_effect = lambda *a: order.append('staged-check')
        host.unit_check.side_effect = lambda *a: order.append('native-unit-check')
        host.production.side_effect = lambda *a, **k: order.append('production-check')
        with patch.object(d, 'journal', return_value=state), \
             patch.object(d, 'finish_off', side_effect=lambda *a: order.append('shared-sql-through-off')):
            d.resume_staged({}, host)
        self.assertEqual(order, ['staged-check', 'native-unit-check', 'production-check', 'shared-sql-through-off'])

    def test_staged_requires_completed_rollback_and_no_remaining_cgroup(self):
        host = d.Native()
        for state in ({'phase': 'rollback', 'unitsInstalled': True},
                      {'phase': 'rolled_back', 'unitsInstalled': False}):
            with self.subTest(state=state), patch.object(host, 'production') as production, self.assertRaises(d.Refused):
                host.staged({}, state)
            production.assert_not_called()
        with patch.object(host, 'production'), patch.object(host, 'no_dev_processes'), patch.object(host, 'listener_free'), \
             patch.object(d.os.path, 'lexists', side_effect=lambda p: p == '/sys/fs/cgroup/dominodev.slice'), \
             patch.object(host, 'staged_identities') as identities, self.assertRaises(d.Refused):
            host.staged({}, {'phase': 'rolled_back', 'unitsInstalled': True, 'productionExtra': {}})
        identities.assert_not_called()

    def test_only_ipaddressallow_order_is_semantically_ignored(self):
        expected = {'IPAddressAllow': '127.0.0.1/32 40.160.64.146/32 40.160.64.137/32',
                    'MainPID': '31793', 'IPAddressDeny': '0.0.0.0/0 ::/0', 'NRestarts': '0'}
        reordered = {**expected, 'IPAddressAllow': '40.160.64.137/32 127.0.0.1/32 40.160.64.146/32'}
        self.assertTrue(d.same_production_properties(reordered, expected))
        for key, value in [('IPAddressAllow', '127.0.0.1/32 40.160.64.146/32'),
                           ('IPAddressAllow', expected['IPAddressAllow'] + ' 1.1.1.1/32'),
                           ('IPAddressAllow', expected['IPAddressAllow'].replace('127.0.0.1/32', '127.0.0.0/8')),
                           ('IPAddressDeny', '::/0 0.0.0.0/0'), ('MainPID', '31794'), ('NRestarts', '1')]:
            with self.subTest(key=key, value=value):
                self.assertFalse(d.same_production_properties({**reordered, key: value}, expected))
        self.assertFalse(d.same_production_properties({**reordered, 'Extra': ''}, expected))

    def test_only_empty_inactive_implicit_slice_is_allowed(self):
        empty = {'LoadState': 'loaded', 'FragmentPath': '', 'DropInPaths': '',
                 'WantedBy': '', 'RequiredBy': '', 'ActiveState': 'inactive',
                 'SubState': 'dead', 'ControlGroup': '', 'TasksCurrent': '[not set]', 'Transient': 'no'}
        d.check_absent_unit('dominodev.slice', empty)
        for key, value in [('FragmentPath', '/etc/systemd/system/dominodev.slice'),
                           ('DropInPaths', '/etc/systemd/system/slice.d/shared.conf'),
                           ('WantedBy', 'multi-user.target'), ('RequiredBy', 'foreign.service'),
                           ('ActiveState', 'active'), ('SubState', 'running'),
                           ('ControlGroup', '/dominodev.slice'), ('TasksCurrent', '1'),
                           ('MainPID', '42'), ('Transient', 'yes')]:
            with self.subTest(key=key), self.assertRaises(d.Refused):
                d.check_absent_unit('dominodev.slice', {**empty, key: value})
        with self.assertRaises(d.Refused):
            d.check_absent_unit('domino-dev-read.service', empty)
        d.check_absent_unit('domino-dev-read.service', {'LoadState': 'not-found'})

    def test_peer_additions_preserve_bytes_and_precede_reject(self):
        old, new = d.peer_bytes(baseline())
        addition = ' '.join(d.sql_profile.PEER_ADDITIONS['hba']).encode() + b'\n'
        self.assertEqual(new[d.PEERS[1]].replace(addition, b''), old[d.PEERS[1]])
        self.assertLess(new[d.PEERS[1]].index(addition), new[d.PEERS[1]].index(b'local all all reject'))
        self.assertTrue(new[d.PEERS[0]].startswith(old[d.PEERS[0]]))

    def test_peer_reject_ambiguity_and_modified_snapshot_fail(self):
        for change in ('duplicate', 'bytes', 'owner'):
            data = baseline(); item = data['peers'][str(d.PEERS[1])]
            if change == 'duplicate':
                item['text'] += 'local all all reject\n'; item['sha256'] = d.sha(item['text'].encode())
            elif change == 'bytes':
                item['text'] += '# drift\n'
            else:
                item['uid'] = 975
            with self.subTest(change=change), self.assertRaises(d.Refused):
                d.peer_bytes(data)

    def test_json_duplicate_nonfinite_and_budget_rejected(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}'):
            with self.subTest(raw=raw), self.assertRaises(d.Refused):
                d.parse(raw)
        with self.assertRaises(d.Refused):
            d.parse(b'{}', limit=1)

    def test_large_guarded_sql_document_has_explicit_bounded_read_and_parse(self):
        document = {'applySql': 'x' * 1100000, 'rollbackSql': 'y' * 1100000}
        raw = json.dumps(document).encode()
        with patch.object(d, 'read', return_value=raw) as reader:
            self.assertEqual(d.checked_document('/private/sql-plan.json', d.sha(raw),
                             maximum=8*1024*1024), document)
            reader.assert_called_once_with('/private/sql-plan.json', mode=0o600, maximum=8*1024*1024)
            with self.assertRaises(d.Refused):
                d.checked_document('/private/spec.json', d.sha(raw))
            with self.assertRaises(d.Refused):
                d.checked_document('/private/sql-plan.json', '0'*64, maximum=8*1024*1024)

    def test_sql_plan_accepts_serialized_tuples_but_not_changed_sql(self):
        generated = {'peerAdditions': d.sql_profile.PEER_ADDITIONS, 'applySql': 'guarded apply'}
        document = json.loads(json.dumps(generated))
        self.assertNotEqual(document, generated)
        with patch.object(d.sql_profile, 'build_sql', return_value=generated):
            d.check_sql_plan(document, {})
            document['applySql'] = 'unguarded apply'
            with self.assertRaises(d.Refused):
                d.check_sql_plan(document, {})

    def test_kernel_normalization_keeps_foreign_semantics_and_handles(self):
        before = {'nftables': [{'metainfo': {'version': 'x'}}, {'rule': {'table': 'production',
            'handle': 12, 'expr': [{'counter': {'packets': 1, 'bytes': 100}}, {'drop': None}]}}]}
        after = copy.deepcopy(before)
        after['nftables'][1]['rule']['expr'][0]['counter']['bytes'] = 1000
        after['nftables'].append({'table': {'family': 'inet', 'name': 'domino_dev_off'}})
        self.assertEqual(d.clean_kernel(before), d.clean_kernel(after, remove_dev=True))
        after['nftables'][1]['rule']['expr'][-1] = {'accept': None}
        self.assertNotEqual(d.clean_kernel(before), d.clean_kernel(after, remove_dev=True))
        after['nftables'][1]['rule']['handle'] = 13
        self.assertNotEqual(d.clean_kernel(before), d.clean_kernel(after, remove_dev=True))

    def test_off_health_uses_real_disabled_routes_without_credentials(self):
        seen = []
        def connection(host, port, timeout):
            self.assertEqual(host, '127.0.0.1')
            obj = Mock()
            obj.request.side_effect = lambda method, path: seen.append((port, method, path))
            response = Mock(status=503 if port == 8890 else 403)
            response.read.return_value = b'{"error":"upstream_unavailable"}'
            obj.getresponse.return_value = response
            return obj
        with patch.object(d.http.client, 'HTTPConnection', side_effect=connection):
            d.Native().off_health()
        self.assertEqual(seen, [(8890, 'GET', '/health'), (8891, 'GET', '/internal/dev/v1/status')])

    def test_off_health_does_not_accept_wrong_route_404(self):
        connection = Mock()
        response = Mock(status=404); response.read.return_value = b'{"error":"route_not_available"}'
        connection.getresponse.return_value = response
        with patch.object(d.http.client, 'HTTPConnection', return_value=connection), self.assertRaises(d.Refused):
            d.Native().off_health()

    def test_stage_explicitly_opens_source_ancestors_after_umask(self):
        c = {'source': {}, 'manifest': {'directories': []}, 'files': {}}
        with patch.object(d, 'Path') as paths, patch.object(d, 'SOURCE') as source, \
             patch.object(d.os, 'chmod') as chmod, patch.object(d.os, 'walk', return_value=[]):
            d.Native().stage(c)
        self.assertIn(unittest.mock.call('/opt/domino/dev', 0o755), chmod.call_args_list)
        self.assertIn(unittest.mock.call(d.infra.CODE, 0o755), chmod.call_args_list)
        source.mkdir.assert_called_once_with(mode=0o755)
        self.assertEqual(paths.return_value.mkdir.call_count, 2)

    def test_rollback_rejects_unknown_loaded_override_before_any_drain(self):
        for loaded in ({'FragmentPath': '/usr/lib/systemd/system/domino-dev-read.service', 'DropInPaths': ''},
                       {'FragmentPath': '/etc/systemd/system/dominodev.slice',
                        'DropInPaths': '/run/systemd/system/service.d/unsafe.conf'}):
            host = Mock(); host.properties.return_value = loaded
            with self.subTest(loaded=loaded), patch.object(d.os.path, 'lexists', return_value=False), \
                 self.assertRaises(d.Refused):
                d.rollback({'files': {}}, host, {})
            host.drain.assert_not_called()
            host.sql.assert_not_called()

    def test_rollback_restores_peers_before_sql_and_never_drains_production(self):
        c = {'baseline': baseline(), 'sql': {'expectedAfter': {'after': True}, 'rollbackSql': 'GUARDED_ROLLBACK'}}
        state = {'productionExtra': {}, 'unitsInstalled': True}
        host = Mock(); host.snapshot_sql.side_effect = [{'after': True}, {'before': True}]
        order = []
        host.drain.side_effect = lambda: order.append('drain-dev')
        host.reload_peers.side_effect = lambda: order.append('reload-old-peers')
        host.sql.side_effect = lambda sql: order.append(sql)
        with patch.object(d, 'installed_known'), patch.object(d, 'journal'), \
             patch.object(d, 'read', return_value=b'changed-known-peer'), \
             patch.object(d, 'replace', side_effect=lambda *a, **k: order.append('restore-peer')):
            d.rollback(c, host, state)
        self.assertEqual(order, ['drain-dev', 'restore-peer', 'restore-peer', 'reload-old-peers', 'GUARDED_ROLLBACK'])
        self.assertEqual(state['phase'], 'rolled_back')
        host.run.assert_not_called()

    def test_drain_accepts_stopped_target_without_process_properties(self):
        host = d.Native()
        def props(name, keys):
            if name == 'domino-dev-off.target':
                return {'ActiveState': 'inactive'}
            return {'MainPID': '0', 'ActiveState': 'inactive', 'ControlGroup': ''}
        with patch.object(host, 'run') as run, patch.object(host, 'properties', side_effect=props), \
             patch.object(host, 'no_dev_processes') as no_processes:
            host.drain()
        run.assert_called_once_with(['/usr/bin/systemctl', 'stop', *d.STOP])
        no_processes.assert_called_once()

    def test_unknown_sql_state_refuses_drop_after_safe_peer_removal(self):
        c = {'baseline': baseline(), 'sql': {'expectedAfter': {'after': True}, 'rollbackSql': 'DROP'}}
        host = Mock(); host.snapshot_sql.return_value = {'foreign_grant': True}
        with patch.object(d, 'installed_known'), patch.object(d, 'journal'), \
             patch.object(d, 'read', return_value=b'known'), patch.object(d, 'replace'), \
             self.assertRaises(d.Refused):
            d.rollback(c, host, {'productionExtra': {}, 'unitsInstalled': True})
        host.drain.assert_called_once()
        host.reload_peers.assert_called_once()
        host.sql.assert_not_called()

    def test_sql_commit_ambiguity_triggers_known_state_cleanup(self):
        c = {'path': Path('/private/fixture'), 'digest': 'a'*64, 'sql': {'applySql': 'APPLY'}}
        host = Mock(); host.check.return_value = {}; host.sql.side_effect = TimeoutError()
        with patch.object(d.os.path, 'lexists', return_value=False), patch.object(d, 'journal'), \
             patch.object(d, 'rollback') as rollback, self.assertRaisesRegex(d.Refused, 'rolled_back'):
            d.apply(c, host)
        rollback.assert_called_once()
        self.assertEqual(rollback.call_args.args[2]['phase'], 'sql')
        host.install_peers.assert_not_called()
        host.run.assert_not_called()

    def test_apply_will_not_start_after_peer_boundary_failure(self):
        c = {'path': Path('/private/fixture'), 'digest': 'a'*64, 'sql': {'applySql': 'APPLY'}}
        host = Mock(); host.check.return_value = {}; host.peer_probes.side_effect = d.Refused('peer_boundary_failed')
        with patch.object(d.os.path, 'lexists', return_value=False), patch.object(d, 'journal'), \
             patch.object(d, 'rollback') as rollback, self.assertRaises(d.Refused):
            d.apply(c, host)
        rollback.assert_called_once()
        host.run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
