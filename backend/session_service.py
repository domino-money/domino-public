"""Wallet authentication only; public reads never acquire account authority."""
import ipaddress

from discovery import DataError
from read_deadline import check_read_deadline
from session_models import SessionError, token, validate_account, validate_body


class SessionService:
    def __init__(self, store, siwe, checker):
        self.store,self.siwe,self.checker=store,siwe,checker

    def execute(self, route, body, *, client, preauth=None, session=None, csrf=None):
        validate_body(route,body)
        preauth,session,csrf=token(preauth),token(session),token(csrf)
        try:
            value=ipaddress.ip_address(client)
            if '%' in str(value):raise ValueError()
            if value.version==6 and value.ipv4_mapped:value=value.ipv4_mapped
            # Same abuse scope as the read bridge: IPv4 canonical address or
            # IPv6 /64. Interface-ID churn must not create a new shared bucket.
            client=str(ipaddress.ip_network(f'{value}/64',strict=False)) if value.version==6 else str(value)
        except (ValueError,TypeError):
            raise SessionError('invalid_request') from None
        try:
            check_read_deadline()
            if route=='bootstrap':
                return self.store.bootstrap(client,preauth,session)
            if route=='logout':
                return self.store.logout(client,preauth,session,csrf)
            if route in ('challenge','verify'):
                token(preauth,required='preauth_required')
                if not csrf:raise SessionError('csrf_invalid')
            if route=='challenge':
                return self.store.challenge(client,preauth,csrf,body['address'].lower(),self.siwe.issue)
            if route=='verify':
                challenge=self.store.reserve_verify(client,preauth,csrf,body['challengeId'],body['message'],session)
                self.siwe.verify(body['message'],body['signature'],address=challenge['address'],nonce=challenge['nonce'],
                                 issued_at=challenge['issued_at'],expires_at=challenge['expires_at'])
                check_read_deadline()
                self.store.reserve_verified_address(preauth,csrf,challenge)
                check_read_deadline()
                validation=validate_account(self.checker.check(challenge['address']))
                check_read_deadline()
                return self.store.finish_verify(preauth,csrf,challenge,validation,session)
            token(session,required='session_required')
            if route=='me':
                return self.store.me(session)
            if not csrf:raise SessionError('csrf_invalid')
            owner=self.store.begin_private(client,session,csrf)
            try:
                validation=validate_account(self.checker.check(owner['address']))
            except SessionError as error:
                if error.code=='account_unsupported':self.store.revoke(session)
                raise
            check_read_deadline()
            return self.store.finish_private(session,csrf,validation)
        except DataError:
            raise SessionError('request_timeout') from None
