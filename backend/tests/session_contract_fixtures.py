"""Deterministic model-validated fixtures; synthetic identities, never live sessions."""
from datetime import datetime, timedelta, timezone
from eth_account import Account
from eth_account.messages import encode_defunct

from session_models import ERROR_STATUS_BY_CODE, REQUEST_MODELS, RESPONSE_MODELS, validate_body
from session_siwe import SiwePolicy


def build_fixtures():
    # This public test scalar has no funds/authority and is never runtime config.
    account = Account.from_key(bytes([17]) * 32)
    issued = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    expires = issued + timedelta(minutes=5)
    policy = SiwePolicy('https://app.example.invalid', clock=lambda: issued)
    message = policy.issue(account.address, 'a' * 32, issued, expires)
    signature = '0x' + account.sign_message(encode_defunct(text=message)).signature.hex()
    policy.verify(message, signature, address=account.address, nonce='a' * 32,
                  issued_at=issued, expires_at=expires)
    requests = {'bootstrap': {}, 'challenge': {'address': account.address, 'chainId': 4663},
                'verify': {'challengeId': 'b' * 32, 'message': message, 'signature': signature},
                'me': {}, 'refresh': {}, 'logout': {}}
    authenticated = {'authenticated': True, 'owner': {'address': account.address.lower(), 'chainId': 4663},
                     'expiresAt': '2026-09-11T00:00:00Z', 'csrfToken': 'c' * 43,
                     'validation': {'method': 'plain_eoa', 'blockNumber': '123', 'blockHash': '0x' + 'a' * 64}}
    responses = {
        'bootstrap': {'status': 'challenge_required', 'csrfToken': 'p' * 43, 'expiresAt': '2026-09-10T12:10:00Z'},
        'challenge': {'challengeId': 'b' * 32, 'message': message, 'expiresAt': '2026-09-10T12:05:00Z'},
        'verify': authenticated, 'me': authenticated, 'refresh': authenticated, 'logout': {'authenticated': False},
    }
    for route, value in requests.items():
        validate_body(route, value)
        REQUEST_MODELS[route].model_validate(value)
    for route, value in responses.items():
        RESPONSE_MODELS[route].model_validate(value)
    return requests, responses, {code: {'status': status, 'body': {'error': code}}
                                 for code, status in ERROR_STATUS_BY_CODE.items()}
