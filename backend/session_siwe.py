"""Exact server-issued SIWE messages and local EIP-191 verification only.

The official siwe 4.4.0 ABNF parser/serializer supplies the message grammar;
eth-account 0.13.7 supplies signature recovery. We deliberately do not call
SiweMessage.verify: its optional Web3/contract-wallet path is outside the
plain-EOA policy. No provider, private key, environment or credential is read.
Replay prevention and browser binding belong to the transactional session store.
Sources: https://github.com/spruceid/siwe-py and https://eips.ethereum.org/EIPS/eip-4361.
"""
from datetime import datetime, timedelta, timezone
import hmac
import re
import sys
from urllib.parse import urlsplit

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import to_checksum_address
from siwe import SiweMessage

from discovery import CHAIN_ID, address as normalized_address
from read_deadline import check_read_deadline
from session_models import SessionError


MAX_MESSAGE_BYTES = 2048
MAX_CHALLENGE_SECONDS = 300
STATEMENT = 'Sign in to Domino. This request does not authorize transactions or automation.'
# Launch round P3 (4 Nov 2026), item 7, testing without real money: a listener may also admit a few exact Pages
# preview origins besides its canonical one (preview_origins below).
MAX_PREVIEW_ORIGINS = 4


def _utc_now():
    return datetime.now(timezone.utc)


def _timestamp(value):
    if (not isinstance(value, datetime) or value.tzinfo is None
            or value.utcoffset() != timedelta(0) or value.microsecond):
        raise SessionError('challenge_invalid')
    return value.isoformat(timespec='seconds').replace('+00:00', 'Z')


class SiwePolicy:
    def __init__(self, origin, *, clock=_utc_now):
        # A canonical deployment origin, never a request-controlled URI/Host.
        try:
            parsed = urlsplit(origin)
            valid = (isinstance(origin, str) and len(origin) <= 261
                     and re.fullmatch(r'https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', origin)
                     and origin == 'https://' + parsed.netloc
                     and parsed.netloc == parsed.hostname)
        except (ValueError, TypeError, AttributeError):
            valid = False
        if not valid:
            raise ValueError('invalid_session_origin')
        self.origin, self.domain, self.uri = origin, parsed.netloc, origin + '/'
        self.clock = clock

    def _expected(self, address, nonce, issued_at, expires_at):
        try:
            owner = to_checksum_address(normalized_address(address))
            if not isinstance(nonce, str) or not re.fullmatch(r'[A-Za-z0-9]{32,64}', nonce):
                raise SessionError('challenge_invalid')
            issued, expires = _timestamp(issued_at), _timestamp(expires_at)
            if not timedelta(0) < expires_at - issued_at <= timedelta(seconds=MAX_CHALLENGE_SECONDS):
                raise SessionError('challenge_invalid')
            return SiweMessage(scheme='https', domain=self.domain, address=owner,
                               statement=STATEMENT, uri=self.uri, version='1',
                               chain_id=CHAIN_ID, nonce=nonce, issued_at=issued,
                               expiration_time=expires)
        except SessionError:
            raise
        except Exception:
            raise SessionError('challenge_invalid') from None

    def issue(self, address, nonce, issued_at, expires_at):
        check_read_deadline()
        message = self._expected(address, nonce, issued_at, expires_at).prepare_message()
        if len(message.encode('utf-8')) > MAX_MESSAGE_BYTES:
            raise SessionError('challenge_invalid')
        check_read_deadline()
        return message

    def _check_time(self, issued_at, expires_at):
        try:
            now = self.clock()
            valid = (isinstance(now, datetime) and now.tzinfo is not None
                     and now.utcoffset() == timedelta(0) and issued_at <= now < expires_at)
        except Exception:
            valid = False
        if not valid:
            raise SessionError('challenge_invalid')

    def verify(self, message, signature, *, address, nonce, issued_at, expires_at):
        check_read_deadline()
        try:
            if not isinstance(message, str) or len(message) > MAX_MESSAGE_BYTES:
                raise SessionError('challenge_invalid')
            raw = message.encode('utf-8')
            if len(raw) > MAX_MESSAGE_BYTES:
                raise SessionError('challenge_invalid')
        except UnicodeError:
            raise SessionError('challenge_invalid') from None
        if (not isinstance(signature, str)
                or not re.fullmatch(r'0x[0-9a-fA-F]{130}', signature)
                or int(signature[-2:], 16) not in (0, 1, 27, 28)):
            raise SessionError('invalid_signature')
        expected = self._expected(address, nonce, issued_at, expires_at)
        if not hmac.compare_digest(raw, expected.prepare_message().encode('utf-8')):
            raise SessionError('challenge_invalid')
        self._check_time(issued_at, expires_at)
        try:
            # Only the exact bounded server message reaches the ABNF parser.
            parsed = SiweMessage.from_message(message, abnf=True)
            if parsed.model_dump() != expected.model_dump() or parsed.prepare_message() != message:
                raise SessionError('challenge_invalid')
        except SessionError:
            raise
        except Exception:
            raise SessionError('challenge_invalid') from None
        check_read_deadline()
        try:
            recovered = Account.recover_message(encode_defunct(text=message), signature=signature)
        except Exception:
            raise SessionError('invalid_signature') from None
        check_read_deadline()
        if recovered != expected.address:
            raise SessionError('invalid_signature')
        # Expiry remains absolute even when parsing/recovery spent the last moment.
        self._check_time(issued_at, expires_at)


def preview_origins(listed, origin, *, comma=True):
    """The exact Pages preview origins a listener admits besides its canonical `origin`, as a tuple.

    Launch round P3 (4 Nov 2026), item 7: the session and authenticated listeners take them from
    DOMINO_SESSION_PREVIEW_ORIGINS (comma-separated), the execution status listener from its profile's
    session.previewOrigins (a list). None, '' or [] lists none, every listener's behaviour before. Otherwise at most
    MAX_PREVIEW_ORIGINS, each a canonical origin SiwePolicy takes (https and a lower-case DNS name, nothing else: no
    wildcard, port, path or upper case), none twice and none `origin`; anything else is ValueError, so the listener
    refuses to start. Each is compared as a whole string with the origin its bridge Worker admitted
    (X-Domino-Browser-Origin), and the session listener writes each one's own SIWE message (siwe_policies).
    """
    if listed is None or listed == '':
        return ()
    if type(listed) is str and comma:
        listed = listed.split(',')
    if type(listed) not in (list, tuple) or len(listed) > MAX_PREVIEW_ORIGINS:
        raise ValueError('invalid_session_preview_origins')
    if any(type(value) is not str or value == origin for value in listed) or len(set(listed)) != len(listed):
        raise ValueError('invalid_session_preview_origins')
    for value in listed:
        SiwePolicy(value)
    return tuple(listed)


def siwe_policies(origin, listed=None):
    """The session listener's SIWE policies: the canonical origin's first, then each listed preview's own."""
    return tuple(SiwePolicy(value) for value in (origin, *preview_origins(listed, origin)))


def configured_preview_origins(listed, origin, name, *, comma=True, stream=None):
    """The preview origins a listener's configuration lists, or none when the list is malformed.

    Review L3 (4 Nov 2026): a malformed list turns preview admission off, and only that. The canonical origin keeps
    serving, every preview origin is refused as unlisted, and the journal gets an error-priority line (the `<3>`
    prefix) naming the setting, never its value. It used to stop the listener, so one typo stopped all seven at their
    next restart. `comma`: whether a string is a comma-separated list (the environment) or malformed (a JSON profile).
    """
    try:
        return preview_origins(listed, origin, comma=comma)
    except ValueError:
        print(f'<3>{name} is malformed: preview origins are off, the canonical origin serves.',
              file=stream or sys.stderr, flush=True)
        return ()
