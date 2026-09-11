"""Reuse SIWE sessions for bounded previews; this grants no spending authority."""
import ipaddress

from discovery import DataError
from read_deadline import check_read_deadline
from session_models import SessionError, validate_account


class OnboardingAuth:
    def __init__(self, store, checker):
        self.store, self.checker = store, checker

    def begin(self, client, session, csrf):
        try:
            value = ipaddress.ip_address(client)
            if '%' in str(value):
                raise ValueError()
            if value.version == 6 and value.ipv4_mapped:
                value = value.ipv4_mapped
            client = (str(ipaddress.ip_network(f'{value}/64', strict=False))
                      if value.version == 6 else str(value))
        except (ValueError, TypeError):
            raise SessionError('invalid_request') from None
        try:
            check_read_deadline()
            # Credential validation happens after the store reserves the IP
            # attempt. Missing/malformed bearers cannot bypass that quota.
            owner = self.store.begin_preview(client, session, csrf)['address']
            check_read_deadline()
            try:
                validation = dict(validate_account(self.checker.check(owner)))
            except SessionError as error:
                if error.code == 'account_unsupported':
                    self.store.revoke(session)
                raise
            check_read_deadline()
            self.store.finish_preview(session, csrf, owner, validation)
            check_read_deadline()
            # Private request-local context, never serialized or cached.
            return {'owner': owner, 'session': session, 'csrf': csrf, 'validation': validation}
        except DataError:
            raise SessionError('request_timeout') from None

    def finish(self, context):
        try:
            check_read_deadline()
            self.store.finish_preview(context['session'], context['csrf'], context['owner'], context['validation'])
            check_read_deadline()
        except DataError:
            raise SessionError('request_timeout') from None
