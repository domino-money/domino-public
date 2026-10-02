"""Settings come from the environment or systemd credentials; failures name the setting, never the value."""
import os
from pathlib import Path
import tempfile
import unittest

from crosschain_support import FEE, PRIVATE  # noqa: F401  (puts backend on sys.path)
from crosschain_config import ConfigError, load_settings

BASE = {'DOMINO_CROSSCHAIN_FEE_RECIPIENT': '0x' + '2A' * 20}


class SettingsTests(unittest.TestCase):
    def refuse(self, environ, setting):
        with self.assertRaises(ConfigError) as caught:
            load_settings(environ)
        self.assertEqual(str(caught.exception), 'crosschain_config_' + setting)
        for value in environ.values():
            if len(value) > 6:
                self.assertNotIn(value, str(caught.exception))

    def test_defaults_with_only_the_fee_recipient(self):
        settings = load_settings(BASE)
        self.assertEqual(settings.fee_recipient, '0x' + '2a' * 20)
        self.assertEqual((settings.relay_api_key, settings.across_api_key, settings.across_integrator_id), (None, None, None))
        self.assertEqual((settings.provider_timeout, settings.relay_per_minute, settings.across_per_minute), (10, 20, 10))
        self.assertEqual((settings.rpc_urls, settings.private_values()), ({}, ()))

    def test_the_fee_recipient_is_required_and_not_zero(self):
        for value in ('', 'not-an-address', '0x' + '00' * 20, '0x' + '2a' * 19):
            with self.subTest(value=value):
                self.refuse({'DOMINO_CROSSCHAIN_FEE_RECIPIENT': value}, 'fee_recipient')

    def test_keys_ids_and_limits(self):
        settings = load_settings({**BASE, 'DOMINO_RELAY_API_KEY': PRIVATE[0], 'DOMINO_ACROSS_API_KEY': PRIVATE[1],
                                  'DOMINO_ACROSS_INTEGRATOR_ID': '0xBEEF', 'DOMINO_CROSSCHAIN_PROVIDER_TIMEOUT_SECONDS': '7',
                                  'DOMINO_RELAY_REQUESTS_PER_MINUTE': '30'})
        self.assertEqual((settings.relay_api_key, settings.across_api_key, settings.across_integrator_id),
                         (PRIVATE[0], PRIVATE[1], '0xbeef'))
        self.assertEqual((settings.provider_timeout, settings.relay_per_minute, settings.across_per_minute), (7, 30, 60))
        self.assertNotIn(PRIVATE[0], repr(settings))
        self.assertNotIn(PRIVATE[1], repr(settings))
        self.refuse({**BASE, 'DOMINO_ACROSS_INTEGRATOR_ID': '0xdeadbeef'}, 'across_integrator_id')
        self.refuse({**BASE, 'DOMINO_RELAY_API_KEY': 'has space'}, 'relay_api_key')
        self.refuse({**BASE, 'DOMINO_CROSSCHAIN_PROVIDER_TIMEOUT_SECONDS': '60'}, 'crosschain_provider_timeout_seconds')
        self.refuse({**BASE, 'DOMINO_ACROSS_REQUESTS_PER_MINUTE': '0'}, 'across_requests_per_minute')

    def test_destination_rpc_urls_are_https_secrets(self):
        url = 'https://base-mainnet.example.invalid/v2/' + 'k' * 24
        settings = load_settings({**BASE, 'DOMINO_CROSSCHAIN_RPC_URL_8453': url})
        self.assertEqual(settings.rpc_urls, {8453: url})
        self.assertIn(url, settings.private_values())
        self.assertNotIn(url, repr(settings))
        userinfo = 'https://' + 'name:secret' + '@rpc.example.invalid/'
        for bad in ('http://rpc.example.invalid/', userinfo, 'https://rpc.example.invalid/#x', 'not a url'):
            with self.subTest(bad=bad[:12]):
                self.refuse({**BASE, 'DOMINO_CROSSCHAIN_RPC_URL_42161': bad}, 'rpc_url_42161')

    def test_systemd_credentials_take_precedence_over_the_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'relay-api-key').write_text(PRIVATE[0] + '\n')
            Path(directory, 'crosschain-rpc-4663').write_text('https://rpc.domino.money/' + 'z' * 20 + '/\n')
            settings = load_settings({**BASE, 'CREDENTIALS_DIRECTORY': directory, 'DOMINO_RELAY_API_KEY': 'from-environment'})
            self.assertEqual(settings.relay_api_key, PRIVATE[0])
            self.assertEqual(settings.rpc_urls[4663], 'https://rpc.domino.money/' + 'z' * 20 + '/')
            os.mkdir(Path(directory, 'across-api-key'))
            self.refuse({**BASE, 'CREDENTIALS_DIRECTORY': directory}, 'across_api_key')


if __name__ == '__main__':
    unittest.main()
