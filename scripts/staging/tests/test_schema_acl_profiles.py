"""Exact installed schema ACL profiles; no host or database connections."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catalogue_inventory as inventory


PUBLIC_USAGE = ['public', 'PUBLIC', 'USAGE', 'pg_database_owner', False]


def stock_acl(*, installed):
    """Independent fixture of PG foundation grants plus migrations 001–014."""
    owners = [('pg_catalog', 'postgres'), ('pg_toast', 'postgres'),
              ('information_schema', 'postgres'), ('public', 'pg_database_owner')]
    service_usage = [
        ('domino_catalogue', 'domino_catalogue_reader'),
        ('domino_catalogue', 'domino_catalogue_writer'),
        ('domino_activity', 'domino_catalogue_reader'),
        ('domino_activity', 'domino_catalogue_writer'),
        ('domino_sessions', 'domino_session_auth'),
        ('domino_wallet_access', 'domino_session_auth'),
        ('domino_wallet_access', 'domino_wallet_access_operator'),
        ('domino_deposits', 'domino_deposit_service'),
    ]
    if installed:
        owners += [(schema, 'domino_catalogue_admin') for schema in (
            'domino_catalogue', 'domino_activity', 'domino_sessions',
            'domino_wallet_access', 'domino_deposits')]
    rows = [[schema, owner, privilege, owner, False]
            for schema, owner in owners for privilege in ('USAGE', 'CREATE')]
    rows += [[schema, 'PUBLIC', 'USAGE', owner, False] for schema, owner in owners
             if schema in ('pg_catalog', 'information_schema', 'public')]
    if installed:
        rows += [[schema, role, 'USAGE', 'domino_catalogue_admin', False]
                 for schema, role in service_usage]
    return rows


class SchemaAclProfileTests(unittest.TestCase):
    def accepted(self, rows, *, installed=True):
        return inventory.check_inventory({'schemaAcl': rows}, installed=installed)['completeSchemaAcl']

    def profiles(self):
        stock = stock_acl(installed=True)
        return [('pg16_stock', stock),
                ('installed_public_usage_revoked', [row for row in stock if row != PUBLIC_USAGE])]

    def test_both_exact_installed_profiles_are_accepted_without_mutating_input(self):
        for (name, rows), count in zip(self.profiles(), (29, 28)):
            with self.subTest(profile=name):
                original = copy.deepcopy(rows)
                self.assertEqual(len(rows), count)
                self.assertTrue(self.accepted(rows))
                self.assertTrue(self.accepted(list(reversed(rows))))
                self.assertEqual(rows, original)

    def test_installer_foundation_remains_stock_only(self):
        stock = stock_acl(installed=False)
        self.assertEqual(len(stock), 11)
        self.assertTrue(self.accepted(stock, installed=False))
        self.assertFalse(self.accepted([row for row in stock if row != PUBLIC_USAGE], installed=False))
        for _, installed_rows in self.profiles():
            self.assertFalse(self.accepted(installed_rows, installed=False))
        self.assertFalse(self.accepted(stock, installed=True))

    def test_every_other_missing_grant_is_rejected(self):
        for profile, rows in self.profiles():
            for index, row in enumerate(rows):
                with self.subTest(profile=profile, removed=row):
                    candidate = rows[:index] + rows[index + 1:]
                    self.assertEqual(self.accepted(candidate), row == PUBLIC_USAGE)

    def test_unknown_or_extra_grants_are_rejected_in_both_profiles(self):
        additions = [
            ['public', 'PUBLIC', 'CREATE', 'pg_database_owner', False],
            ['public', 'domino_session_auth', 'USAGE', 'pg_database_owner', False],
            ['pg_toast', 'PUBLIC', 'USAGE', 'postgres', False],
            ['domino_sessions', 'unrelated', 'USAGE', 'domino_catalogue_admin', False],
            ['domino_catalogue', 'domino_catalogue_reader', 'CREATE', 'domino_catalogue_admin', False],
        ]
        for profile, rows in self.profiles():
            for addition in additions:
                with self.subTest(profile=profile, added=addition):
                    self.assertFalse(self.accepted(rows + [addition]))

    def test_every_row_still_requires_exact_identity_grantor_and_no_grant_option(self):
        for profile, rows in self.profiles():
            for index in range(len(rows)):
                for field, replacement in ((0, 'other_schema'), (1, 'other_role'),
                                           (2, 'OTHER'), (3, 'other_grantor'), (4, True), (4, 0)):
                    with self.subTest(profile=profile, row=rows[index], field=field, value=replacement):
                        candidate = copy.deepcopy(rows)
                        candidate[index][field] = replacement
                        self.assertFalse(self.accepted(candidate))

    def test_duplicates_cannot_hide_a_missing_grant(self):
        for profile, rows in self.profiles():
            for index in range(len(rows)):
                with self.subTest(profile=profile, duplicated=rows[index]):
                    self.assertFalse(self.accepted(rows + [rows[index]]))
                    candidate = copy.deepcopy(rows)
                    candidate[(index + 1) % len(rows)] = candidate[index]
                    self.assertFalse(self.accepted(candidate))

    def test_missing_or_malformed_acl_is_not_a_profile(self):
        for candidate in (None, [], {}, 'pg16_stock', [PUBLIC_USAGE],
                          [PUBLIC_USAGE] * 28, [PUBLIC_USAGE] * 29):
            with self.subTest(acl=candidate):
                self.assertFalse(self.accepted(candidate))


if __name__ == '__main__':
    unittest.main()
