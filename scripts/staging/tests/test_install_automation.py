"""Scoped plan, unit, SQL and peer regressions for the automation installer.
No real host, database or systemd is touched."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install_automation as automation
import prepare_disabled as base
import upgrade_financial as financial

REPO = Path(__file__).resolve().parents[3]
OTHER_PACKAGED = tuple(p for p in financial.PACKAGED_ONLY_MIGRATIONS if p not in automation.MIGRATIONS)


def hba_text(*, publisher=False):
    lines = ['local all postgres peer\n']
    lines += [f'local {base.DB} {role} peer map=domino_financial\n' for role in financial.NEW_ROLES]
    if publisher:
        lines.append(f'local {base.DB} domino_execution_publisher peer map=domino_financial\n')
    lines.append('local all all reject\n')
    return ''.join(lines).encode()


def ident_text(*, automation_rows=False):
    lines = ['domino domino-read domino_catalogue_reader\n',
             'domino_financial domino-execution-signer domino_execution_worker\n',
             'domino_financial domino-execution-signer domino_execution_ledger\n',
             'domino_financial domino-execution-signer domino_execution_signer\n']
    if automation_rows:
        lines.append('domino_financial domino-automation domino_execution_worker\n')
    return ''.join(lines).encode()


class AutomationInstallTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='domino-automation-install-tests-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.path = Path(cls.temp.name) / 'source.tar'
        cls.commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
        subprocess.run(['git', 'archive', '--format=tar', '-o', str(cls.path), cls.commit], cwd=REPO, check=True)
        cls.digest = hashlib.sha256(cls.path.read_bytes()).hexdigest()
        cls.files = base.archive_files(cls.path, cls.digest, cls.commit)
        cls.planned = automation.plan(cls.files, cls.commit, cls.digest)

    def test_plan_from_a_real_git_archive_without_git_or_host_access(self):
        result = subprocess.run([sys.executable, str(REPO / 'scripts/staging/install_automation.py'),
                                 '--archive', str(self.path), '--archive-sha256', self.digest, '--commit', self.commit],
                                capture_output=True, text=True, env={'PATH': '/nonexistent', 'PYTHONDONTWRITEBYTECODE': '1'}, check=True)
        self.assertEqual(json.loads(result.stdout), self.planned)
        self.assertEqual([row['path'] for row in self.planned['migrations']], list(automation.MIGRATIONS))
        self.assertEqual(self.planned['migrations'][1]['sha256'], hashlib.sha256(self.files[automation.MIGRATIONS[1]][0]).hexdigest())
        self.assertEqual((self.planned['servicesStarted'], self.planned['configurationCreated'], self.planned['keysCreated']), (False, False, False))
        self.assertEqual(self.planned['roles'], list(automation.ROLES))
        self.assertEqual(self.planned['sourceDirectory'], f'/opt/domino/financial/releases/{self.commit}/automation')
        self.assertEqual(self.planned['privateDirectory'], '/etc/domino/financial/automation')
        # Every automation module the unit needs travels in the archive, or the plan refuses.
        for name in automation.SOURCES:
            with self.assertRaisesRegex(ValueError, 'automation_source_missing'):
                automation.plan({k: v for k, v in self.files.items() if k != name}, self.commit, self.digest)

    def test_unit_is_off_hardened_and_reads_only_its_private_configuration(self):
        text = self.planned['unit']
        self.assertIn('ConditionPathExists=/etc/domino/financial/automation/config.json\n', text)
        self.assertIn('ExecStart=/opt/domino/backend-venv/bin/python3.14 -B backend/automation_cli.py --config /run/domino-financial-automation-config/config.json serve\n', text)
        self.assertIn('BindReadOnlyPaths=/etc/domino/financial/automation:/run/domino-financial-automation-config\n', text)
        self.assertIn(f'WorkingDirectory=/opt/domino/financial/releases/{self.commit}/automation\n', text)
        self.assertIn('IPAddressDeny=any\nIPAddressAllow=localhost\n', text)
        self.assertIn('User=domino-automation\nGroup=domino-automation\nSupplementaryGroups=domino-db\n', text)
        for line in ('Type=exec', 'ProtectSystem=strict', 'NoNewPrivileges=true', 'CapabilityBoundingSet=', 'UMask=0077',
                     'Restart=on-failure', 'KillSignal=SIGTERM', 'PrivateTmp=true', 'ProtectHome=true'):
            self.assertIn(line + '\n', text)
        for forbidden in ('[Install]', 'WantedBy=', '--key', 'run-once', 'domino-dev', 'EnvironmentFile=/'):
            self.assertNotIn(forbidden, text)
        peers = self.planned['peerUnits']
        self.assertEqual(set(peers), set(automation.PEER_UNITS))
        self.assertIn('SocketMode=0660\n', peers['domino-gas-reservation.socket'])
        self.assertIn('SocketGroup=domino-db\n', peers['domino-gas-reservation.socket'])
        self.assertIn('User=domino-gas-reservation\n', peers['domino-gas-reservation.service'])
        self.assertIn('User=domino-gas-settlement\n', peers['domino-gas-settlement.service'])
        self.assertIn('Requires=domino-gas-reservation.socket\n', peers['domino-gas-settlement.service'])
        self.assertIn('gas_settlement_cli.py', peers['domino-gas-settlement.service'])
        self.assertIn('Unit=domino-gas-settlement.service\n', peers['domino-gas-settlement.timer'])
        self.assertTrue(all('[Install]' not in unit for unit in peers.values()))

    def test_only_the_automation_migrations_run_in_one_guarded_transaction(self):
        files = dict(self.files)
        for index, name in enumerate((*base.MIGRATIONS, *financial.MIGRATIONS, *OTHER_PACKAGED)):
            files[name] = (f'RAISE_OTHER_MIGRATION_{index};'.encode(), False)
        query = automation.migration_sql(files, self.planned)
        self.assertNotIn('RAISE_OTHER_MIGRATION', query)
        for name in (*base.MIGRATIONS, *financial.MIGRATIONS, *OTHER_PACKAGED):
            self.assertNotIn(name, query)
        self.assertTrue(query.startswith('BEGIN;'))
        self.assertTrue(query.endswith('COMMIT;\n'))
        migrations = [self.files[name][0].decode() for name in automation.MIGRATIONS]
        self.assertEqual(len(migrations), 11)
        for earlier, later in zip(migrations, migrations[1:]):
            self.assertLess(query.index(earlier), query.index(later))
        first = migrations[0]
        second = migrations[1]
        self.assertLess(query.index('financial_schema_missing'), query.index(first))
        for guard in ('wrong_automation_ddl_identity', 'automation_schema_already_exists', 'execution_roles_unexpected',
                      "to_regclass('domino_financial_install.receipt') IS NULL", "to_regclass('domino_execution.cycles') IS NOT NULL"):
            self.assertIn(guard, query)
        self.assertIn('ALTER ROLE domino_execution_publisher LOGIN; GRANT CONNECT ON DATABASE domino_catalogue TO domino_execution_publisher;', query)
        for _, login, privilege in automation.GAS_ACCESS:
            self.assertIn(f'CREATE ROLE {login} LOGIN INHERIT NOSUPERUSER', query)
            self.assertIn(f'GRANT {privilege} TO {login} WITH INHERIT TRUE, SET FALSE;', query)
            self.assertNotIn(f'ALTER ROLE {privilege} LOGIN', query)
        self.assertIn('domino_automation_install.receipt', query)
        self.assertEqual(query.count('CREATE ROLE domino_execution_publisher'), 1)
        self.assertNotIn('LOGIN;', query.split(second)[0].split(first)[0])

    def test_peer_files_gain_exactly_the_automation_rows(self):
        hba, ident = automation.peers(hba_text(), ident_text())
        original_hba, original_ident = hba_text().decode().splitlines(), ident_text().decode().splitlines()
        new_hba, new_ident = hba.decode().splitlines(), ident.decode().splitlines()
        self.assertEqual([line for line in new_hba if line not in original_hba],
                         ['local domino_catalogue domino_execution_publisher peer map=domino_financial',
                          *(f'local domino_catalogue {login} peer map=domino_financial'
                            for _, login, _ in automation.GAS_ACCESS)])
        self.assertEqual(new_hba[-1], 'local all all reject')
        self.assertLess(new_hba.index('local domino_catalogue domino_execution_publisher peer map=domino_financial'), len(new_hba) - 1)
        self.assertEqual(new_ident[:len(original_ident)], original_ident)
        self.assertEqual(new_ident[len(original_ident):],
                         [f'domino_financial domino-automation {role}' for role in automation.ROLES] +
                         [f'domino_financial {os_user} {login}' for os_user, login, _ in automation.GAS_ACCESS])
        for bad_hba, bad_ident, reason in (
                (hba_text(publisher=True), ident_text(), 'automation_peers_exist'),
                (hba_text(), ident_text(automation_rows=True), 'automation_peers_exist'),
                (b'local all postgres peer\nlocal all all reject\n', ident_text(), 'financial_peers_missing'),
                (hba_text(), b'domino domino-read domino_catalogue_reader\n', 'financial_peers_missing'),
                (hba_text().replace(b'local all all reject\n', b''), ident_text(), 'missing_unique_local_reject')):
            with self.assertRaisesRegex(ValueError, reason):
                automation.peers(bad_hba, bad_ident)

    def test_apply_and_rollback_refuse_before_touching_a_host(self):
        # Neither path reaches the host from an unprivileged test: root is
        # required first, and a rollback needs a receipt directory it will not create.
        with self.assertRaisesRegex(ValueError, 'root_required'):
            automation.baseline(self.files, self.planned)
        if os.geteuid() != 0:
            with self.assertRaisesRegex(ValueError, 'root_required'):
                automation.apply(self.files, self.planned, {})
        self.assertEqual(automation.RECEIPTS, Path('/var/backups/domino-financial/automation'))
        self.assertEqual(automation.UNIT, 'domino-automation.service')


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'disposable PostgreSQL required')
class GasPeerRoleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(REPO / 'backend' / 'tests'))
        from execution_pg import ExecutionPostgres
        import psycopg
        cls.psycopg = psycopg
        cls.pg = ExecutionPostgres().start()
        cls.addClassCleanup(cls.pg.close)
        with cls.pg.admin() as conn:
            conn.execute((REPO / 'backend/migrations/019_execution_journal.sql').read_text())
            conn.execute((REPO / 'backend/migrations/028_automation_cycle.sql').read_text())
            for name in automation.MIGRATIONS:
                if not name.split('/')[-1].startswith(('032_', '033_', '034_', '035_', '036_', '037_', '038_')):
                    continue
                conn.execute((REPO / name).read_text())
            conn.execute(automation.gas_login_sql(cls.pg.settings['dbname']))

    def test_bridge_roles_connect_and_inherit_only_their_function_set(self):
        reserve = 'domino_gas_budget.reserve(text,text,text,numeric,numeric,numeric,bigint,bigint,text,bigint,integer)'
        settle = 'domino_gas_budget.settle(text,text,numeric,numeric,numeric,bigint,bigint)'
        claim = 'domino_gas_budget.claim_for_settlement(text,text)'
        sweep = 'domino_gas_budget.next_pending(integer)'
        cancel = 'domino_gas_budget.cancel_unsigned(text,text)'
        attest = 'domino_gas_budget.attest_settlement_quote(text,text,numeric,numeric,bigint,bigint,text,bigint)'
        for _, login, privilege in automation.GAS_ACCESS:
            with self.subTest(login=login), self.psycopg.connect(**self.pg.settings, user=login) as conn:
                self.assertEqual(conn.execute('SELECT current_user').fetchone(), (login,))
                self.assertEqual(conn.execute('SELECT rolcanlogin FROM pg_roles WHERE rolname=%s',
                                              (privilege,)).fetchone(), (False,))
                self.assertEqual(conn.execute('SELECT has_function_privilege(current_user,%s,\'EXECUTE\'),'
                                              'has_function_privilege(current_user,%s,\'EXECUTE\'),'
                                              'has_function_privilege(current_user,%s,\'EXECUTE\'),'
                                              'has_function_privilege(current_user,%s,\'EXECUTE\'),'
                                              'has_function_privilege(current_user,%s,\'EXECUTE\'),'
                                              'has_function_privilege(current_user,%s,\'EXECUTE\')',
                                              (reserve, settle, claim, sweep, cancel, attest)).fetchone(),
                                 (login == 'domino_gas_reservation_login',
                                  login == 'domino_gas_settlement_login',
                                  login == 'domino_gas_settlement_login',
                                  login == 'domino_gas_settlement_login',
                                  login == 'domino_gas_settlement_login',
                                  login == 'domino_gas_reservation_login'))
                foreign = next(role for _, role, _ in automation.GAS_ACCESS if role != login)
                with self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
                    conn.execute(f'SET ROLE {foreign}')
                conn.rollback()
                with self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
                    conn.execute(f'SET ROLE {privilege}')
                conn.rollback()
                if login == 'domino_gas_reservation_login':
                    self.assertEqual(len(conn.execute('SELECT * FROM domino_gas_budget.status(current_date)').fetchone()), 3)
                    with self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
                        conn.execute("SELECT * FROM domino_gas_budget.claim_for_settlement('0x" + '11' * 32 + "','publisher')")
                else:
                    self.assertEqual(conn.execute("SELECT * FROM domino_gas_budget.claim_for_settlement('0x" +
                                                  '11' * 32 + "','publisher')").fetchall(), [])
                    with self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
                        conn.execute('SELECT * FROM domino_gas_budget.status(current_date)')

    def test_privilege_roles_cannot_log_in_directly(self):
        for _, _, privilege in automation.GAS_ACCESS:
            with self.subTest(role=privilege), self.assertRaises(self.psycopg.OperationalError):
                self.psycopg.connect(**self.pg.settings, user=privilege, connect_timeout=2)

    def test_settlement_witness_functions_are_scoped_without_direct_table_select(self):
        claim = '0x' + '11' * 32
        owner = '0x' + '22' * 20
        with self.pg.admin() as conn:
            conn.execute('INSERT INTO domino_execution.publications '
                         '(observation_id,guard,pool_id,block_number,block_hash,block_timestamp,expires_at,'
                         'sqrt_price,signer,nonce,envelope,signed_bytes,transaction_hash,state) '
                         "VALUES(%s,%s,%s,1,%s,1,2,1,%s,0,'{}'::jsonb,%s,%s,'signed')",
                         (claim, owner, claim, claim, owner, b'x', '0x' + '33' * 32))
        with self.psycopg.connect(**self.pg.settings, user='domino_gas_settlement_login') as conn:
            self.assertEqual(conn.execute('SELECT observation_id FROM domino_execution.gas_publication_witness(%s)',
                                          (claim,)).fetchall(), [(claim,)])
            self.assertEqual(conn.execute('SELECT * FROM domino_execution.gas_publication_witness(%s)',
                                          ('0x' + '44' * 32,)).fetchall(), [])
            self.assertEqual(conn.execute('SELECT * FROM domino_execution.gas_intent_witness(%s,%s)',
                                          (owner, claim)).fetchall(), [])
            self.assertEqual(conn.execute('SELECT * FROM domino_execution.gas_reverted_witness(%s,%s)',
                                          (owner, claim)).fetchall(), [])
            for table in ('publications', 'intents', 'journal', 'attempts', 'effects',
                          'reverted_receipts', 'publication_finality',
                          'publication_finality_cursor'):
                with self.subTest(table=table), self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
                    conn.execute(f'SELECT * FROM domino_execution.{table} LIMIT 1')
                conn.rollback()
            with self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
                conn.execute('INSERT INTO domino_execution.publications DEFAULT VALUES')
        with self.psycopg.connect(**self.pg.settings, user='domino_gas_reservation_login') as conn:
            with self.assertRaises(self.psycopg.errors.InsufficientPrivilege):
                conn.execute('SELECT * FROM domino_execution.gas_publication_witness(%s)', (claim,))


if __name__ == '__main__':
    unittest.main()
