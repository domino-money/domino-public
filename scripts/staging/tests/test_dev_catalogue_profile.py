"""Offline profile/peer checks and opt-in disposable PostgreSQL SQL transitions."""
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_catalogue_profile as dev
import check_roles as prod
import catalogue_inventory as inventory
import test_catalogue_postgres as fixture


def peer_evidence():
    users = {}
    for index, (name, permitted) in enumerate(dev.PEERS.items()):
        uid, gid = dev.DEV_USERS.get(name, (1100 + index, 1100 + index))
        users[name] = {'uid': uid, 'gid': gid, 'groups': [gid] + ([988] if permitted else []),
                       'canTraverse': bool(permitted)}
    return {'users': users, 'ident': list(dev.PEER_ADDITIONS['ident']), 'hba': list(dev.PEER_ADDITIONS['hba']),
        'peerMatrix': [{'osUser': user, 'sqlRole': role, 'result':
            'allowed' if role in permitted else 'peer_denied' if permitted else 'socket_denied'}
            for user, permitted in dev.PEERS.items() for role in (*prod.ROLES, dev.ROLE)],
        'selectChecks': [{'osUser': user, 'sqlRole': role, 'schema': schema, 'result': 'allowed' if
            (schema in dev.PUBLIC_SCHEMAS if role == dev.ROLE else prod.allowed_table(role, schema + '.' + tables[0], 'SELECT'))
            else 'privilege_denied'} for user, permitted in dev.PEERS.items() for role in permitted
            for schema, tables in prod.TABLES.items()]}


class DevCatalogueOfflineTests(unittest.TestCase):
    def test_fixed_role_and_plan_add_only_one_peer(self):
        self.assertEqual(dev.ROLE, 'domino_dev_catalogue_reader')
        self.assertEqual(dev.PEER_ADDITIONS['ident'], ('domino', 'domino-dev-read', dev.ROLE))
        self.assertEqual(len(dev.TABLES), 15)
        self.assertEqual(len(dev.expected_dev_state()['grants']), 18)
        self.assertNotIn(dev.ROLE, prod.ROLES)
        self.assertNotIn('domino-dev-read', prod.PEERS)
        self.assertEqual(len(prod.PEERS), 9)

    def test_complete_peer_evidence_and_production_denials(self):
        proof = peer_evidence()
        original = deepcopy(proof)
        self.assertTrue(dev.check_peer_evidence(proof))
        self.assertEqual(proof, original)
        for field in ('peerMatrix', 'selectChecks'):
            for i, row in enumerate(proof[field]):
                with self.subTest(field=field, i=i):
                    changed = deepcopy(proof)
                    changed[field][i]['result'] = 'denied' if row['result'] == 'allowed' else 'allowed'
                    self.assertFalse(dev.check_peer_evidence(changed))

    def test_missing_duplicate_extra_and_forged_identity_proofs_rejected(self):
        proof = peer_evidence()
        cases = []
        for field in ('peerMatrix', 'selectChecks'):
            for changed_rows in (proof[field][:-1], proof[field] + [proof[field][0]],
                                 [proof[field][0]] * len(proof[field])):
                changed = deepcopy(proof); changed[field] = changed_rows; cases.append(changed)
        for name in dev.DEV_USERS:
            for field, value in (('uid', 1000), ('gid', 1000), ('groups', [988]), ('groups', [974, 988, 0])):
                changed = deepcopy(proof); changed['users'][name][field] = value; cases.append(changed)
        changed = deepcopy(proof); changed['ident'][1] = 'domino-dev-gateway'; cases.append(changed)
        changed = deepcopy(proof); changed['hba'][-1] = 'map=other'; cases.append(changed)
        for changed in cases:
            self.assertFalse(dev.check_peer_evidence(changed))

    def test_sql_is_inspection_only_and_has_no_application_data_select(self):
        sql = dev.snapshot_sql()
        self.assertIn('pg_shdepend', sql)
        self.assertIn('rolpassword IS NULL', sql)
        self.assertNotIn('rolpassword AS', sql)
        for forbidden in ('CREATE ROLE', 'ALTER ROLE', 'CASCADE', 'SELECT * FROM domino_'):
            self.assertFalse(forbidden in sql, forbidden)
        self.assertNotRegex(sql, r'(?m)^GRANT ')
        self.assertGreater(dev.dev_acl_sql().count('IS NOT DISTINCT FROM'), 300)

    def test_no_unqualified_or_oversized_baseline_is_accepted(self):
        for data in ({}, None, {'version': 1}, {'callerQualified': True}):
            with self.assertRaises(ValueError):
                dev.build_sql(data)
        for raw in (b'{"version":1,"version":1}', b'{"v":NaN}', b' ' * (dev.MAX_SNAPSHOT_BYTES + 1)):
            with self.assertRaises(ValueError): dev.load_baseline(raw)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_STAGING_POSTGRES') == '1',
                     'opt-in disposable PostgreSQL cluster')
class DevCataloguePostgresTests(unittest.TestCase):
    # Reuse only the existing private-socket PG fixture lifecycle, not its tests.
    for _name in ('run_tool', 'query', 'stop_cluster', 'setUpClass'):
        locals()[_name] = fixture.CataloguePostgresTests.__dict__[_name]
    del _name

    def snapshot(self):
        return json.loads(self.query(dev.snapshot_sql()))

    def test_exact_apply_denials_grantor_limit_and_matched_rollback(self):
        baseline = self.snapshot()
        self.assertTrue(dev.check_snapshot(baseline))
        plan = dev.build_sql(baseline)
        self.assertNotIn('CASCADE', plan['rollbackSql'])
        self.assertNotIn('ALTER DEFAULT PRIVILEGES', plan['applySql'])
        self.assertIn('SET LOCAL ROLE domino_catalogue_admin', plan['applySql'])
        self.query(plan['applySql'])
        try:
            after = self.snapshot()
            self.assertEqual(after, plan['expectedAfter'])
            self.assertTrue(dev.check_snapshot(after, dev_present=True))
            with self.assertRaises(ValueError): dev.check_snapshot(after)
            # Old inventory guards still reject provisioned dev state.
            raw = json.loads(self.query(inventory.inventory_sql()))
            self.assertFalse(all(inventory.check_inventory(raw, installed=True).values()))
            for schema, tables in prod.TABLES.items():
                sql = f'SELECT count(*) FROM (SELECT 1 FROM {schema}.{tables[0]} LIMIT 0) AS no_rows;'
                if schema in dev.PUBLIC_SCHEMAS:
                    self.assertEqual(self.query(sql, role=dev.ROLE), '0')
                else:
                    with self.assertRaises(AssertionError): self.query(sql, role=dev.ROLE)
        finally:
            self.query(plan['rollbackSql'])
        self.assertEqual(self.snapshot(), baseline)

    def test_baseline_drift_refuses_creation_without_repair(self):
        baseline = self.snapshot(); plan = dev.build_sql(baseline)
        self.query('GRANT SELECT ON domino_catalogue.events TO unrelated;', role=dev.OWNER)
        try:
            with self.assertRaisesRegex(AssertionError, 'dev_catalogue_state_drift'):
                self.query(plan['applySql'])
            self.assertEqual(self.query(f"SELECT to_regrole('{dev.ROLE}') IS NULL"), 't')
            self.assertEqual(self.query("SELECT has_table_privilege('unrelated','domino_catalogue.events','SELECT')"), 't')
        finally:
            self.query('REVOKE SELECT ON domino_catalogue.events FROM unrelated;', role=dev.OWNER)
        self.assertEqual(self.snapshot(), baseline)

    def test_role_and_privilege_drift_refuse_rollback_without_overwrite(self):
        baseline = self.snapshot(); plan = dev.build_sql(baseline)
        self.query(plan['applySql'])
        cases = [
            (f'ALTER ROLE {dev.ROLE} CONNECTION LIMIT 2', f'ALTER ROLE {dev.ROLE} CONNECTION LIMIT 1'),
            (f'ALTER ROLE {dev.ROLE} INHERIT', f'ALTER ROLE {dev.ROLE} NOINHERIT'),
            (f'ALTER ROLE {dev.ROLE} CREATEDB', f'ALTER ROLE {dev.ROLE} NOCREATEDB'),
            (f'GRANT domino_catalogue_reader TO {dev.ROLE}', f'REVOKE domino_catalogue_reader FROM {dev.ROLE}'),
            (f'GRANT SELECT ON domino_sessions.sessions TO {dev.ROLE}', f'REVOKE SELECT ON domino_sessions.sessions FROM {dev.ROLE}'),
            (f'GRANT USAGE ON SCHEMA domino_sessions TO {dev.ROLE}', f'REVOKE USAGE ON SCHEMA domino_sessions FROM {dev.ROLE}'),
            (f'GRANT UPDATE ON domino_catalogue.events TO {dev.ROLE}', f'REVOKE UPDATE ON domino_catalogue.events FROM {dev.ROLE}'),
            (f'GRANT SELECT ON domino_catalogue.events TO {dev.ROLE} WITH GRANT OPTION', f'REVOKE GRANT OPTION FOR SELECT ON domino_catalogue.events FROM {dev.ROLE}'),
            (f'ALTER ROLE {dev.ROLE} SET statement_timeout=1000', f'ALTER ROLE {dev.ROLE} RESET statement_timeout'),
            (f'GRANT CONNECT ON DATABASE postgres TO {dev.ROLE}', f'REVOKE CONNECT ON DATABASE postgres FROM {dev.ROLE}'),
        ]
        try:
            for mutate, restore in cases:
                with self.subTest(mutate=mutate):
                    self.query(mutate)
                    drift = self.snapshot()
                    with self.assertRaises(ValueError): dev.check_snapshot(drift, dev_present=True)
                    with self.assertRaisesRegex(AssertionError, 'dev_catalogue_state_drift'):
                        self.query(plan['rollbackSql'])
                    self.assertEqual(self.snapshot(), drift)
                    self.query(restore)
                    self.assertEqual(self.snapshot(), plan['expectedAfter'])
        finally:
            self.query(plan['rollbackSql'])

    def test_another_grantor_cannot_masquerade_as_owner(self):
        baseline = self.snapshot(); plan = dev.build_sql(baseline)
        self.query(plan['applySql'])
        try:
            self.query('GRANT SELECT ON domino_catalogue.events TO unrelated WITH GRANT OPTION;', role=dev.OWNER)
            self.query('GRANT USAGE ON SCHEMA domino_catalogue TO unrelated;', role=dev.OWNER)
            self.query(f'SET ROLE unrelated; GRANT SELECT ON domino_catalogue.events TO {dev.ROLE};')
            drift = self.snapshot()
            self.assertTrue(any(row[3] == 'unrelated' for row in drift['devState']['grants']))
            with self.assertRaises(ValueError): dev.check_snapshot(drift, dev_present=True)
            with self.assertRaisesRegex(AssertionError, 'dev_catalogue_state_drift'):
                self.query(plan['rollbackSql'])
            self.query(f'SET ROLE unrelated; REVOKE SELECT ON domino_catalogue.events FROM {dev.ROLE};')
            self.query('REVOKE SELECT ON domino_catalogue.events FROM unrelated;', role=dev.OWNER)
            self.query('REVOKE USAGE ON SCHEMA domino_catalogue FROM unrelated;', role=dev.OWNER)
        finally:
            self.query(plan['rollbackSql'])

    def test_cluster_admin_is_required_even_for_owner(self):
        plan = dev.build_sql(self.snapshot())
        with self.assertRaisesRegex(AssertionError, 'cluster_admin_required'):
            self.query(plan['applySql'], role=dev.OWNER)
        self.assertEqual(self.query(f"SELECT to_regrole('{dev.ROLE}') IS NULL"), 't')

    def test_connection_limit_and_active_session_rollback_refusal(self):
        import psycopg
        plan = dev.build_sql(self.snapshot())
        self.query(plan['applySql'])
        try:
            with psycopg.connect(host=str(self.socket), port=18777, dbname=dev.DATABASE, user=dev.ROLE) as connection:
                with self.assertRaises(psycopg.OperationalError):
                    psycopg.connect(host=str(self.socket), port=18777, dbname=dev.DATABASE, user=dev.ROLE)
                with self.assertRaisesRegex(AssertionError, 'dev_catalogue_sessions_active'):
                    self.query(plan['rollbackSql'])
                self.assertEqual(connection.execute('SELECT current_user').fetchone()[0], dev.ROLE)
        finally:
            self.query(plan['rollbackSql'])


if __name__ == '__main__':
    unittest.main()
