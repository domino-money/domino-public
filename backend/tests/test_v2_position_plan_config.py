"""The S1 plan service's configuration: manifests through v2_manifest, settings and secrets, refused whole and named, never echoed."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_v2_manifest import fixture, manifest_document  # noqa: E402
from v2_chains import chain  # noqa: E402
from v2_manifest import Deployment  # noqa: E402
from v2_position_plan_config import ConfigError, load_chain_deployment, load_settings, manifest_env  # noqa: E402

BASE = chain('base-8453')
KEY = 'synthetic-uniswap-key-canary'


class ManifestTests(unittest.TestCase):
    """The listener loads each chain's manifest with v2_manifest's production admission (the one loader)."""

    def load(self, document, profile=BASE):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'deployment.json'
            path.write_text(json.dumps(document))
            return load_chain_deployment(path, profile)

    def test_a_verified_public_manifest_gives_the_deployment_the_planner_reads(self):
        document = manifest_document()
        deployment = self.load(document)
        self.assertIsInstance(deployment, Deployment)
        self.assertEqual((deployment.address('zap.v3'), deployment.address('zap.v4'), deployment.registry),
                         (document['contracts']['zap.v3'], document['contracts']['zap.v4'],
                          document['contracts']['registry']))

    def test_refusals_name_the_setting_and_v2_manifests_code(self):
        test_key_role = manifest_document()
        test_key_role['roles']['operator'] = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'  # the public test mnemonic's first key
        for document, code in ((manifest_document(environment='local-test'), 'v2_deployment_not_admitted'),
                               (test_key_role, 'v2_deployment_not_admitted'),
                               (fixture('v2-deployment-base-8453-fork-rehearsal.json'), 'v2_deployment_not_admitted'),
                               (manifest_document(chain('arbitrum-42161')), 'v2_deployment_chain_mismatch'),
                               ({**manifest_document(), 'extra': 1}, 'v2_deployment_invalid')):
            with self.subTest(code=code), self.assertRaises(ConfigError) as raised:
                self.load(document)
            self.assertEqual(str(raised.exception), 'position_plan_config_manifest_base_8453:' + code)
        with self.assertRaisesRegex(ConfigError, '^position_plan_config_manifest_base_8453:v2_deployment_unreadable$'):
            load_chain_deployment(Path('/nonexistent/deployment.json'), BASE)


class SettingsTests(unittest.TestCase):
    def test_chains_manifests_and_the_key_from_a_credential(self):
        with tempfile.TemporaryDirectory() as directory:
            credentials = Path(directory) / 'credentials'
            credentials.mkdir()
            (credentials / 'uniswap-api-key').write_text(KEY + '\n')
            environ = {'DOMINO_POSITION_PLAN_CHAINS': 'base-8453, robinhood-4663',
                       manifest_env('base-8453'): '/srv/domino/v2/base.json',
                       manifest_env('robinhood-4663'): '/srv/domino/v2/robinhood.json',
                       'CREDENTIALS_DIRECTORY': str(credentials)}
            settings = load_settings(environ)
            self.assertEqual(settings.chains, ('base-8453', 'robinhood-4663'))
            self.assertEqual(settings.uniswap_api_key, KEY)
            self.assertNotIn(KEY, repr(settings))
            self.assertEqual(settings.private_values(), (KEY,))
            self.assertEqual(manifest_env('arbitrum-42161'), 'DOMINO_POSITION_PLAN_MANIFEST_ARBITRUM_42161')

    def test_missing_or_bad_settings_are_named_never_shown(self):
        base = {'DOMINO_POSITION_PLAN_CHAINS': 'base-8453', manifest_env('base-8453'): '/srv/base.json'}
        for environ, code in (({}, 'chains'), ({'DOMINO_POSITION_PLAN_CHAINS': 'elysium'}, 'chains'),
                              ({'DOMINO_POSITION_PLAN_CHAINS': 'base-8453'}, 'manifest_base_8453'),
                              ({**base, manifest_env('base-8453'): 'relative.json'}, 'manifest_base_8453'),
                              ({**base, 'DOMINO_UNISWAP_API_KEY': 'has space'}, 'uniswap_api_key'),
                              ({**base, 'DOMINO_V2_CHAIN_RPC_FILE': 'rpc.json'}, 'chain_rpc_file')):
            with self.subTest(code=code), self.assertRaises(ConfigError) as raised:
                load_settings(environ)
            self.assertEqual(str(raised.exception), 'position_plan_config_' + code)
            self.assertNotIn('has space', str(raised.exception))
        self.assertIsNone(load_settings(base).uniswap_api_key)

    def test_the_environment_key_is_read_when_no_credential(self):
        environ = {'DOMINO_POSITION_PLAN_CHAINS': 'base-8453', manifest_env('base-8453'): '/srv/base.json',
                   'DOMINO_UNISWAP_API_KEY': KEY}
        self.assertEqual(load_settings(environ).uniswap_api_key, KEY)
        self.assertNotIn(KEY, repr(load_settings(environ)))


if __name__ == '__main__':
    unittest.main()
