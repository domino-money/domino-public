import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import configure_uniswap
from discovery import DataError, json_http
from uniswap_config import checked, load_config, save_config

SECRET = 'offline-uniswap-test-key'


class UniswapConfigTests(unittest.TestCase):
    def test_private_roundtrip_and_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'runtime' / 'uniswap-api.json'
            self.assertEqual(load_config(path), {})
            for key in (SECRET, SECRET + '-replacement'):
                data = {'version': 1, 'apiKey': key}
                save_config(data, path)
                self.assertEqual(load_config(path), data)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual([p.name for p in path.parent.iterdir()], ['uniswap-api.json'])

    def test_insecure_file_and_symlink_are_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'key.json'
            data = {'version': 1, 'apiKey': SECRET}
            save_config(data, path)
            path.chmod(0o644)
            with self.assertRaisesRegex(DataError, 'uniswap_config_permissions'):
                save_config({'version': 1, 'apiKey': 'replacement'}, path)
            self.assertEqual(json.loads(path.read_text()), data)
            path.chmod(0o600)
            link = Path(directory) / 'link.json'
            link.symlink_to(path)
            for action in (lambda: load_config(link), lambda: save_config(data, link)):
                with self.assertRaises(DataError):
                    action()
            self.assertEqual(load_config(path), data)

    def test_insecure_parent_and_nonregular_file_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory) / 'runtime'
            parent.mkdir(mode=0o755)
            with self.assertRaisesRegex(DataError, 'uniswap_directory_permissions'):
                save_config({'version': 1, 'apiKey': SECRET}, parent / 'key.json')
            fifo = Path(directory) / 'fifo'
            os.mkfifo(fifo, mode=0o600)
            with self.assertRaisesRegex(DataError, 'uniswap_config_permissions'):
                load_config(fifo)

    def test_invalid_config_and_key_do_not_echo_input(self):
        for data in ({'version': True, 'apiKey': SECRET},
                     {'version': 1, 'apiKey': SECRET, 'privateKey': SECRET},
                     {'version': 1, 'apiKey': SECRET + '\nInjected: value'},
                     {'version': 1, 'apiKey': ' '},
                     {'version': 1, 'apiKey': 'x' * 513}):
            with self.assertRaises(DataError) as raised:
                checked(data)
            self.assertNotIn(SECRET, str(raised.exception))

    def test_malformed_and_oversized_file_errors_are_sanitized(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'key.json'
            for text in (SECRET, 'x' * 4097):
                path.write_text(text)
                path.chmod(0o600)
                with self.assertRaises(DataError) as raised:
                    load_config(path)
                self.assertNotIn(SECRET, str(raised.exception))

    def run_configurator(self, path, *, interactive=True, error=None):
        output = io.StringIO()
        with patch.object(sys, 'argv', ['configure_uniswap', '--config-file', str(path)]), \
                patch.object(sys.stdin, 'isatty', return_value=interactive), \
                patch.object(configure_uniswap.getpass, 'getpass', return_value=SECRET) as prompt, \
                patch.object(configure_uniswap, 'probe', side_effect=error) as probe_, \
                contextlib.redirect_stdout(output):
            result = configure_uniswap.main()
        self.assertNotIn(SECRET, output.getvalue())
        return result, prompt, probe_, output.getvalue()

    def test_interactive_read_probe_precedes_save(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'key.json'
            def read_probe(key):
                self.assertEqual(key, SECRET)
                self.assertFalse(path.exists())
            result, prompt, probe_, output = self.run_configurator(path, error=read_probe)
            self.assertEqual(result, 0)
            prompt.assert_called_once()
            probe_.assert_called_once_with(SECRET)
            self.assertEqual(load_config(path)['apiKey'], SECRET)
            self.assertIn('Pool consultada com sucesso', output)

    def test_noninteractive_run_never_requests_key_or_network(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'key.json'
            result, prompt, probe_, _ = self.run_configurator(path, interactive=False)
            self.assertEqual(result, 1)
            prompt.assert_not_called()
            probe_.assert_not_called()
            self.assertFalse(path.exists())

    def test_probe_failure_preserves_existing_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'key.json'
            existing = {'version': 1, 'apiKey': 'previous-offline-key'}
            save_config(existing, path)
            result, _, _, output = self.run_configurator(path, error=DataError('http_401'))
            self.assertEqual(result, 1)
            self.assertIn('http_401', output)
            self.assertEqual(load_config(path), existing)

    def test_private_header_input_cannot_inject_headers(self):
        for headers in ([], '', {'Authorization': SECRET}, {'x-api-key': SECRET + '\r\nX: value'}):
            opener = Mock()
            with self.assertRaisesRegex(DataError, 'invalid_private_api_header'):
                json_http('https://liquidity.api.uniswap.org/lp/pool_info', {},
                          headers=headers, opener=opener)
            opener.assert_not_called()


if __name__ == '__main__':
    unittest.main()
