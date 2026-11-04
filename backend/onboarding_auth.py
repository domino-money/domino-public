"""Reuse SIWE sessions for bounded previews; this grants no spending authority."""
from contextlib import contextmanager
from contextvars import ContextVar
import ipaddress

from discovery import DataError
from read_deadline import check_read_deadline
from session_chain import AccountCache
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
# 4 Nov 2026 (launch round P3): the routes that only read the signed-in owner's own records or a public listing. A
# positive account check up to session_chain.ACCOUNT_CACHE_SECONDS old may answer them (AccountCache). Everything
# else reads the chain: a plan, a quote, an enrollment, every deposit and onboarding route (each prepares or records
# something the wallet signs or the store keeps), any route of a family not named here, and the session listener's
# verify and refresh, which never come through here.
READ_ONLY_ROUTES = frozenset({('execution', 'status'), ('execution', 'list'), ('execution', 'availability'),
                              ('performance', 'cards'), ('performance', 'epochs'),
                              ('crosschain', 'origins'), ('crosschain', 'status')})
_SERVING = ContextVar('domino_preview_serving', default=None)
# Launch round P3 (4 Nov 2026), review M1: the browser origin the listener admitted, as the session store keeps it
# (None, the canonical origin; else a listed preview's). Every session check of the request is held to it.
_ORIGIN = ContextVar('domino_preview_origin', default=None)


@contextmanager
def serving(family, route, origin=None):
    """The family, route and admitted origin one worker serves, for the duration of its request."""
    token, origin_token = _SERVING.set((family, route)), _ORIGIN.set(origin)
    try:
        yield
    finally:
        _ORIGIN.reset(origin_token)
        _SERVING.reset(token)


def preview_budget():
    return BUDGETS.get(_SERVING.get(), 'onboarding')


def read_only():
    """Whether the route being served may take a cached account check."""
    return _SERVING.get() in READ_ONLY_ROUTES


def serving_origin():
    return _ORIGIN.get()


class OnboardingAuth:
    def __init__(self, store, checker, *, accounts=None):
        self.store, self.checker = store, checker
        # One per listener process: its workers share what one of them read.
        self.accounts = AccountCache(checker) if accounts is None else accounts

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
            origin = serving_origin()
            projection = self.store.begin_preview(client, session, csrf, budget=preview_budget(), origin=origin)
            owner = projection['address']
            check_read_deadline()
            try:
                # A read-only route may take the cached check, only for the delegate the
                # session was admitted with; a store that does not say which reads fresh.
                if read_only() and 'delegate' in projection:
                    observed = self.accounts.read_only(owner, projection['delegate'])
                else:
                    observed = self.accounts.fresh(owner)
                validation = dict(validate_account(observed))
            except SessionError as error:
                if error.code == 'account_unsupported':
                    self.store.revoke(session)
                raise
            check_read_deadline()
            self.store.finish_preview(session, csrf, owner, validation, origin=origin)
            check_read_deadline()
            # Private request-local context, never serialized or cached.
            return {'owner': owner, 'session': session, 'csrf': csrf, 'validation': validation, 'origin': origin}
        except DataError:
            raise SessionError('request_timeout') from None

    def finish(self, context):
        try:
            check_read_deadline()
            self.store.finish_preview(context['session'], context['csrf'], context['owner'], context['validation'],
                                      origin=context.get('origin'))
            check_read_deadline()
        except DataError:
            raise SessionError('request_timeout') from None
