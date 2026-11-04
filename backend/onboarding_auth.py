"""Reuse SIWE sessions for bounded previews; this grants no spending authority."""
from contextlib import contextmanager
from contextvars import ContextVar
import ipaddress

from discovery import DataError
from read_deadline import check_read_deadline
from session_models import SessionError, validate_account

# 3 Nov 2026 (launch): each kind of signed-in work spends its own preview budget (IP, account and
# site-wide), so polling a transfer's or an execution's status never spends what a plan or a quote
# needs, nor does a crowd behind one IP. The listener names its family and route (authenticated_api);
# any other keeps the shared 'onboarding' budget. Rate keys are HMACs of the kind: no migration.
BUDGETS = {('position-plan', 'plan'): 'plan',
           ('crosschain', 'quote'): 'crosschain-quote', ('crosschain', 'origins'): 'crosschain-quote',
           ('crosschain', 'status'): 'crosschain-status',
           **{('execution', route): 'execution-performance' for route in ('status', 'list', 'availability')},
           **{('performance', route): 'execution-performance' for route in ('cards', 'epochs', 'enroll')}}
_SERVING = ContextVar('domino_preview_serving', default=None)


@contextmanager
def serving(family, route):
    """The family and route one worker serves, for the duration of its request."""
    token = _SERVING.set((family, route))
    try:
        yield
    finally:
        _SERVING.reset(token)


def preview_budget():
    return BUDGETS.get(_SERVING.get(), 'onboarding')


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
            # Credential validation happens after the store reads the IP quota,
            # and a failed one spends the IP attempt: missing/malformed bearers
            # cannot bypass that quota.
            owner = self.store.begin_preview(client, session, csrf, budget=preview_budget())['address']
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
