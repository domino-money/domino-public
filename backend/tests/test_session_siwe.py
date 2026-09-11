"""Synthetic SIWE identities only; no provider or operational key access."""
from datetime import datetime, timedelta, timezone
from importlib.metadata import version
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_account import Account
from eth_account.messages import encode_defunct
from siwe import SiweMessage

from discovery import DataError
from read_deadline import read_deadline
from session_models import SessionError
from session_siwe import MAX_MESSAGE_BYTES, STATEMENT, SiwePolicy


class SiweTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
        # Deliberately public deterministic test material, never a funded wallet.
        self.account = Account.from_key(bytes([1]) * 32)
        self.other = Account.from_key(bytes([2]) * 32)
        self.policy = SiwePolicy('https://domino.money', clock=lambda: self.now)
        self.expected = dict(address=self.account.address.lower(), nonce='ab' * 16,
                             issued_at=self.now, expires_at=self.now + timedelta(minutes=5))
        self.message = self.policy.issue(**self.expected)
        self.signature = self.sign(self.message)

    def sign(self, message, account=None):
        value = Account.sign_message(encode_defunct(text=message), (account or self.account).key)
        return '0x' + value.signature.hex()

    def verify(self, message=None, signature=None, **expected):
        return self.policy.verify(self.message if message is None else message,
                                  self.signature if signature is None else signature,
                                  **{**self.expected, **expected})

    def test_exact_library_versions_and_canonical_fields(self):
        for package, pinned in (('siwe', '4.4.0'), ('eth-account', '0.13.7'),
                                ('web3', '7.16.0'), ('abnf', '2.2.0')):
            self.assertEqual(version(package), pinned)
        parsed = SiweMessage.from_message(self.message, abnf=True)
        self.assertEqual(parsed.scheme, 'https')
        self.assertEqual(parsed.domain, 'domino.money')
        self.assertEqual(parsed.uri, 'https://domino.money/')
        self.assertEqual(parsed.address, self.account.address)
        self.assertEqual(parsed.chain_id, 4663)
        self.assertEqual(parsed.statement, STATEMENT)
        self.assertEqual(parsed.issued_at, '2026-09-10T12:00:00Z')
        self.assertEqual(parsed.expiration_time, '2026-09-10T12:05:00Z')
        self.assertIsNone(parsed.resources)
        self.assertIsNone(parsed.request_id)
        self.assertIsNone(parsed.not_before)
        self.assertEqual(parsed.prepare_message(), self.message)
        self.assertIsNone(self.verify())

    def test_every_message_binding_rejects_even_a_valid_signature(self):
        changes = [self.message.replace('domino.money', 'sibling.domino.money'),
                   self.message.replace('URI: https://domino.money/', 'URI: https://domino.money/settings'),
                   self.message.replace('https://', 'http://'),
                   self.message.replace(self.account.address, self.other.address),
                   self.message.replace('Chain ID: 4663', 'Chain ID: 1'),
                   self.message.replace('Version: 1', 'Version: 2'),
                   self.message.replace('ab' * 16, 'cd' * 16),
                   self.message.replace(STATEMENT, 'Approve spending'),
                   self.message.replace('12:00:00Z', '11:59:59Z'),
                   self.message.replace('12:05:00Z', '12:06:00Z'),
                   self.message + '\nResources:\n- https://domino.money/settings',
                   self.message + '\nRequest ID: changed', self.message + '\n',
                   self.message.replace('\n', '\r\n')]
        for message in changes:
            with self.subTest(change=changes.index(message)), self.assertRaisesRegex(SessionError, '^challenge_invalid$'):
                self.verify(message, self.sign(message))
        for field, value in (('address', self.other.address), ('nonce', 'cd' * 16),
                             ('issued_at', self.now-timedelta(seconds=1)),
                             ('expires_at', self.now+timedelta(seconds=299))):
            with self.subTest(field=field), self.assertRaisesRegex(SessionError, '^challenge_invalid$'):
                self.verify(**{field: value})

    def test_signature_failure_has_fixed_code_and_no_rpc_fallback(self):
        with patch('siwe.siwe.Web3', side_effect=AssertionError('no Web3 construction')), \
             patch('siwe.siwe.check_contract_wallet_signature', side_effect=AssertionError('no ERC1271')):
            self.assertIsNone(self.verify())
            with self.assertRaisesRegex(SessionError, '^invalid_signature$'):
                self.verify(signature=self.sign(self.message, self.other))
            with self.assertRaisesRegex(SessionError, '^invalid_signature$'):
                self.verify(signature='0x'+'00'*64+'1b')

    def test_unsupported_and_oversized_signature_formats_are_bounded_before_parser(self):
        for signature in ('0x', '0x'+'aa'*64, '0x'+'aa'*66, '0x'+'aa'*4000,
                          '0x'+'00'*64+'ff', self.signature+'6492', None, True):
            with self.subTest(length=len(signature) if isinstance(signature,str) else None), \
                 patch('session_siwe.SiweMessage.from_message', side_effect=AssertionError('parser must not run')), \
                 self.assertRaisesRegex(SessionError, '^invalid_signature$'):
                self.verify(signature=signature if signature is not None else False)

    def test_message_bytes_unicode_and_unknown_fields_are_bounded_before_parser(self):
        for message in ('x'*(MAX_MESSAGE_BYTES+1), 'é'*1025, '\ud800', '',
                        self.message+'\nNonce: duplicated', False):
            with patch('session_siwe.SiweMessage.from_message', side_effect=AssertionError('parser must not run')), \
                 self.assertRaisesRegex(SessionError, '^challenge_invalid$'):
                self.verify(message=message)

    def test_old_future_and_exact_expiry_boundaries(self):
        self.now -= timedelta(microseconds=1)
        with self.assertRaisesRegex(SessionError, '^challenge_invalid$'): self.verify()
        self.now = self.expected['expires_at']-timedelta(microseconds=1)
        self.assertIsNone(self.verify())
        self.now = self.expected['expires_at']
        with self.assertRaisesRegex(SessionError, '^challenge_invalid$'): self.verify()
        self.now += timedelta(days=1)
        with self.assertRaisesRegex(SessionError, '^challenge_invalid$'): self.verify()

    def test_expiry_and_request_deadline_rechecked_after_recovery(self):
        real_recover = Account.recover_message
        def expires(*args, **kwargs):
            self.now = self.expected['expires_at']
            return real_recover(*args, **kwargs)
        with patch('session_siwe.Account.recover_message', side_effect=expires), \
             self.assertRaisesRegex(SessionError, '^challenge_invalid$'):
            self.verify()
        self.now = self.expected['issued_at']
        elapsed = [0.0]
        def late(*args, **kwargs):
            elapsed[0] = 2
            return real_recover(*args, **kwargs)
        with read_deadline(1, clock=lambda: elapsed[0]):
            with patch('session_siwe.Account.recover_message', side_effect=late), \
                 self.assertRaisesRegex(DataError, '^read_deadline_exceeded$'):
                self.verify()
            elapsed[0] = 0  # Permit the outer test-only context to close.

    def test_invalid_server_policy_fields_never_enter_message(self):
        for origin in ('http://domino.money', 'https://domino.money/', 'https://DOMINO.money',
                       'https://domino.money:443', 'https://user@domino.money',
                       'https://domino.money?x', 'https://domino.money#x', None):
            with self.assertRaisesRegex(ValueError, '^invalid_session_origin$'): SiwePolicy(origin)
        for fields in ({'nonce':'short'}, {'nonce':'a'*65}, {'nonce':'a'*31+'\n'},
                       {'address':'invalid'}, {'issued_at':self.now.replace(tzinfo=None)},
                       {'issued_at':self.now.replace(microsecond=1)},
                       {'expires_at':self.now}, {'expires_at':self.now+timedelta(seconds=301)}):
            with self.assertRaisesRegex(SessionError, '^challenge_invalid$'):
                self.policy.issue(**{**self.expected, **fields})


if __name__ == '__main__': unittest.main()
