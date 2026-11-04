import json
from pathlib import Path
import sys
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from bridge_identity import AccessVerifier
from discovery import DataError

ISSUER = 'https://test-team.cloudflareaccess.com'
AUDIENCE = 'a'*64
SERVICE = 'fixture-bff.access'


class IdentityFixtures:
    @classmethod
    def setUpClass(cls):
        cls.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.jwk = {**json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(cls.private.public_key())),
                   'kid': 'fixture-key', 'use': 'sig', 'alg': 'RS256'}

    def token(self, **changes):
        now = int(time.time())
        claims = {'iss': ISSUER, 'aud': [AUDIENCE], 'iat': now-1, 'exp': now+120,
                  'common_name': SERVICE, 'sub': '', 'type': 'app'}
        claims.update(changes)
        return jwt.encode(claims, self.private, algorithm='RS256', headers={'kid':'fixture-key'})

    def verifier(self):
        return AccessVerifier(ISSUER, AUDIENCE, SERVICE, loader=lambda: {'keys':[self.jwk]})


class AccessIdentityTests(IdentityFixtures, unittest.TestCase):
    def test_a_preview_only_identity_is_named_and_only_when_configured(self):
        """Review L1 (4 Nov 2026): a second, preview-only service id of the same Access application."""
        from bridge_identity import PREVIEW, PRODUCTION
        plain = self.verifier()
        self.assertEqual(plain.verify(self.token()), PRODUCTION)
        self.assertIsNone(plain.preview_service_id)
        with self.assertRaises(DataError):
            plain.verify(self.token(common_name='fixture-preview.access'))
        both = AccessVerifier(ISSUER, AUDIENCE, SERVICE, preview_service_id='fixture-preview.access',
                              loader=lambda: {'keys': [self.jwk]})
        self.assertEqual(both.verify(self.token()), PRODUCTION)
        self.assertEqual(both.verify(self.token(common_name='fixture-preview.access')), PREVIEW)
        for values in [{'common_name': 'other.access'}, {'common_name': 'fixture-preview.access', 'type': 'org'},
                       {'common_name': 'fixture-preview.access', 'sub': 'a-human-user'}]:
            with self.subTest(values=values), self.assertRaises(DataError):
                both.verify(self.token(**values))
        for value in (SERVICE, 'bad id!', '', 'x' * 129, 7):
            with self.subTest(value=value), self.assertRaises(DataError):
                AccessVerifier(ISSUER, AUDIENCE, SERVICE, preview_service_id=value)

    def test_each_origin_is_carried_by_its_own_identity(self):
        """The preview identity never carries the canonical origin; with it configured, production carries only that."""
        from types import SimpleNamespace
        from bridge_identity import PREVIEW, PRODUCTION, identity_carries
        canonical, preview = 'https://domino.money', 'https://preview.domino-app-e65.pages.dev'
        single, paired = SimpleNamespace(preview_service_id=None), SimpleNamespace(preview_service_id='fixture-preview')
        self.assertEqual({(verifier is paired, identity, origin): identity_carries(verifier, identity, origin, canonical)
                          for verifier in (single, paired) for identity in (PRODUCTION, PREVIEW)
                          for origin in (canonical, preview)},
                         {(False, PRODUCTION, canonical): True, (False, PRODUCTION, preview): True,
                          (False, PREVIEW, canonical): False, (False, PREVIEW, preview): True,
                          (True, PRODUCTION, canonical): True, (True, PRODUCTION, preview): False,
                          (True, PREVIEW, canonical): False, (True, PREVIEW, preview): True})

    def test_a_malformed_preview_identity_setting_is_off_and_said_so(self):
        """Review L3: never a reason to stop the listener; production keeps serving."""
        import io
        from bridge_identity import configured_preview_identity
        for value, expected in ((None, None), ('', None), ('fixture-preview.access', 'fixture-preview.access')):
            stream = io.StringIO()
            self.assertEqual(configured_preview_identity(value, SERVICE, 'X_ID', stream=stream), expected)
            self.assertEqual(stream.getvalue(), '')
        for value in (SERVICE, 'bad id!', 'x' * 129, 7, ['a']):
            stream = io.StringIO()
            self.assertIsNone(configured_preview_identity(value, SERVICE, 'X_ID', stream=stream))
            self.assertEqual(stream.getvalue(), '<3>X_ID is malformed: the preview Access identity is off, production serves.\n')

    def test_actual_rs256_signature_and_service_claim_binding(self):
        verifier = self.verifier()
        self.assertTrue(verifier.verify(self.token()))
        for values in [{'aud': ['b'*64]}, {'iss':'https://evil.example'}, {'common_name':'other.access'},
                       {'sub':'a-human-user'}, {'type':'org'}, {'exp':int(time.time())-1},
                       {'iat':int(time.time())+60}, {'exp':str(int(time.time())+120)}]:
            with self.subTest(values=values), self.assertRaises(DataError): verifier.verify(self.token(**values))

    def test_key_url_header_algorithm_tampering_and_bad_config(self):
        verifier = self.verifier()
        valid = self.token()
        for token in [valid[:-12]+'AAAAAAAAAAAA', 'a.b.c', 'x'*8193,
                      jwt.encode({'iss':ISSUER}, 'not-a-real-key-but-at-least-32-bytes', algorithm='HS256', headers={'kid':'fixture-key'}),
                      jwt.encode({'iss':ISSUER}, self.private, algorithm='RS256', headers={'kid':'fixture-key','jku':'https://evil.example'})]:
            with self.assertRaises(DataError): verifier.verify(token)
        for issuer in ['https://evil.example', 'http://test-team.cloudflareaccess.com', ISSUER+'/extra']:
            with self.assertRaises(DataError): AccessVerifier(issuer,AUDIENCE,SERVICE)

    def test_new_key_rotation_unknown_kid_cooldown_and_old_key_removal(self):
        now, calls = [0.], []
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        replacement = {**json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key())),
                       'kid':'rotated-key', 'use':'sig', 'alg':'RS256'}
        rows = [self.jwk]
        def loader():
            calls.append(True)
            return {'keys':rows}
        verifier = AccessVerifier(ISSUER,AUDIENCE,SERVICE,loader=loader,clock=lambda:now[0])
        self.assertTrue(verifier.verify(self.token()))
        claims = jwt.decode(self.token(), options={'verify_signature':False})
        rotated = jwt.encode(claims, private, algorithm='RS256', headers={'kid':'rotated-key'})
        rows = [replacement]
        now[0] = 1
        with self.assertRaises(DataError): verifier.verify(rotated)
        self.assertEqual(len(calls), 1)
        now[0] = 16
        self.assertTrue(verifier.verify(rotated))
        self.assertEqual(len(calls), 2)
        with self.assertRaises(DataError): verifier.verify(self.token())
        self.assertEqual(len(calls), 2)
        now[0] = 32
        with self.assertRaisesRegex(DataError, '^service_identity_invalid$'): verifier.verify(self.token())
        self.assertEqual(len(calls), 3)
        self.assertTrue(verifier.verify(rotated))

    def background(self, now, rows, calls, spawned):
        def load():
            calls.append(True)
            if rows[0] is None: raise OSError('PRIVATE PROVIDER DIAGNOSTIC')
            return {'keys':rows[0]}
        return AccessVerifier(ISSUER,AUDIENCE,SERVICE,loader=load,clock=lambda:now[0],spawn=spawned.append)

    def test_stale_keys_answer_at_once_while_one_background_refresh_runs(self):
        now, rows, calls, spawned = [0.], [[self.jwk]], [], []
        verifier = self.background(now, rows, calls, spawned)
        self.assertTrue(verifier.verify(self.token()))
        now[0] = 299
        self.assertTrue(verifier.verify(self.token()))
        self.assertEqual((len(calls), len(spawned)), (1, 0))
        now[0] = 300
        self.assertTrue(verifier.verify(self.token()))
        self.assertTrue(verifier.verify(self.token()))
        self.assertEqual((len(calls), len(spawned)), (1, 1))
        now[0] = 310
        spawned[0]()
        self.assertEqual(len(calls), 2)
        now[0] = 609
        self.assertTrue(verifier.verify(self.token()))
        self.assertEqual(len(spawned), 1)
        now[0] = 610
        self.assertTrue(verifier.verify(self.token()))
        self.assertEqual((len(calls), len(spawned)), (2, 2))

    def test_failed_refresh_keeps_known_keys_until_stale_then_cooldown_and_recovery(self):
        now, rows, calls, spawned = [0.], [[self.jwk]], [], []
        verifier = self.background(now, rows, calls, spawned)
        self.assertTrue(verifier.verify(self.token()))
        now[0] = 300
        self.assertTrue(verifier.verify(self.token()))
        rows[0] = None
        now[0] = 301
        spawned[0]()
        now[0] = 315
        self.assertTrue(verifier.verify(self.token()))
        self.assertEqual((len(calls), len(spawned)), (2, 1))
        now[0] = 316
        self.assertTrue(verifier.verify(self.token()))
        self.assertEqual(len(spawned), 2)
        spawned[1]()
        now[0] = AccessVerifier.STALE_SECONDS - 1
        self.assertTrue(verifier.verify(self.token()))
        self.assertEqual(len(calls), 3)
        now[0] = AccessVerifier.STALE_SECONDS
        with self.assertRaisesRegex(DataError, '^service_identity_unavailable$'): verifier.verify(self.token())
        self.assertEqual(len(calls), 4)
        now[0] = AccessVerifier.STALE_SECONDS + 14
        with self.assertRaisesRegex(DataError, '^service_identity_unavailable$'): verifier.verify(self.token())
        self.assertEqual(len(calls), 4)
        rows[0] = [self.jwk]
        now[0] = AccessVerifier.STALE_SECONDS + 15
        self.assertTrue(verifier.verify(self.token()))
        self.assertEqual(len(calls), 5)

    def test_a_refresh_that_cannot_start_never_refuses_a_request(self):
        now, rows, calls, attempts = [0.], [[self.jwk]], [], []
        def spawn(work):
            attempts.append(work)
            raise RuntimeError('cannot start new thread')
        verifier = self.background(now, rows, calls, [])
        verifier.spawn = spawn
        self.assertTrue(verifier.verify(self.token()))
        now[0] = 300
        self.assertTrue(verifier.verify(self.token()))
        self.assertTrue(verifier.verify(self.token()))
        self.assertEqual((len(calls), len(attempts)), (1, 2))

    def test_the_default_refresh_runs_on_its_own_thread(self):
        now, threads, done = [0.], [], threading.Event()
        def load():
            threads.append(threading.current_thread())
            if len(threads) == 2: done.set()
            return {'keys':[self.jwk]}
        verifier = AccessVerifier(ISSUER,AUDIENCE,SERVICE,loader=load,clock=lambda:now[0])
        self.assertTrue(verifier.verify(self.token()))
        now[0] = 300
        self.assertTrue(verifier.verify(self.token()))
        self.assertTrue(done.wait(5))
        self.assertIs(threads[0], threading.current_thread())
        self.assertEqual((threads[1].name, threads[1].daemon), ('access-keys', True))


if __name__ == '__main__': unittest.main()
