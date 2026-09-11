import json
from pathlib import Path
import sys
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

    def test_stale_key_refresh_failure_cooldown_and_recovery(self):
        now = [0.]
        calls = []
        rows = [self.jwk]
        def load():
            calls.append(True)
            if rows is None: raise OSError('PRIVATE PROVIDER DIAGNOSTIC')
            return {'keys':rows}
        verifier = AccessVerifier(ISSUER,AUDIENCE,SERVICE,loader=load,clock=lambda:now[0])
        self.assertTrue(verifier.verify(self.token()))
        now[0] = 301
        rows = None
        with self.assertRaisesRegex(DataError, '^service_identity_unavailable$'): verifier.verify(self.token())
        with self.assertRaises(DataError): verifier.verify(self.token())
        self.assertEqual(len(calls),2)
        now[0] = 317
        rows = [self.jwk]
        self.assertTrue(verifier.verify(self.token()))
        self.assertEqual(len(calls),3)


if __name__ == '__main__': unittest.main()
