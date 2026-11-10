"""The fresh-host installers (docs/FRESH_HOST_INSTALL.md), without host access.

What each step leaves must be what the next installer checks and what the first
VM runs: the foundation satisfies prepare_disabled.py's preflight, the
hand-written units are the first VM's bytes, and every refusal holds.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import apply_migrations
import continuous_egress_policy as policy
import egress_policy
import install_cloudflared
import install_continuous_egress
import install_host_foundation as foundation
import install_node_rpc_endpoint as endpoint
import install_queue_worker_root as queue
import install_read_activation as activation
import install_runtimes as runtimes
import prepare_disabled as install

FIRST_VM = Path(__file__).resolve().parent / 'fixtures/first-vm'
COMMIT = 'c' * 40


def normalized(text):
    return tuple(tuple(line.split()) for line in text.splitlines() if line.strip())


class Account:
    def __init__(self, uid=None, gid=None, name='domino-x'):
        self.pw_uid = os.getuid() if uid is None else uid
        self.pw_gid = os.getgid() if gid is None else gid
        self.pw_name = name


class FoundationTests(unittest.TestCase):
    def test_the_peer_files_are_the_snapshot_prepare_disabled_checks(self):
        self.assertEqual(normalized(foundation.HBA_TEXT), install.HBA)
        self.assertEqual(normalized(foundation.IDENT_TEXT), install.MAPPINGS)

    def test_the_cluster_is_utf8_c_with_checksums_and_no_tcp(self):
        command = foundation.CREATECLUSTER
        for flag in ('--port=8877', f'--socketdir={install.SOCKET}', '--start-conf=manual',
                     '--encoding=UTF8', '--locale=C', '--data-checksums', '--auth-host=reject'):
            self.assertIn(flag, command)
        self.assertEqual(command[command.index('--') - 2:command.index('--')], ['16', 'domino'])
        self.assertIn("listen_addresses = ''", foundation.CONF_TEXT)
        self.assertIn("unix_socket_group = 'domino-db'", foundation.CONF_TEXT)
        self.assertIn('unix_socket_permissions = 0770', foundation.CONF_TEXT)
        self.assertIn("ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0", foundation.CREATE_SQL)

    def test_the_public_schema_keeps_postgresql_16s_acl_until_post_install(self):
        self.assertNotIn('SCHEMA public', foundation.CREATE_SQL)
        self.assertEqual(foundation.PUBLIC_SCHEMA_ACL,
                         '{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}')

    def test_the_private_root_is_roots_alone(self):
        self.assertEqual(foundation.PRIVATE_ROOT, Path('/etc/domino'))
        with tempfile.TemporaryDirectory() as folder:
            created = Path(folder) / 'created'
            foundation.private_root(created, owner=os.getuid())
            self.assertEqual(stat.S_IMODE(created.stat().st_mode), 0o700)
            loose = Path(folder) / 'loose'
            loose.mkdir(mode=0o755)
            os.chmod(loose, 0o755)
            foundation.private_root(loose, owner=os.getuid())
            self.assertEqual(stat.S_IMODE(loose.stat().st_mode), 0o700)
            with self.assertRaisesRegex(ValueError, 'private_root_not_a_root_directory'):
                foundation.private_root(loose, owner=os.getuid() + 1)
            link = Path(folder) / 'link'
            link.symlink_to(loose)
            with self.assertRaisesRegex(ValueError, 'private_root_not_a_root_directory'):
                foundation.private_root(link, owner=os.getuid())

    def test_apply_lays_the_private_root_before_anything_else(self):
        events = []
        with patch.object(foundation.os, 'geteuid', lambda: 0), \
             patch.object(foundation, 'private_root', lambda *a, **k: events.append('private_root')), \
             patch.object(foundation.install, 'run', lambda args, **k: events.append(args[0]) or b''), \
             patch.object(foundation.install, 'exclusive_file', lambda *a, **k: None), \
             patch.object(foundation.install, 'sql', lambda *a, **k: ''), \
             patch.object(foundation, 'write_config', lambda *a, **k: None), \
             patch.object(foundation, 'verify', lambda: {'ok': True}), \
             patch.object(foundation.os, 'chmod', lambda *a: None):
            foundation.apply({'mode': 'host-foundation'})
        self.assertEqual(events[:2], ['private_root', '/usr/sbin/groupadd'])

    def preflight_with(self, *, clusters=(), groups=(), users=('domino',), paths=()):
        release = 'ID=ubuntu\nVERSION_ID="24.04"\n'
        def exists(name, kind):
            return name in (groups if kind == 'group' else users)
        with patch.object(foundation, 'clusters', lambda: list(clusters)), \
             patch.object(foundation, 'exists', exists), \
             patch.object(foundation.os.path, 'lexists', lambda path: str(path) in paths), \
             patch.object(foundation.Path, 'read_text', lambda self: release), \
             patch.object(foundation.Path, 'is_file', lambda self: True):
            return foundation.preflight()

    def test_only_a_fresh_host_is_accepted(self):
        self.assertEqual(self.preflight_with()['cluster'], '16/domino')
        refusals = (({'clusters': ['16/main']}, 'postgresql_cluster_exists'),
                    ({'groups': ['domino-db']}, 'database_group_exists'),
                    ({'users': ['domino', 'domino-read']}, 'domino_identity_exists'),
                    ({'groups': ['domino-gateway']}, 'domino_identity_exists'),
                    ({'users': []}, 'operator_account_missing'),
                    ({'paths': [str(foundation.TMPFILES)]}, 'foundation_path_exists'),
                    ({'paths': [str(foundation.DATA)]}, 'foundation_path_exists'))
        for kwargs, reason in refusals:
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, reason):
                self.preflight_with(**kwargs)

    def post_install_with(self, *, schemas='2', acl=None, rows=None, members=()):
        answers = {'domino_sessions': schemas, 'nspacl': acl or foundation.PUBLIC_SCHEMA_ACL}
        writes = []
        def sql(query, **kwargs):
            if 'pg_namespace WHERE nspname IN' in query:
                return answers['domino_sessions']
            if 'nspacl' in query:
                return foundation.HARDENED_SCHEMA_ACL if writes and writes[-1] == 'revoke' else answers['nspacl']
            if query.startswith('REVOKE'):
                writes.append('revoke')
                return ''
            return 't' if 'reload' in query else '0'
        group = type('Group', (), {'gr_mem': list(members)})
        with patch.object(foundation.os, 'geteuid', lambda: 0), \
             patch.object(foundation, 'exists', lambda name, kind: True), \
             patch.object(foundation.install, 'sql', sql), \
             patch.object(foundation.install, 'run', lambda args, **kw: writes.append(args) or b''), \
             patch.object(foundation.install, 'normalized_config',
                          lambda path: rows if rows is not None else install.MAPPINGS), \
             patch.object(foundation.grp, 'getgrnam', lambda name: group), \
             patch.object(foundation.Path, 'read_bytes', lambda self: foundation.IDENT_TEXT.encode()), \
             patch.object(foundation, 'write_config', lambda path, text, mode: writes.append(text)):
            result = foundation.post_install()
        return result, writes

    def test_post_install_adds_the_operator_then_hardens_the_public_schema(self):
        result, writes = self.post_install_with()
        self.assertEqual(result['publicSchemaAcl'], foundation.HARDENED_SCHEMA_ACL)
        ident = next(w for w in writes if isinstance(w, str) and w.startswith('domino domino-admin'))
        self.assertTrue(ident.endswith('domino domino domino_catalogue_admin\n'
                                       'domino domino domino_catalogue_writer\n'
                                       'domino domino domino_catalogue_reader\n'))
        self.assertIn(['/usr/sbin/usermod', '-a', '-G', 'domino-db', 'domino'], writes)
        self.assertEqual(writes[-1], 'revoke')

    def test_post_install_refuses_anything_but_the_installed_foundation(self):
        refusals = (({'schemas': '1'}, 'foundation_release_not_installed'),
                    ({'acl': foundation.HARDENED_SCHEMA_ACL}, 'public_schema_acl_unexpected'),
                    ({'rows': install.MAPPINGS[1:]}, 'foundation_peer_map_changed'),
                    ({'rows': (*install.MAPPINGS, ('domino', 'domino', install.ADMIN))}, 'operator_peer_rows_exist'),
                    ({'members': ['domino']}, 'operator_already_in_database_group'))
        for kwargs, reason in refusals:
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, reason):
                self.post_install_with(**kwargs)


class RuntimeTests(unittest.TestCase):
    def test_the_lock_must_hold_exact_pins(self):
        self.assertEqual(runtimes.locked(b'Foo_Bar==1.2\n# note\n\nbaz==3\n'), {'foo-bar': '1.2', 'baz': '3'})
        for bad in (b'foo>=1\n', b'foo\n', b''):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                runtimes.locked(bad)
        # A marker or option splits cleanly on '==' and must still be refused.
        for bad in (b'foo==1 ; python_version > "3"\n', b'foo==1 --hash=sha256:00\n'):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, 'lock_must_contain_exact_pins'):
                runtimes.locked(bad)

    def test_the_uv_archive_must_be_the_pinned_release(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'uv.tar.gz'
            path.write_bytes(b'not uv')
            with self.assertRaisesRegex(ValueError, 'uv_archive_sha256_mismatch'):
                runtimes.uv_binary(path)
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
                member = tarfile.TarInfo('uv-x86_64-unknown-linux-gnu/uv')
                member.size = 3
                archive.addfile(member, io.BytesIO(b'bin'))
            path.write_bytes(buffer.getvalue())
            with patch.object(runtimes, 'UV_SHA256', hashlib.sha256(buffer.getvalue()).hexdigest()):
                self.assertEqual(runtimes.uv_binary(path), b'bin')

    def test_each_environment_holds_exactly_the_lock(self):
        pins = {'foo': '1'}
        installed = {'foo': '1', 'pip': '26.2.1'}
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            return json.dumps(installed).encode() if '-c' in args else b''
        with patch.object(runtimes.install, 'run', run):
            self.assertEqual(runtimes.check_venv(Path('/v'), pins, ('pip==26.2.1',)), 2)
            self.assertIn(['/v/bin/python3.14', '-I', '-B', '-m', 'pip', 'check'], calls)
            with self.assertRaisesRegex(ValueError, 'venv_distributions_differ_from_lock'):
                runtimes.check_venv(Path('/v'), pins, ())

    def test_the_shared_environment_gets_the_first_vm_pip(self):
        self.assertEqual(runtimes.VENVS[install.VENV], ('pip==26.2.1',))
        self.assertEqual(runtimes.VENVS[install.BASE / 'queue-worker/venv'], ())
        self.assertEqual(runtimes.INTERPRETER,
                         Path('/opt/domino/python/cpython-3.14.7-linux-x86_64-gnu/bin/python3.14'))
        self.assertNotIn('UV_PYTHON_INSTALL_DIR', runtimes.environment(Path('/c')))

    def test_a_group_writable_runtime_tree_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'lib').mkdir(mode=0o755)
            os.chmod(root, 0o755)
            with patch.object(runtimes.os, 'lstat', lambda path: os.stat_result(
                    (stat.S_IFDIR | 0o755, 0, 0, 0, 0, 0, 0, 0, 0, 0))):
                runtimes.trusted_tree(root)
            with patch.object(runtimes.os, 'lstat', lambda path: os.stat_result(
                    (stat.S_IFDIR | 0o775, 0, 0, 0, 0, 0, 0, 0, 0, 0))), \
                 self.assertRaisesRegex(ValueError, 'runtime_tree_not_root_owned'):
                runtimes.trusted_tree(root)


class MigrationTests(unittest.TestCase):
    def test_each_migration_runs_as_the_identity_the_first_vm_used(self):
        admin = {name for name, who in apply_migrations.HAND_APPLIED.items() if who == apply_migrations.ADMIN}
        # 053, 056 and 060 are no first-VM migrations: the catalogue owner owns domino_activity, events and
        # chunks included, which 053 and 060 index and to which 056 adds the activity follower's mint-scan
        # checkpoint.
        self.assertEqual(admin, {'020_pool_requests', '021_reference_price_sources',
                                 '022_event_timestamp_source', '023_pool_request_scheduling',
                                 '053_activity_chunk_index', '056_position_mint_scan', '060_chunk_end_index'})
        self.assertTrue(all(who == apply_migrations.POSTGRES for name, who in apply_migrations.HAND_APPLIED.items()
                            if name not in admin))
        for name in apply_migrations.HAND_APPLIED:
            self.assertTrue((Path(__file__).resolve().parents[3] / f'backend/migrations/{name}.sql').is_file(), name)

    def test_only_known_migrations_in_order_once(self):
        self.assertEqual(apply_migrations.selected('020_pool_requests,027_remove_wallet_access_gate'),
                         ['020_pool_requests', '027_remove_wallet_access_gate'])
        # A fresh host applies 061, the entities' keep-warm index, after 060, and 062, the collector's
        # scheduled cadence, after 061; as postgres, as the test above holds every migration outside its
        # catalogue-owner set.
        self.assertEqual(apply_migrations.selected('060_chunk_end_index,061_public_entities_keep_warm,'
                                                   '062_public_claim_cadence'),
                         ['060_chunk_end_index', '061_public_entities_keep_warm', '062_public_claim_cadence'])
        for bad, reason in (('028_automation_cycle', 'migration_not_hand_applied'),
                            ('027_remove_wallet_access_gate,020_pool_requests', 'migrations_out_of_order'),
                            ('020_pool_requests,020_pool_requests', 'migration_list_invalid'),
                            ('', 'migration_list_invalid')):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, reason):
                apply_migrations.selected(bad)

    def test_apply_receipts_each_migration_and_refuses_a_second_time(self):
        files = {'backend/migrations/020_pool_requests.sql': (b'SELECT 1;\n', False)}
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(apply_migrations, 'RECEIPTS', Path(folder) / 'receipts'), \
             patch.object(apply_migrations.install, 'trusted_parents', lambda path: None), \
             patch.object(apply_migrations.os, 'geteuid', lambda: 0):
            planned = apply_migrations.plan(files, COMMIT, 'd' * 64, ['020_pool_requests'])
            calls = []
            with patch.object(apply_migrations.install, 'run', lambda args, data=None: calls.append((args, data)) or b''), \
                 patch.object(apply_migrations.install, 'exclusive_file',
                              lambda path, content, mode=0o600, uid=0, gid=0: Path(path).write_bytes(content)):
                apply_migrations.apply(files, planned)
            (args, data), = calls
            self.assertEqual(args[:3], ['/usr/sbin/runuser', '-u', 'domino-admin'])
            self.assertIn('--single-transaction', args)
            self.assertEqual(args[args.index('-U') + 1], install.ADMIN)
            self.assertEqual(data, b'SELECT 1;\n')
            with self.assertRaisesRegex(ValueError, 'migration_already_applied'):
                apply_migrations.plan(files, COMMIT, 'd' * 64, ['020_pool_requests'])


class QueueWorkerTests(unittest.TestCase):
    def test_the_base_units_are_the_first_vm_bytes(self):
        for name, text in queue.UNITS.items():
            with self.subTest(unit=name):
                self.assertEqual(text, (FIRST_VM / name).read_text())

    def test_only_a_host_without_the_root_or_its_units_is_accepted(self):
        files = {queue.LOCK: (b'foo==1\n', False)}
        def plan(existing=(), interpreter=True):
            with patch.object(queue.os.path, 'lexists', lambda path: str(path) in existing), \
                 patch.object(queue.Path, 'exists', lambda self: interpreter), \
                 patch.object(queue.pwd, 'getpwnam', lambda name: Account()):
                return queue.plan(files, COMMIT, 'd' * 64)
        self.assertEqual(plan()['units'], sorted(queue.UNITS))
        for kwargs, reason in (({'interpreter': False}, 'writer_interpreter_missing'),
                               ({'existing': [str(queue.QUEUE / 'release')]}, 'queue_worker_release_exists'),
                               ({'existing': [str(install.UNIT_DIR / 'domino-queue-worker.timer')]},
                                'queue_worker_unit_exists')):
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, reason):
                plan(**kwargs)
        with self.assertRaisesRegex(ValueError, 'lock_missing_from_archive'):
            queue.plan({}, COMMIT, 'd' * 64)

    def test_the_runtime_descriptor_names_the_private_socket(self):
        self.assertEqual(json.loads(queue.DESCRIPTOR),
                         {'host': '/run/postgresql-domino', 'port': 8877, 'dbname': 'domino_catalogue'})


class ReadActivationTests(unittest.TestCase):
    def test_the_drop_ins_are_the_live_profile(self):
        read = activation.drop_in('read', COMMIT, Path('/runtime/read'))
        gateway = activation.drop_in('gateway', COMMIT, Path('/runtime/gateway'))
        self.assertIn(f'WorkingDirectory=/opt/domino/releases/{COMMIT}/read\n', read)
        self.assertIn(f'ExecStart=\nExecStart=/opt/domino/releases/{COMMIT}/read/backend/.venv/bin/python3.14 -B '
                      'backend/read_api.py --port 8876 --read-budget 15\n', read)
        self.assertIn('ReadWritePaths=\nReadWritePaths=/runtime/read\n', read)
        self.assertIn('Environment=DOMINO_PUBLIC_DATA=1\n', read)
        self.assertIn('--enable --enable-v2 --enable-v3 --enable-v4 --enable-v5\n', gateway)
        for value in ('DOMINO_BRIDGE_V2_READS=pool-market', 'DOMINO_BRIDGE_V3_READS=overview,history,search',
                      'DOMINO_BRIDGE_V4_READS=sequence-snapshot', 'DOMINO_BRIDGE_V5_READS=featured-pools'):
            self.assertIn(f'Environment={value}\n', gateway)

    def test_the_v2_reads_are_opt_in_and_only_add_to_the_live_profile(self):
        for component in activation.DROP_INS:
            live = activation.drop_in(component, COMMIT, Path(f'/runtime/{component}'))
            self.assertEqual(live, activation.drop_in(component, COMMIT, Path(f'/runtime/{component}'), False))
            self.assertNotIn('v6', live.lower())
            self.assertNotIn('DOMINO_V2_READ', live)
        read = activation.drop_in('read', COMMIT, Path('/runtime/read'), read_v6=True)
        gateway = activation.drop_in('gateway', COMMIT, Path('/runtime/gateway'), read_v6=True)
        self.assertIn('backend/read_api.py --port 8876 --read-budget 15\n', read)
        self.assertIn('Environment=DOMINO_PUBLIC_DATA=1\nEnvironment=DOMINO_V2_READ=1\n', read)
        self.assertIn('--enable --enable-v2 --enable-v3 --enable-v4 --enable-v5 --enable-v6\n', gateway)
        self.assertIn('Environment=DOMINO_BRIDGE_V5_READS=featured-pools\n'
                      'Environment=DOMINO_BRIDGE_V6_READS=portfolio,activity\n', gateway)
        self.assertEqual(read.count('Environment='), 2)
        self.assertEqual(gateway.count('Environment='), 5)

    def test_the_chain_reads_are_opt_in_on_top_of_the_v2_reads(self):
        with self.assertRaises(ValueError):
            activation.drop_in('read', COMMIT, Path('/runtime/read'), read_v6=False, chain_reads=True)
        read = activation.drop_in('read', COMMIT, Path('/runtime/read'), read_v6=True, chain_reads=True)
        gateway = activation.drop_in('gateway', COMMIT, Path('/runtime/gateway'), read_v6=True, chain_reads=True)
        # The file outside every release (its loader refuses one inside a release tree), bound where the reader
        # reaches it; a missing directory leaves the reader up.
        self.assertIn('Environment=DOMINO_V2_READ=1\nEnvironment=DOMINO_V2_CHAIN_READS=1\n'
                      'Environment=DOMINO_V2_CHAIN_RPC_FILE=/run/domino-read-config/chain-rpc.json\n'
                      'ImportCredential=v2-rpc-*\nDeviceAllow=char-tpm rw\n'
                      'BindReadOnlyPaths=-/etc/domino/read:/run/domino-read-config\n', read)
        self.assertNotIn('/runtime/read/chain-rpc.json', read)
        self.assertIn('Environment=DOMINO_BRIDGE_V6_READS=portfolio,activity,chain-pools,chain-balances,chain-tokens\n', gateway)
        self.assertNotIn('ImportCredential', gateway)
        self.assertEqual(gateway.count('Environment='), 5)
        # Without them, the v2 reads' drop-ins are exactly what they were.
        self.assertEqual(activation.drop_in('read', COMMIT, Path('/runtime/read'), read_v6=True),
                         activation.drop_in('read', COMMIT, Path('/runtime/read'), read_v6=True, chain_reads=False))
        self.assertNotIn('chain', activation.drop_in('gateway', COMMIT, Path('/runtime/gateway'), read_v6=True))

    def test_the_balance_chains_are_opt_in_on_top_of_the_chain_reads(self):
        with self.assertRaisesRegex(ValueError, 'balance_chains_need_chain_reads'):
            activation.drop_in('read', COMMIT, Path('/runtime/read'), read_v6=True, balance_chains=True)
        read = activation.drop_in('read', COMMIT, Path('/runtime/read'), read_v6=True, chain_reads=True,
                                  balance_chains=True)
        # Ethereum's and OP Mainnet's file beside the chain RPC file, in the same bound directory; their sealed URLs
        # are v2-rpc-* credentials the reader already imports.
        self.assertIn('Environment=DOMINO_V2_CHAIN_RPC_FILE=/run/domino-read-config/chain-rpc.json\n'
                      'Environment=DOMINO_V2_BALANCE_CHAIN_RPC_FILE=/run/domino-read-config/balance-chain-rpc.json\n'
                      'ImportCredential=v2-rpc-*\nDeviceAllow=char-tpm rw\n'
                      'BindReadOnlyPaths=-/etc/domino/read:/run/domino-read-config\n', read)
        self.assertEqual(read.count('ImportCredential='), 1)
        # The gateway already serves chain-balances; without the option, the chain reads' drop-ins are what they were.
        for component in activation.DROP_INS:
            runtime = Path(f'/runtime/{component}')
            chain_reads = activation.drop_in(component, COMMIT, runtime, read_v6=True, chain_reads=True)
            self.assertEqual(chain_reads, activation.drop_in(component, COMMIT, runtime, read_v6=True, chain_reads=True,
                                                             balance_chains=False))
            self.assertNotIn('BALANCE', chain_reads)
        self.assertEqual(activation.drop_in('gateway', COMMIT, Path('/runtime/gateway'), read_v6=True, chain_reads=True),
                         activation.drop_in('gateway', COMMIT, Path('/runtime/gateway'), read_v6=True, chain_reads=True,
                                            balance_chains=True))

    def test_position_fees_is_opt_in_on_top_of_the_chain_reads(self):
        # 7 Nov 2026 (the owner's approval; docs/v2/V2_FEES.md): read-v6 1.2.0-rc.1's position-fees, named last.
        for component in activation.DROP_INS:
            for read_v6 in (False, True):
                with self.assertRaisesRegex(ValueError, 'position_fees_need_chain_reads'):
                    activation.drop_in(component, COMMIT, Path(f'/runtime/{component}'), read_v6=read_v6,
                                       position_fees=True)
        chain_reads = activation.drop_in('gateway', COMMIT, Path('/runtime/gateway'), read_v6=True, chain_reads=True)
        gateway = activation.drop_in('gateway', COMMIT, Path('/runtime/gateway'), read_v6=True, chain_reads=True,
                                     position_fees=True)
        self.assertIn('--enable --enable-v2 --enable-v3 --enable-v4 --enable-v5 --enable-v6\n', gateway)
        self.assertIn('Environment=DOMINO_BRIDGE_V5_READS=featured-pools\nEnvironment=DOMINO_BRIDGE_V6_READS='
                      'portfolio,activity,chain-pools,chain-balances,chain-tokens,position-fees\n', gateway)
        self.assertEqual((gateway.count('Environment='), gateway.count('DOMINO_BRIDGE_V6_READS='),
                          gateway.count('position-fees')), (5, 1, 1))
        # Only the gateway's list moves; the balance chains change nothing there.
        self.assertEqual(gateway, chain_reads.replace(',chain-tokens\n', ',chain-tokens,position-fees\n'))
        self.assertEqual(gateway, activation.drop_in('gateway', COMMIT, Path('/runtime/gateway'), read_v6=True,
                                                     chain_reads=True, balance_chains=True, position_fees=True))
        # The reader already serves it with DOMINO_V2_READ=1: its drop-in is byte for byte what it was.
        for balance_chains in (False, True):
            self.assertEqual(activation.drop_in('read', COMMIT, Path('/runtime/read'), read_v6=True, chain_reads=True,
                                                balance_chains=balance_chains, position_fees=True),
                             activation.drop_in('read', COMMIT, Path('/runtime/read'), read_v6=True, chain_reads=True,
                                                balance_chains=balance_chains))
        # Without the option, the chain reads' drop-ins are what they were: the route stays closed at the gateway.
        for component in activation.DROP_INS:
            runtime = Path(f'/runtime/{component}')
            for balance_chains in (False, True):
                live = activation.drop_in(component, COMMIT, runtime, read_v6=True, chain_reads=True,
                                          balance_chains=balance_chains)
                self.assertEqual(live, activation.drop_in(component, COMMIT, runtime, read_v6=True, chain_reads=True,
                                                          balance_chains=balance_chains, position_fees=False))
                self.assertNotIn('position-fees', live)

    def test_the_balance_chains_wait_for_their_private_file(self):
        with tempfile.TemporaryDirectory() as folder:
            private = Path(folder)
            (private / 'chain-rpc.json').write_text('{}')
            arguments = ['--commit', COMMIT, '--read-v6', '--chain-reads', '--balance-chains', '--inspect']
            with patch.object(activation, 'CHAIN_RPC_DIRECTORY', private):
                with self.assertRaisesRegex(ValueError, 'balance_chain_rpc_file_missing'):
                    activation.plan(COMMIT, read_v6=True, chain_reads=True, balance_chains=True)
                with patch('sys.stdout', new_callable=io.StringIO) as printed:
                    self.assertEqual(activation.main(arguments), 1)
                self.assertEqual(json.loads(printed.getvalue())['reason'], 'balance_chain_rpc_file_missing')
                (private / 'balance-chain-rpc.json').write_text('{}')
                # Past that check, the plan goes on to the release (none here).
                with self.assertRaisesRegex(ValueError, 'read_release_not_installed'):
                    activation.plan(COMMIT, read_v6=True, chain_reads=True, balance_chains=True)

    def test_the_chain_reads_wait_for_the_private_file(self):
        with tempfile.TemporaryDirectory() as folder:
            private = Path(folder)
            with patch.object(activation, 'CHAIN_RPC_DIRECTORY', private):
                with self.assertRaisesRegex(ValueError, 'chain_rpc_file_missing'):
                    activation.plan(COMMIT, read_v6=True, chain_reads=True)
                (private / 'chain-rpc.json').write_text('{}')
                # Past that check, the plan goes on to the release (none here).
                with self.assertRaisesRegex(ValueError, 'read_release_not_installed'):
                    activation.plan(COMMIT, read_v6=True, chain_reads=True)

    def test_the_release_must_be_installed_with_its_links(self):
        with tempfile.TemporaryDirectory() as folder:
            releases, units = Path(folder) / 'releases', Path(folder) / 'units'
            units.mkdir()
            for component in activation.DROP_INS:
                (units / f'domino-{component}.service').write_text('[Service]\n')
                backend = releases / COMMIT / component / 'backend'
                backend.mkdir(parents=True)
                (backend / '.venv').symlink_to(folder)
                runtime = Path(folder) / 'runtime' / component
                runtime.mkdir(parents=True)
                (backend / 'runtime').symlink_to(runtime)
            with patch.object(activation, 'RELEASES', releases), patch.object(activation.install, 'UNIT_DIR', units):
                planned = activation.plan(COMMIT)
                self.assertEqual(len(planned['dropIns']), 2)
                (releases / COMMIT / 'gateway/backend/runtime').unlink()
                with self.assertRaisesRegex(ValueError, 'read_release_not_installed'):
                    activation.plan(COMMIT)
                (releases / COMMIT / 'gateway/backend/runtime').symlink_to(Path(folder) / 'gone')
                with self.assertRaisesRegex(ValueError, 'read_runtime_missing'):
                    activation.plan(COMMIT)
                (releases / COMMIT / 'gateway/backend/runtime').unlink()
                (releases / COMMIT / 'gateway/backend/runtime').symlink_to(Path(folder) / 'runtime/gateway')
                (units / 'domino-read.service.d').mkdir()
                (units / 'domino-read.service.d' / activation.DROP_INS['read']).write_text('')
                with self.assertRaisesRegex(ValueError, 'read_activation_exists'):
                    activation.plan(COMMIT)

    def test_the_cli_takes_position_fees_into_the_plan(self):
        with tempfile.TemporaryDirectory() as folder:
            releases, units, private = Path(folder) / 'releases', Path(folder) / 'units', Path(folder) / 'private'
            units.mkdir()
            private.mkdir()
            for name in (activation.CHAIN_RPC_FILE, activation.BALANCE_CHAIN_RPC_FILE):
                (private / name).write_text('{}')
            for component in activation.DROP_INS:
                (units / f'domino-{component}.service').write_text('[Service]\n')
                backend = releases / COMMIT / component / 'backend'
                backend.mkdir(parents=True)
                (backend / '.venv').symlink_to(folder)
                runtime = Path(folder) / 'runtime' / component
                runtime.mkdir(parents=True)
                (backend / 'runtime').symlink_to(runtime)

            def inspect(*flags):
                with patch('sys.stdout', new_callable=io.StringIO) as printed:
                    code = activation.main(['--commit', COMMIT, *flags, '--inspect'])
                return code, json.loads(printed.getvalue())

            reader = str(units / 'domino-read.service.d' / activation.DROP_INS['read'])
            gateway = str(units / 'domino-gateway.service.d' / activation.DROP_INS['gateway'])
            with patch.object(activation, 'RELEASES', releases), patch.object(activation.install, 'UNIT_DIR', units), \
                    patch.object(activation, 'CHAIN_RPC_DIRECTORY', private):
                # Production's flags today, then with the route: the gateway's list gains it, the reader's drop-in
                # does not move, and the receipt says so.
                code, live = inspect('--read-v6', '--chain-reads', '--balance-chains')
                self.assertEqual((code, live['ok'], live['applied'], live['positionFees']), (0, True, False, False))
                code, fees = inspect('--read-v6', '--chain-reads', '--balance-chains', '--position-fees')
                self.assertEqual((code, fees['ok'], fees['applied'], fees['positionFees']), (0, True, False, True))
                self.assertEqual(sorted(fees['dropIns']), sorted([reader, gateway]))
                self.assertEqual(fees['dropIns'][reader], live['dropIns'][reader])
                self.assertIn('Environment=DOMINO_BRIDGE_V6_READS=portfolio,activity,chain-pools,chain-balances,'
                              'chain-tokens,position-fees\n', fees['dropIns'][gateway])
                self.assertEqual(fees['dropIns'][gateway],
                                 live['dropIns'][gateway].replace(',chain-tokens\n', ',chain-tokens,position-fees\n'))
                self.assertNotIn('position-fees', json.dumps(live))
                self.assertEqual({key: value for key, value in fees.items() if key not in ('positionFees', 'dropIns')},
                                 {key: value for key, value in live.items() if key not in ('positionFees', 'dropIns')})
                # Without the chain reads it is refused, with its reason, and nothing is planned.
                for flags in (('--position-fees',), ('--read-v6', '--position-fees')):
                    self.assertEqual(inspect(*flags), (1, {'ok': False, 'reason': 'position_fees_need_chain_reads',
                                                          'action': 'no drop-in written'}), flags)


class CloudflaredTests(unittest.TestCase):
    def test_the_transport_drop_in_is_the_first_vm_bytes_from_the_official_inventory(self):
        self.assertEqual(install_cloudflared.transport_drop_in(),
                         (FIRST_VM / 'domino-tunnel-40-connector-transport.conf').read_text())
        allowed = {line.split('=', 1)[1][:-3] for line in install_cloudflared.transport_drop_in().splitlines()
                   if line.startswith('IPAddressAllow=') and line.endswith('/32')}
        edges = set().union(*egress_policy.EDGE_ADDRESSES.values())
        self.assertEqual(allowed, edges | {'127.0.0.1', '127.0.0.53'})

    def test_the_sealed_token_replaces_the_plain_one_under_the_same_id(self):
        self.assertEqual(install_cloudflared.SEALED_TEXT,
                         '[Service]\nLoadCredential=\n'
                         'LoadCredentialEncrypted=cloudflared-token:/etc/domino/credentials/cloudflared-token.cred\n')
        base = (install_cloudflared.SOURCES / 'domino-tunnel.service').read_text()
        self.assertIn('LoadCredential=cloudflared-token:/etc/domino/credentials/cloudflared-token\n', base)

    def test_apply_writes_the_sealed_drop_in_only_when_asked(self):
        written = {}
        planned = {'binary': '/opt/domino/cloudflared/2026.9.0/cloudflared', 'sha256': 'f' * 64}
        def exclusive(path, content, mode=0o600, uid=0, gid=0):
            written[str(path)] = content
        for sealed in (False, True):
            written.clear()
            with patch.object(install_cloudflared.os, 'geteuid', lambda: 0), \
                 patch.object(install_cloudflared.install, 'trusted_parents', lambda path: None), \
                 patch.object(install_cloudflared.install, 'exclusive_file', exclusive), \
                 patch.object(install_cloudflared.install, 'run', lambda args, **kw: b''), \
                 patch.object(install_cloudflared.Path, 'mkdir', lambda self, **kw: None), \
                 patch.object(install_cloudflared.os, 'chmod', lambda path, mode: None), \
                 patch.object(install_cloudflared.Path, 'read_bytes', lambda self: b'x'), \
                 patch.object(install_cloudflared.hashlib, 'sha256', lambda data: type('H', (), {'hexdigest': lambda self: 'f' * 64})()):
                install_cloudflared.apply('/bin', {**planned, 'sealedToken': str(install_cloudflared.SEALED_TOKEN) if sealed else None})
            self.assertEqual(str(install_cloudflared.SEALED_DROP_IN) in written, sealed)
            if sealed:
                self.assertEqual(written[str(install_cloudflared.SEALED_DROP_IN)], install_cloudflared.SEALED_TEXT.encode())

    def test_only_the_manifest_asset_is_installed(self):
        manifest = json.loads((install_cloudflared.SOURCES / 'release.json').read_text())
        with tempfile.TemporaryDirectory() as folder:
            binary = Path(folder) / 'cloudflared'
            binary.write_bytes(b'x' * 10)
            with patch.object(install_cloudflared.platform, 'machine', lambda: 'x86_64'), \
                 self.assertRaisesRegex(ValueError, 'cloudflared_asset_mismatch'):
                install_cloudflared.plan(binary)
            with patch.object(install_cloudflared.platform, 'machine', lambda: 'aarch64'), \
                 self.assertRaisesRegex(ValueError, 'platform_mismatch'):
                install_cloudflared.plan(binary)
        self.assertEqual(manifest['platform'], 'linux-amd64')


class ContinuousEgressTests(unittest.TestCase):
    def test_the_egress_service_is_the_first_vm_bytes(self):
        self.assertEqual(install_continuous_egress.EGRESS_SERVICE_TEXT,
                         (FIRST_VM / 'domino-continuous-egress.service').read_text())

    def test_the_hosts_collected_are_the_enabled_classes(self):
        needed = install_continuous_egress.needed_hosts(['read', 'gateway', 'tunnel', 'write'], 'team.cloudflareaccess.com', True)
        self.assertEqual(set(needed), set(policy.RPC_HOSTS) | set(policy.ANALYTICS_HOSTS) | set(policy.EDGE_HOSTS)
                         | {'team.cloudflareaccess.com'})
        self.assertFalse(set(needed) & set(policy.UNISWAP_HOSTS))

    def test_the_v2_chains_hosts_are_collected_only_when_asked(self):
        live = ['read', 'gateway', 'tunnel', 'write']
        without = install_continuous_egress.needed_hosts(live, 'team.cloudflareaccess.com', True)
        self.assertFalse(set(without) & set(policy.CHAIN_HOSTS))
        granted = install_continuous_egress.needed_hosts(live, 'team.cloudflareaccess.com', True, chains=True)
        self.assertEqual(set(granted), set(without) | set(policy.CHAIN_HOSTS))

    def test_the_balance_chains_hosts_are_collected_only_when_asked(self):
        live = ['read', 'gateway', 'tunnel', 'write']
        without = install_continuous_egress.needed_hosts(live, 'team.cloudflareaccess.com', True, chains=True)
        self.assertFalse(set(without) & set(policy.BALANCE_CHAIN_HOSTS))
        granted = install_continuous_egress.needed_hosts(live, 'team.cloudflareaccess.com', True, chains=True,
                                                         balance_chains=True)
        self.assertEqual(set(granted), set(without) | set(policy.BALANCE_CHAIN_HOSTS))

    def test_collect_names_the_balance_chains_only_when_asked_and_for_the_reader(self):
        def identity(role):
            unit = policy.unit_of(role)
            uid = 2000 + policy.ROLES.index(role)
            return {'user': 'domino-' + role, 'realUid': uid, 'effectiveUid': uid, 'gid': uid,
                    'supplementaryGids': [], 'unit': unit, 'cgroup': unit and '/system.slice/' + unit}
        known = sorted(policy.RPC_HOSTS | policy.ANALYTICS_HOSTS | policy.CHAIN_HOSTS | policy.BALANCE_CHAIN_HOSTS)

        def resolve(hostname):
            if hostname in egress_policy.EDGE_ADDRESSES:
                return sorted(egress_policy.EDGE_ADDRESSES[hostname])[:1]
            return ['16.0.0.%d' % (1 + known.index(hostname)) if hostname != 'team.cloudflareaccess.com' else '16.0.0.99']
        with patch.object(install_continuous_egress, 'identity', identity), \
             patch.object(install_continuous_egress, 'resolve', resolve):
            arguments = ['--collect', '--access-issuer', 'team.cloudflareaccess.com', '--public-data-collectors',
                         '--v2-chains']
            for extra, expected in (([], None), (['--balance-chains'], True)):
                with self.subTest(extra=extra), patch('sys.stdout', new_callable=io.StringIO) as printed:
                    self.assertEqual(install_continuous_egress.main(
                        [*arguments, '--enabled', 'read,gateway,tunnel,write', *extra]), 0)
                    snapshot = json.loads(printed.getvalue())
                    self.assertEqual(snapshot.get('balanceChains'), expected)
                    pinned = {item['hostname'] for item in snapshot['hosts']}
                    self.assertEqual(pinned & policy.BALANCE_CHAIN_HOSTS, policy.BALANCE_CHAIN_HOSTS if expected else set())
                    rendered = policy.render(snapshot)['artifacts']
                    self.assertEqual('ethereum-mainnet.core.chainstack.com' in rendered[policy.ROOT + '/read.hosts'],
                                     bool(expected))
                    self.assertNotIn('ethereum-mainnet.core.chainstack.com', rendered[policy.ROOT + '/write.hosts'])
            with patch('sys.stdout', new_callable=io.StringIO) as printed:
                self.assertEqual(install_continuous_egress.main(
                    [*arguments, '--enabled', 'gateway,tunnel,write', '--balance-chains']), 1)
            self.assertEqual(json.loads(printed.getvalue())['reason'], 'balance_chains_require_the_reader')

    def test_the_bridge_hosts_are_collected_for_the_crosschain_listener_alone(self):
        live = ['read', 'gateway', 'tunnel', 'write']
        without = install_continuous_egress.needed_hosts(live, 'team.cloudflareaccess.com', True)
        self.assertFalse(set(without) & set(policy.BRIDGE_HOSTS))
        bridged = install_continuous_egress.needed_hosts([*live, 'crosschain'], 'team.cloudflareaccess.com', True)
        self.assertEqual(set(bridged), set(without) | {'api.relay.link', 'app.across.to'})

    def test_the_telegram_host_is_collected_for_the_monitor_alone(self):
        live = ['read', 'gateway', 'tunnel', 'write']
        without = install_continuous_egress.needed_hosts(live, 'team.cloudflareaccess.com', True)
        self.assertNotIn('api.telegram.org', without)
        watched = install_continuous_egress.needed_hosts([*live, 'monitor'], 'team.cloudflareaccess.com', True)
        self.assertEqual(set(watched), set(without) | {'api.telegram.org'})

    def test_collect_names_the_node_loopback_reads_only_when_asked(self):
        def identity(role):
            unit = policy.unit_of(role)
            uid = 2000 + policy.ROLES.index(role)
            return {'user': 'domino-' + role, 'realUid': uid, 'effectiveUid': uid, 'gid': uid,
                    'supplementaryGids': [], 'unit': unit, 'cgroup': unit and '/system.slice/' + unit}
        def resolve(hostname):
            if hostname in egress_policy.EDGE_ADDRESSES:
                return sorted(egress_policy.EDGE_ADDRESSES[hostname])[:1]
            return ['16.0.0.%d' % (1 + sorted(policy.RPC_HOSTS | policy.ANALYTICS_HOSTS | policy.CHAIN_HOSTS)
                                   .index(hostname))
                    if hostname != 'team.cloudflareaccess.com' else '16.0.0.99']
        with patch.object(install_continuous_egress, 'identity', identity), \
             patch.object(install_continuous_egress, 'resolve', resolve):
            arguments = ['--collect', '--access-issuer', 'team.cloudflareaccess.com',
                         '--enabled', 'read,gateway,tunnel,write', '--public-data-collectors']
            for extra, expected in (([], None), (['--node-loopback-reads'], True)):
                with self.subTest(extra=extra), patch('sys.stdout', new_callable=io.StringIO) as printed:
                    self.assertEqual(install_continuous_egress.main(arguments + extra), 0)
                    snapshot = json.loads(printed.getvalue())
                    self.assertEqual(snapshot.get('nodeLoopbackReads'), expected)
                    text = policy.render(snapshot)['artifacts'][policy.ROOT + '/policy.nft']
                    self.assertEqual('tcp dport 18547' in text, bool(expected))
            for extra, expected in (([], None), (['--v2-chains'], True)):
                with self.subTest(extra=extra), patch('sys.stdout', new_callable=io.StringIO) as printed:
                    self.assertEqual(install_continuous_egress.main(arguments + extra), 0)
                    snapshot = json.loads(printed.getvalue())
                    self.assertEqual(snapshot.get('v2Chains'), expected)
                    pinned = {item['hostname'] for item in snapshot['hosts']}
                    self.assertEqual(bool(pinned & policy.CHAIN_HOSTS), bool(expected))
                    hosts = policy.render(snapshot)['artifacts'][policy.ROOT + '/write.hosts']
                    self.assertEqual('base-mainnet.core.chainstack.com' in hosts, bool(expected))

    def test_edge_answers_outside_the_official_inventory_are_dropped(self):
        name = 'region1.v2.argotunnel.com'
        inside = sorted(egress_policy.EDGE_ADDRESSES[name])[0]
        answers = [(None, None, None, None, (inside, 443)), (None, None, None, None, ('203.0.113.9', 443))]
        with patch.object(install_continuous_egress.socket, 'getaddrinfo', lambda *a, **k: answers):
            self.assertEqual(install_continuous_egress.resolve(name), [inside])
        with patch.object(install_continuous_egress.socket, 'getaddrinfo', lambda *a, **k: answers[1:]), \
             self.assertRaisesRegex(ValueError, 'host_did_not_resolve'):
            install_continuous_egress.resolve(name)

    def candidate(self, **override):
        artifacts = {policy.ROOT + '/policy.nft': 'table\n',
                     policy.UNIT_DIR + 'domino-read.service.d/' + policy.DROPIN: '[Unit]\n',
                     policy.UNIT_DIR + policy.TARGET: '[Unit]\n'}
        metadata = {path: {'uid': 0, 'gid': 0, 'mode': 0o600 if path.endswith('.nft') else 0o644} for path in artifacts}
        result = {'kind': 'domino-continuous-egress-v1', 'version': 1, 'applied': False, 'enabled': ['read'],
                  'pinSetSha256': 'e' * 64, 'artifacts': artifacts, 'artifactMetadata': metadata,
                  'artifactSha256': {p: hashlib.sha256(t.encode()).hexdigest() for p, t in artifacts.items()}}
        result.update(override)
        return result

    def test_a_candidate_writes_only_reviewed_paths_with_reviewed_modes(self):
        with patch.object(install_continuous_egress.os.path, 'lexists', lambda path: False):
            self.assertEqual(len(install_continuous_egress.plan(self.candidate())['artifacts']), 4)
            tampered = self.candidate()
            tampered['artifacts'][policy.ROOT + '/policy.nft'] = 'flush ruleset\n'
            with self.assertRaisesRegex(ValueError, 'candidate_artifact_changed'):
                install_continuous_egress.plan(tampered)
            elsewhere = self.candidate()
            for field in ('artifacts', 'artifactMetadata', 'artifactSha256'):
                elsewhere[field]['/etc/sudoers.d/x'] = elsewhere[field].pop(policy.ROOT + '/policy.nft')
            with self.assertRaisesRegex(ValueError, 'candidate_path_not_allowed'):
                install_continuous_egress.plan(elsewhere)
            loose = self.candidate()
            loose['artifactMetadata'][policy.ROOT + '/policy.nft']['mode'] = 0o666
            with self.assertRaisesRegex(ValueError, 'candidate_metadata_unexpected'):
                install_continuous_egress.plan(loose)
            with self.assertRaisesRegex(ValueError, 'not_a_continuous_egress_candidate'):
                install_continuous_egress.plan(self.candidate(applied=True))
        with patch.object(install_continuous_egress.os.path, 'lexists', lambda path: True), \
             self.assertRaisesRegex(ValueError, 'egress_artifact_exists'):
            install_continuous_egress.plan(self.candidate())
        for path in ('/etc/domino/continuous-reads/sub/x', '/etc/systemd/system/sshd.service.d/60-continuous-reads.conf'):
            self.assertFalse(install_continuous_egress.allowed(path), path)


class NodeEndpointTests(unittest.TestCase):
    KEY = 'ssh-ed25519 ' + 'A' * 68

    def test_the_tunnel_key_may_only_forward_one_port_from_the_peer(self):
        texts = endpoint.rendered('192.0.2.1', self.KEY, 18549)
        self.assertEqual(texts['keys'], 'from="192.0.2.1",restrict,port-forwarding,'
                                        f'permitlisten="127.0.0.1:18548" {self.KEY} domino-rpc-tunnel\n')
        for line in ('AllowUsers domino-rpc-tunnel@192.0.2.1', 'Match User domino-rpc-tunnel Address 192.0.2.1',
                     '    AllowTcpForwarding remote', '    PermitListen 127.0.0.1:18548', '    PermitTTY no',
                     '    MaxSessions 0', endpoint.END):
            self.assertIn(line + '\n', texts['sshd'])

    def test_the_proxy_prefers_the_direct_path_and_hides_its_own_errors(self):
        config = endpoint.rendered('192.0.2.1', self.KEY, 18549)['haproxy']
        self.assertIn('    bind 127.0.0.1:18547\n', config)
        self.assertIn('    server direct 192.0.2.1:18549 check', config)
        self.assertIn('    server tunnel 127.0.0.1:18548 check inter 2s fall 2 rise 1 maxconn 128 pool-purge-delay 30s backup\n', config)
        for code in (502, 503, 504):
            self.assertIn(f'    errorfile {code} /dev/null\n', config)
        self.assertIn('tcp-request connection reject if { nbsrv(clawber_node) lt 1 }', config)
        self.assertIn('http-check expect string 0x1237', config)

    def test_inputs_are_refused_unless_private_one_key_and_a_free_port(self):
        for args, reason in ((('8.8.8.8', self.KEY, 18549), 'peer_must_be_private'),
                             (('192.0.2.1', 'ssh-rsa ' + 'A' * 68, 18549), 'peer_key_must_be_one_ed25519_key'),
                             (('192.0.2.1', self.KEY, 18548), 'invalid_direct_port'),
                             (('192.0.2.1', self.KEY, 80), 'invalid_direct_port')):
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, reason):
                endpoint.rendered(*args)

    def test_verify_notices_any_drift(self):
        texts = endpoint.rendered('192.0.2.1', self.KEY, 18549)
        with tempfile.TemporaryDirectory() as folder:
            keys, sshd, haproxy = (Path(folder) / name for name in ('keys', 'sshd', 'haproxy'))
            keys.write_text(texts['keys'])
            sshd.write_text('Include x\n' + texts['sshd'])
            haproxy.write_text(texts['haproxy'])
            effective = b'allowtcpforwarding remote\npermitlisten 127.0.0.1:18548\n'
            with patch.object(endpoint, 'KEYS', keys), patch.object(endpoint, 'SSHD', sshd), \
                 patch.object(endpoint, 'HAPROXY', haproxy), \
                 patch.object(endpoint.install, 'run', lambda args, **kw: effective):
                self.assertTrue(endpoint.verify(texts, '192.0.2.1')['ok'])
                haproxy.write_text(texts['haproxy'].replace('nbthread 1', 'nbthread 4'))
                with self.assertRaisesRegex(ValueError, 'haproxy_config_differs'):
                    endpoint.verify(texts, '192.0.2.1')



class ContinuousEgressUpdateTests(unittest.TestCase):
    """A rendered candidate on a host that already runs the policy (#315)."""
    def setUp(self):
        from test_continuous_egress_policy import snapshot
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.root, self.units = str(root / 'etc/domino/continuous-reads'), str(root / 'etc/systemd/system') + '/'
        self.calls, self.refuse, self.trusted = [], False, []

        def run(args, **kwargs):
            self.calls.append(args)
            if args[:2] == ['/usr/sbin/nft', '-c']:
                self.checked = {path: Path(path).read_bytes() for path in self.live}
                if self.refuse:
                    raise ValueError('command_failed')
            return b''

        def exclusive(path, content, mode=0o600, uid=0, gid=0):
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
            with os.fdopen(fd, 'wb') as stream:
                os.fchmod(stream.fileno(), mode)
                stream.write(content)
        for item in (patch.object(policy, 'ROOT', self.root), patch.object(policy, 'UNIT_DIR', self.units),
                     patch.object(install_continuous_egress, 'EGRESS_SERVICE', Path(self.units + policy.EGRESS_UNIT)),
                     patch.object(install_continuous_egress.os, 'geteuid', lambda: 0),
                     patch.object(install, 'exclusive_file', exclusive),
                     patch.object(install, 'trusted_parents', self.trusted.append),
                     patch.object(install, 'run', run)):
            item.start()
            self.addCleanup(item.stop)
        base = {**snapshot(), 'publicDataCollectors': True}
        # The host as the first render left it: no writer hosts file and no node port.
        self.before = policy.render(base)
        self.after = policy.render({**base, 'nodeLoopbackReads': True})
        self.live = {path: text for path, text in self.before['artifacts'].items() if not path.endswith('/write.hosts')}
        for path, text in self.live.items():
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_text(text)
            os.chmod(path, self.before['artifactMetadata'][path]['mode'])
        Path(self.units + policy.EGRESS_UNIT).write_text(install_continuous_egress.EGRESS_SERVICE_TEXT)
        self.backup = Path(self.directory.name) / 'backup'

    def state(self):
        return {str(path): (path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
                for path in Path(self.directory.name, 'etc').rglob('*') if path.is_file()}

    def test_an_update_names_each_artifact_new_changed_or_the_same_and_writes_nothing(self):
        before = self.state()
        planned = install_continuous_egress.plan_update(self.after)
        self.assertEqual({path: state for path, state in planned['changes'].items() if state != 'same'},
                         {self.root + '/policy.nft': 'changed', self.root + '/write.hosts': 'new'})
        self.assertEqual(set(planned['changes']), set(self.after['artifacts']))
        self.assertEqual(self.state(), before)
        self.assertEqual(self.calls, [])
        # A mode is part of what is installed.
        os.chmod(self.root + '/read.hosts', 0o600)
        self.assertEqual(install_continuous_egress.plan_update(self.before)['changes'][self.root + '/read.hosts'],
                         'changed')

    def test_an_update_checks_the_new_policy_before_anything_moves_and_keeps_what_it_replaced(self):
        planned = install_continuous_egress.plan_update(self.after)
        result = install_continuous_egress.apply_update(self.after, planned, self.backup)
        self.assertTrue(result['installed'])
        self.assertEqual(self.calls, [['/usr/sbin/nft', '-c', '-f', self.root + '/policy.nft.update'],
                                      ['/usr/bin/systemctl', 'daemon-reload']])
        # nft saw the new policy while every installed artifact was still the old one.
        self.assertEqual(self.checked, {path: text.encode() for path, text in self.live.items()})
        for path, text in self.after['artifacts'].items():
            self.assertEqual(Path(path).read_text(), text)
            self.assertEqual(stat.S_IMODE(Path(path).stat().st_mode), self.after['artifactMetadata'][path]['mode'])
        self.assertFalse(list(Path(self.directory.name, 'etc').rglob('*.update')))
        manifest = json.loads((self.backup / 'manifest.json').read_text())
        self.assertEqual({entry['path']: entry['backup'] is None for entry in manifest},
                         {self.root + '/policy.nft': False, self.root + '/write.hosts': True})
        kept = next(entry for entry in manifest if entry['path'].endswith('policy.nft'))
        self.assertEqual((self.backup / kept['backup']).read_text(), self.live[self.root + '/policy.nft'])
        self.assertEqual(kept['mode'], 0o600)
        self.assertEqual(stat.S_IMODE(self.backup.stat().st_mode), 0o700)
        # What it replaced lies only under root-owned directories.
        self.assertEqual(self.trusted, [self.backup.parent])

    def test_a_family_switched_on_gets_its_new_drop_in_directory(self):
        from test_continuous_egress_policy import LIVE_ENABLED, PINS, snapshot
        family = policy.render({**snapshot(LIVE_ENABLED + ('execution-signer',), PINS), 'publicDataCollectors': True})
        changes = install_continuous_egress.plan_update(family)['changes']
        dropin = self.units + 'domino-execution-signer.service.d/' + policy.DROPIN
        self.assertEqual(changes[dropin], 'new')
        install_continuous_egress.apply_update(family, {'changes': changes}, self.backup)
        self.assertEqual(Path(dropin).read_text(), family['artifacts'][dropin])

    def test_a_policy_nft_refuses_leaves_every_artifact_as_it_was(self):
        before = self.state()
        self.refuse = True
        planned = install_continuous_egress.plan_update(self.after)
        with self.assertRaisesRegex(ValueError, 'command_failed'):
            install_continuous_egress.apply_update(self.after, planned, self.backup)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.calls[-1][:2], ['/usr/sbin/nft', '-c'])

    def test_restore_puts_back_what_the_update_replaced_and_removes_what_it_added(self):
        before = self.state()
        install_continuous_egress.apply_update(self.after, install_continuous_egress.plan_update(self.after),
                                               self.backup)
        self.calls.clear()
        self.trusted.clear()
        with patch('sys.stdout', new_callable=io.StringIO) as printed:
            self.assertEqual(install_continuous_egress.main(['--restore', str(self.backup)]), 0)
        result = json.loads(printed.getvalue())
        self.assertEqual(self.trusted, [self.backup])
        self.assertEqual(self.state(), before)
        self.assertEqual(sorted(result['restored']), [self.root + '/policy.nft', self.root + '/write.hosts'])
        self.assertEqual(self.calls, [['/usr/sbin/nft', '-c', '-f', self.root + '/policy.nft'],
                                      ['/usr/bin/systemctl', 'daemon-reload']])

    def test_an_update_needs_the_running_host_a_new_backup_and_root(self):
        with self.assertRaisesRegex(ValueError, '^backup_exists$'):
            self.backup.mkdir()
            install_continuous_egress.apply_update(self.after, install_continuous_egress.plan_update(self.after),
                                                   self.backup)
        candidate = Path(self.directory.name) / 'candidate.json'
        candidate.write_text(json.dumps(self.after))
        with patch('sys.stdout', new_callable=io.StringIO) as printed:
            self.assertEqual(install_continuous_egress.main(['--candidate', str(candidate), '--update', '--apply']), 1)
        self.assertEqual(json.loads(printed.getvalue())['reason'], 'backup_required')
        with patch.object(install_continuous_egress.os, 'geteuid', lambda: 1000), \
             self.assertRaisesRegex(ValueError, '^root_required$'):
            install_continuous_egress.apply_update(self.after, install_continuous_egress.plan_update(self.after),
                                                   Path(self.directory.name) / 'other')
        os.unlink(self.units + policy.EGRESS_UNIT)
        with self.assertRaisesRegex(ValueError, '^egress_service_missing$'):
            install_continuous_egress.plan_update(self.after)
        self.assertEqual(self.state()[self.root + '/policy.nft'][0], self.live[self.root + '/policy.nft'].encode())

    def test_an_artifact_path_that_is_not_a_file_is_refused(self):
        os.unlink(self.root + '/read.hosts')
        os.mkdir(self.root + '/read.hosts')
        with self.assertRaisesRegex(ValueError, '^egress_artifact_not_a_file$'):
            install_continuous_egress.plan_update(self.after)

    def test_restore_takes_only_its_own_manifest(self):
        with self.assertRaisesRegex(ValueError, '^backup_manifest_missing$'):
            self.backup.mkdir()
            install_continuous_egress.restore(self.backup)
        for entry, code in (({'path': '/etc/sudoers.d/x', 'backup': None, 'mode': None}, 'candidate_path_not_allowed'),
                            ({'path': self.root + '/policy.nft', 'backup': '0', 'mode': 0o666}, 'backup_mode_unexpected')):
            with self.subTest(code=code):
                (self.backup / 'manifest.json').write_text(json.dumps([entry]))
                with self.assertRaisesRegex(ValueError, '^' + code + '$'):
                    install_continuous_egress.restore(self.backup)

if __name__ == '__main__':
    unittest.main()
