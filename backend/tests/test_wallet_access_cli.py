"""The local operator CLI cannot change chain, select a DB role or leak errors."""
from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from manage_wallet_access import main

ADDRESS = '0x' + '11' * 20
SETTINGS = {'host': '/private/synthetic/socket', 'port': 55439, 'dbname': 'domino_catalogue'}


class WalletAccessCliTests(unittest.TestCase):
    def run_cli(self, args, *, failure=None):
        admin = Mock()
        admin.grant.return_value = {'chainId': 4663, 'address': ADDRESS, 'allowed': True,
                                    'generation': 1, 'changed': True}
        admin.revoke.return_value = {'chainId': 4663, 'address': ADDRESS, 'allowed': False,
                                     'generation': 2, 'changed': True}
        admin.list.return_value = {'wallets': [], 'hasMore': False, 'nextAfter': None}
        loader = Mock(return_value=SETTINGS, side_effect=failure)
        factory = Mock(return_value=admin)
        output = StringIO()
        with redirect_stdout(output):
            code = main(args, settings_loader=loader, admin_factory=factory)
        return code, json.loads(output.getvalue()), loader, factory, admin

    def test_explicit_operator_actions_use_fixed_store_and_never_activate_services(self):
        for action in ('grant', 'revoke'):
            code, result, loader, factory, admin = self.run_cli([action, ADDRESS])
            self.assertEqual(code, 0)
            self.assertEqual(result['allowed'], action == 'grant')
            factory.assert_called_once_with(SETTINGS)
            getattr(admin, action).assert_called_once_with(ADDRESS)
            self.assertNotIn('credentials', result)
            self.assertNotIn('enabled', result)

    def test_paginated_list_preserves_bound_and_cursor(self):
        code, result, _, _, admin = self.run_cli(['list', '--limit', '5', '--after', ADDRESS])
        self.assertEqual((code, result['wallets']), (0, []))
        admin.list.assert_called_once_with(limit=5, after=ADDRESS)

    def test_invalid_scope_or_arguments_do_not_open_a_database(self):
        for args in ([], ['--chain-id', '1', 'grant', ADDRESS], ['list', '--limit', '101'],
                     ['list', '--limit', '0'], ['--role', 'postgres', 'list'],
                     ['grant', ADDRESS, '--enable'], ['--chain-id', '4663.0', 'list']):
            with self.subTest(args=args):
                code, result, loader, factory, _ = self.run_cli(args)
                self.assertEqual((code, result), (2, {'error': 'wallet_access_invalid_request'}))
                loader.assert_not_called()
                factory.assert_not_called()

    def test_configuration_errors_are_finite_and_never_echo_paths_or_secrets(self):
        code, result, _, factory, _ = self.run_cli(
            ['--database-config', '/PRIVATE_CANARY/config.json', 'list'],
            failure=RuntimeError('PRIVATE_CANARY postgres password diagnostics'))
        self.assertEqual((code, result), (2, {'error': 'wallet_access_configuration_unavailable'}))
        self.assertNotIn('PRIVATE_CANARY', json.dumps(result))
        factory.assert_not_called()


if __name__ == '__main__':
    unittest.main()
