"""The automation's signer keys from encrypted keystores and systemd credentials."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_account import Account

import automation_cli
import automation_keys as keys
from automation_config import validate_config
from automation_fixtures import sample_config
from execution_signer import ExecutionError

OPERATOR_KEY = bytes.fromhex('11' * 32)
OTHER_KEY = bytes.fromhex('22' * 32)
OPERATOR = Account.from_key(OPERATOR_KEY).address.lower()
PASSWORD = 'correct horse battery staple'


def keystore(key, password=PASSWORD):
    """A V3 scrypt keystore, with a small cost so the test runs fast (the loader admits any power of two up to 2**18)."""
    return Account.encrypt(key, password, kdf='scrypt', iterations=2**10)


class KeystoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix='domino-automation-keys-')).resolve()
        self.addCleanup(shutil.rmtree, self.temp)
        self.private = self.temp / 'private'
        self.private.mkdir(mode=0o700)
        self.credentials = self.temp / 'credentials'
        self.credentials.mkdir(mode=0o500)
        os.chmod(self.credentials, 0o700)
        self.addCleanup(os.chmod, self.credentials, 0o700)
        environment = patch.dict(os.environ, {'CREDENTIALS_DIRECTORY': str(self.credentials)})
        environment.start()
        self.addCleanup(environment.stop)

    def place(self, document, name='operator.keystore.json', mode=0o600):
        path = self.private / name
        path.write_text(json.dumps(document) if not isinstance(document, str) else document)
        os.chmod(path, mode)
        return str(path)

    def secret(self, value, name='operator-keystore-password'):
        path = self.credentials / name
        path.write_bytes(value)
        os.chmod(path, 0o400)
        return path

    def test_the_role_key_from_its_keystore_and_its_credential(self):
        path = self.place(keystore(OPERATOR_KEY))
        self.secret(PASSWORD.encode() + b'\n')  # systemd-ask-password | systemd-creds keeps one newline
        self.assertEqual(keys.keystore_key(path, 'operator-keystore-password', OPERATOR), OPERATOR_KEY)

    def test_another_accounts_keystore_is_refused_before_any_key_derivation(self):
        path = self.place(keystore(OTHER_KEY))
        self.secret(PASSWORD.encode())
        with patch.object(keys.Account, 'decrypt', side_effect=AssertionError('derived')):
            with self.assertRaisesRegex(ExecutionError, 'automation_keystore_address_mismatch'):
                keys.keystore_key(path, 'operator-keystore-password', OPERATOR)
        # A keystore whose address field was edited to the role's still decrypts to the other key: refused after.
        forged = keystore(OTHER_KEY)
        forged['address'] = OPERATOR[2:]
        path = self.place(forged)
        with self.assertRaisesRegex(ExecutionError, 'automation_keystore_address_mismatch'):
            keys.keystore_key(path, 'operator-keystore-password', OPERATOR)

    def test_a_keystore_that_names_no_address_as_foundry_writes_it_is_checked_after_derivation(self):
        # cast wallet import (Foundry 1.8.3) writes crypto, id and version, and no address.
        path = self.place({key: value for key, value in keystore(OPERATOR_KEY).items() if key != 'address'})
        self.secret(PASSWORD.encode())
        self.assertEqual(keys.keystore_key(path, 'operator-keystore-password', OPERATOR), OPERATOR_KEY)
        path = self.place({key: value for key, value in keystore(OTHER_KEY).items() if key != 'address'})
        with self.assertRaisesRegex(ExecutionError, 'automation_keystore_address_mismatch'):
            keys.keystore_key(path, 'operator-keystore-password', OPERATOR)
        # Named, it must be a string naming the role, before anything is derived.
        path = self.place({**keystore(OPERATOR_KEY), 'address': None})
        with patch.object(keys.Account, 'decrypt', side_effect=AssertionError('derived')):
            with self.assertRaisesRegex(ExecutionError, 'automation_keystore_address_mismatch'):
                keys.keystore_key(path, 'operator-keystore-password', OPERATOR)

    def test_a_wrong_password_names_itself(self):
        path = self.place(keystore(OPERATOR_KEY))
        self.secret(b'not the password')
        with self.assertRaisesRegex(ExecutionError, 'automation_keystore_password'):
            keys.keystore_key(path, 'operator-keystore-password', OPERATOR)

    def test_the_scrypt_cost_and_format_are_bounded_before_any_derivation(self):
        self.secret(PASSWORD.encode())
        base = keystore(OPERATOR_KEY)
        def changed(**params):
            document = json.loads(json.dumps(base))
            document['crypto']['kdfparams'].update(params)
            return document
        pbkdf2 = json.loads(json.dumps(base)); pbkdf2['crypto']['kdf'] = 'pbkdf2'
        cipher = json.loads(json.dumps(base)); cipher['crypto']['cipher'] = 'aes-128-cbc'
        old = json.loads(json.dumps(base)); old['version'] = 1
        for label, document in (('n above geth', changed(n=2**19)), ('n not a power of two', changed(n=3000)),
                                ('r', changed(r=16)), ('p', changed(p=2)), ('dklen', changed(dklen=64)),
                                ('kdf', pbkdf2), ('cipher', cipher), ('version', old)):
            path = self.place(document)
            with self.subTest(label), patch.object(keys.Account, 'decrypt', side_effect=AssertionError('derived')):
                with self.assertRaisesRegex(ExecutionError, 'automation_keystore_invalid'):
                    keys.keystore_key(path, 'operator-keystore-password', OPERATOR)
        # geth's own cost is admitted.
        keys.checked_keystore(json.dumps(changed(n=2**18)).encode(), OPERATOR)
        duplicate = self.place('{"version":3,"version":3}')
        with self.assertRaisesRegex(ExecutionError, 'automation_keystore_invalid'):
            keys.keystore_key(duplicate, 'operator-keystore-password', OPERATOR)

    def test_the_credential_is_the_units_own_file(self):
        path = self.place(keystore(OPERATOR_KEY))
        with self.assertRaisesRegex(ExecutionError, 'automation_keystore_credential_missing'):
            keys.keystore_key(path, 'operator-keystore-password', OPERATOR)  # absent
        # A name outside the pattern is refused even when a file by that name exists, inside the directory or beside it.
        (self.temp / 'operator-keystore-password').write_bytes(PASSWORD.encode())
        for name in ('Operator', '../operator-keystore-password', '', 'a' * 64):
            if name and '/' not in name:
                (self.credentials / name).write_bytes(PASSWORD.encode())
            with self.subTest(name=name), self.assertRaisesRegex(ExecutionError, 'automation_keystore_credential_missing'):
                keys.credential(name)
        self.secret(b'')
        with self.assertRaisesRegex(ExecutionError, 'automation_keystore_credential_missing'):
            keys.keystore_key(path, 'operator-keystore-password', OPERATOR)  # empty
        (self.credentials / 'operator-keystore-password').unlink()
        self.secret(b'x' * (keys.MAX_PASSWORD_BYTES + 1))
        with self.assertRaisesRegex(ExecutionError, 'automation_keystore_credential_missing'):
            keys.keystore_key(path, 'operator-keystore-password', OPERATOR)  # oversized
        (self.credentials / 'operator-keystore-password').unlink()
        elsewhere = self.temp / 'elsewhere'
        elsewhere.write_bytes(PASSWORD.encode())
        (self.credentials / 'operator-keystore-password').symlink_to(elsewhere)
        with self.assertRaisesRegex(ExecutionError, 'automation_keystore_credential_missing'):
            keys.keystore_key(path, 'operator-keystore-password', OPERATOR)  # a link
        with patch.dict(os.environ, {'CREDENTIALS_DIRECTORY': ''}):
            with self.assertRaisesRegex(ExecutionError, 'automation_keystore_credential_missing'):
                keys.credential('operator-keystore-password')

    def test_a_keystore_others_can_read_is_refused(self):
        path = self.place(keystore(OPERATOR_KEY), mode=0o644)
        self.secret(PASSWORD.encode())
        with self.assertRaisesRegex(ExecutionError, 'execution_private_configuration'):
            keys.keystore_key(path, 'operator-keystore-password', OPERATOR)

    def test_the_cli_loads_each_signer_from_what_its_configuration_names(self):
        path = self.place(keystore(OPERATOR_KEY))
        self.secret(PASSWORD.encode())
        signer = validate_config(sample_config(operator={'keyFile': None, 'keystore': path,
                                                         'passwordCredential': 'operator-keystore-password'})).operator
        self.assertEqual(automation_cli.signer_key(signer, OPERATOR), OPERATOR_KEY)
        hexfile = self.private / 'publisher.key'
        hexfile.write_text(OTHER_KEY.hex() + '\n')
        os.chmod(hexfile, 0o600)
        plain = validate_config(sample_config(publisher={'keyFile': str(hexfile)})).publisher
        self.assertEqual(automation_cli.signer_key(plain, Account.from_key(OTHER_KEY).address.lower()), OTHER_KEY)


class SignerKeyConfigTests(unittest.TestCase):
    def test_a_signer_names_one_key_and_the_two_signers_never_share_one(self):
        keystore_signer = {'keyFile': None, 'keystore': '/run/c/operator.keystore.json', 'passwordCredential': 'operator-keystore-password'}
        validate_config(sample_config(operator=keystore_signer))
        for label, signer in (('both', {**keystore_signer, 'keyFile': '/run/c/operator.key'}),
                              ('neither', {'keyFile': None}),
                              ('keystore without its credential', {**keystore_signer, 'passwordCredential': None}),
                              ('credential without a keystore', {'passwordCredential': 'operator-keystore-password'}),
                              ('credential name', {**keystore_signer, 'passwordCredential': 'Operator Password'})):
            with self.subTest(label), self.assertRaises(ValueError):
                validate_config(sample_config(operator=signer))
        shared = {'keyFile': None, 'keystore': '/run/c/publisher.keystore.json', 'passwordCredential': 'operator-keystore-password'}
        with self.assertRaisesRegex(ValueError, 'operator_publisher_key_not_separate'):
            validate_config(sample_config(operator=keystore_signer, publisher=shared))
        with self.assertRaisesRegex(ValueError, 'operator_publisher_key_not_separate'):
            validate_config(sample_config(operator=keystore_signer, publisher={'keyFile': None, 'keystore': '/run/c/operator.keystore.json',
                                                                            'passwordCredential': 'publisher-keystore-password'}))


if __name__ == '__main__':
    unittest.main()
