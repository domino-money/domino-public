"""Cloudflare Access service assertions. No wallet authentication or signing."""
import re
from threading import Lock, Thread
import time

import jwt

from discovery import DataError, json_http
from bridge_state import strict_json


class AccessVerifier:
    # Access's signing keys are read again REFRESH_SECONDS after the last read, in the
    # background: the cached keys keep answering meanwhile. Read on the request path, the
    # refresh cost the first requests after 5 quiet minutes ~450 ms each (27 Oct 2026, every
    # listener), and one that failed refused every request for 15 s while the cached keys
    # were still good. Known keys answer for STALE_SECONDS at most, the 4 hours Cloudflare
    # lets the certs be cached (max-age=14400). Older keys, an unknown kid (a rotation) and
    # the first request read them before answering, at most once per RETRY_SECONDS.
    REFRESH_SECONDS, STALE_SECONDS, RETRY_SECONDS = 300, 14_400, 15

    def __init__(self, issuer, audience, service_id, *, loader=None, clock=time.monotonic, spawn=None):
        if (not isinstance(issuer, str) or not re.fullmatch(r'https://[a-z0-9-]+\.cloudflareaccess\.com', issuer) or
                not isinstance(audience, str) or not re.fullmatch(r'[a-f0-9]{64}', audience) or
                not isinstance(service_id, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', service_id)):
            raise DataError('invalid_gateway_identity_config')
        self.issuer, self.audience, self.service_id = issuer, audience, service_id
        self.loader = loader or (lambda: json_http(issuer + '/cdn-cgi/access/certs', timeout=3))
        self.spawn = spawn or (lambda work: Thread(target=work, name='access-keys', daemon=True).start())
        self.clock, self.lock, self.keys = clock, Lock(), {}
        self.loaded_at, self.retry_at, self.refreshing = float('-inf'), float('-inf'), False

    def _load(self):
        try:
            data = self.loader()
            rows = data['keys']
            if not isinstance(rows, list) or not 1 <= len(rows) <= 8:
                raise ValueError()
            keys = {}
            for row in rows:
                key_id = row.get('kid')
                if (not isinstance(key_id, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', key_id) or
                        key_id in keys or row.get('kty') != 'RSA' or row.get('alg', 'RS256') != 'RS256' or
                        row.get('use', 'sig') != 'sig' or any(k in row for k in ('d','p','q','dp','dq','qi')) or
                        not isinstance(row.get('n'),str) or len(row['n']) > 684 or
                        not isinstance(row.get('e'),str) or len(row['e']) > 8):
                    raise ValueError()
                key = jwt.PyJWK.from_dict(row, algorithm='RS256').key
                if not 2048 <= key.key_size <= 4096:
                    raise ValueError()
                keys[key_id] = key
            return keys
        except Exception:
            # Only fixed status escapes; never library/provider diagnostics.
            raise DataError('service_identity_unavailable') from None

    def _refresh(self):
        """The background read: new keys replace the cached ones; a failure keeps them and waits RETRY_SECONDS."""
        try:
            keys = self._load()
        except DataError:
            keys = None
        with self.lock:
            now = self.clock()
            self.refreshing = False
            if keys is None:
                self.retry_at = now + self.RETRY_SECONDS
            else:
                self.keys, self.loaded_at = keys, now

    def _key(self, kid):
        with self.lock:
            now = self.clock()
            age = now - self.loaded_at
            if kid not in self.keys or age >= self.STALE_SECONDS:
                if now < self.retry_at:
                    raise DataError('service_identity_unavailable')
                self.retry_at = now + self.RETRY_SECONDS
                self.keys, self.loaded_at = self._load(), now
                if kid not in self.keys:
                    raise DataError('service_identity_invalid')
                return self.keys[kid]
            key = self.keys[kid]
            start = age >= self.REFRESH_SECONDS and not self.refreshing and now >= self.retry_at
            self.refreshing = self.refreshing or start
        # Started outside the lock, which the refresh takes to store what it read.
        if start:
            try:
                self.spawn(self._refresh)
            except Exception:
                with self.lock:
                    self.refreshing = False
        return key

    def verify(self, token):
        try:
            if not isinstance(token, str) or not 1 <= len(token) <= 8192:
                raise ValueError()
            header = jwt.get_unverified_header(token)
            if (header.get('alg') != 'RS256' or header.get('typ', 'JWT') != 'JWT' or
                    any(k in header for k in ('jku','x5u','jwk','crit'))):
                raise ValueError()
            kid = header['kid']
            if not isinstance(kid, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', kid):
                raise ValueError()
            # Reject duplicate/nonfinite header and payload keys before the library parser.
            import base64
            segments = token.split('.')
            if len(segments) != 3:
                raise ValueError()
            for segment in segments[:2]:
                strict_json(base64.urlsafe_b64decode(segment + '=' * (-len(segment) % 4)))
            claims = jwt.decode(token, self._key(kid), algorithms=['RS256'],
                                issuer=self.issuer, audience=self.audience,
                                options={'require': ['iss','aud','iat','exp','type','sub','common_name']})
            if (claims['type'] != 'app' or claims['sub'] != '' or
                    claims['common_name'] != self.service_id or
                    type(claims['iat']) is not int or type(claims['exp']) is not int or
                    claims['exp'] <= claims['iat']):
                raise ValueError()
            return True
        except DataError:
            raise
        except Exception:
            raise DataError('service_identity_invalid') from None
