"""Normalize only Access's exact duplicate JWT cookie on private listeners.

This does not authenticate anything. The unchanged assertion must still pass
the listener's issuer/audience/service-identity/signature verification. Browser
cookies, ambiguous duplicates and additional cookie fields are never admitted.
"""
import hmac


def normalize_access_cookie(scope):
    headers = scope['headers']
    cookies = [value for name, value in headers if name.lower() == b'cookie']
    assertions = [value for name, value in headers if name.lower() == b'cf-access-jwt-assertion']
    if (len(cookies) == len(assertions) == 1 and 1 <= len(assertions[0]) <= 8192
            and hmac.compare_digest(cookies[0].strip(b' \t'), b'CF_Authorization=' + assertions[0])):
        scope['headers'] = [(name, value) for name, value in headers if name.lower() != b'cookie']
