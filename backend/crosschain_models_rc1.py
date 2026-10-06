"""Closed crosschain-v1 contract: deposit from another chain (S2), for the app (F7).

Three POST routes behind the authenticated private listener (crosschain_api.py):
- origins: the EVM chains and tokens Relay and Across can bridge from, to one
  destination token on Robinhood, Base or Arbitrum;
- quote: both providers quoted with the 35 bps app fee, the better output for
  the user chosen, and the unsigned wallet steps (exact approval, then deposit);
- status: the deposit tracked to completion or refund, and the app fee measured.

The owner is always the SIWE session's wallet; no request names an owner,
recipient, refund address or fee recipient. A response never grants signing
authority: the wallet shows the user every step it signs.
"""
from typing import Annotated, Literal

from pydantic import AfterValidator, BeforeValidator, Field, StrictBool, StrictInt, model_validator

from crosschain_common import (APP_FEE_BPS, PROVIDERS, ZERO, encode_call, load_destinations, load_pins)
from onboarding_models import (ERROR_STATUS_BY_CODE as AUTH_ERRORS, Fingerprint, NormalizedAddress, PositiveRaw,
                               Raw, SchemaVersion, Slippage, StrictModel, Timestamp, Address)

CONTRACT_VERSION = '1.0.0-rc.1'
MAX_BODY = 4096
MAX_RESPONSE = 262144
QUOTE_LIFETIME_SECONDS = 120
MAX_ORIGIN_CHAINS = 64
MAX_ORIGIN_TOKENS = 32
ERROR_STATUS_BY_CODE = {**AUTH_ERRORS,
    'crosschain_capacity_busy': 429, 'crosschain_route_unsupported': 422,
    'crosschain_deposit_not_found': 404, 'crosschain_listing_unavailable': 503}
DESTINATIONS = load_destinations()
PINS = load_pins()
STATES = ('awaiting_deposit', 'pending', 'refund_pending', 'failed', 'refund_failed', 'filled', 'refunded')
TERMINAL = frozenset(('filled', 'refunded'))
# A state may only move forward. A provider that reports an earlier state (an
# indexer lagging behind) leaves the last one standing.
NEXT = {
    'awaiting_deposit': frozenset(STATES),
    'pending': frozenset(STATES) - {'awaiting_deposit'},
    'refund_pending': frozenset(('refund_pending', 'refunded')),
    'failed': frozenset(('failed', 'refunded', 'refund_failed')),
    'refund_failed': frozenset(('refund_failed', 'refunded')),
    'filled': frozenset(('filled',)),
    'refunded': frozenset(('refunded',)),
}
POLL_SECONDS = {
    'relay': {'awaiting_deposit': 5, 'pending': 5, 'failed': 300, 'refund_failed': 900},
    'across': {'awaiting_deposit': 10, 'pending': 10, 'refund_pending': 300},
}
CANDIDATE_STATUSES = ('quoted', 'destination_gas_unsupported', 'no_route', 'amount_too_low', 'amount_too_high',
                      'rate_limited', 'unavailable', 'rejected', 'unsafe', 'origin_not_supported')


class CrosschainError(Exception):
    def __init__(self, code):
        self.code = code if code in ERROR_STATUS_BY_CODE else 'upstream_unavailable'
        self.status = ERROR_STATUS_BY_CODE[self.code]
        super().__init__(self.code)


def advance(previous, observed):
    """(state, transition) for an observation after the state the app last showed."""
    if previous is None:
        return observed, 'initial'
    if observed == previous:
        return previous, 'unchanged'
    if observed in NEXT[previous]:
        return observed, 'advanced'
    return previous, 'held'


def approve_data(spender, amount):
    return encode_call('approve(address,uint256)', ('address', 'uint256'), (spender, amount))


def _member(values, code):
    def check(value):
        if value not in values:
            raise ValueError(code)
        return value
    return check


def _strict_bool(value):
    if type(value) is not bool:
        raise ValueError('boolean_required')
    return value


EvmChain = Annotated[StrictInt, Field(ge=1, le=2**53 - 1)]
DestinationChain = Annotated[StrictInt, AfterValidator(_member(frozenset(DESTINATIONS), 'destination_chain')),
                             Field(json_schema_extra={'enum': sorted(DESTINATIONS)})]
Provider = Literal['relay', 'across']
State = Literal['awaiting_deposit', 'pending', 'refund_pending', 'failed', 'refund_failed', 'filled', 'refunded']
Hash = Annotated[str, Field(pattern=r'^0x[0-9a-fA-F]{64}$', min_length=66, max_length=66)]
NormalizedHash = Annotated[str, Field(pattern=r'^0x[0-9a-f]{64}$', min_length=66, max_length=66)]
SafeCode = Annotated[str, Field(pattern=r'^[a-z][a-z0-9_]{0,63}$', max_length=64)]
Symbol = Annotated[str, Field(pattern=r'^[A-Za-z0-9.+_-]{1,24}$', max_length=24)]
ChainName = Annotated[str, Field(pattern=r'^[A-Za-z0-9 .()-]{1,40}$', max_length=40)]
Usd = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,15})(\.[0-9]{1,36})?$', max_length=53)]
Calldata = Annotated[str, Field(pattern=r'^0x(?:[0-9a-f]{2})+$', min_length=10, max_length=2 + 2 * 16384)]
Seconds = Annotated[StrictInt, Field(ge=0, le=86400)]
Bool = Annotated[StrictBool, BeforeValidator(_strict_bool)]


def _destination_token(chain, token):
    if token.lower() not in DESTINATIONS[chain]['tokens']:
        raise ValueError('destination_token_not_offered')


class OriginsRequest(StrictModel):
    destinationChainId: DestinationChain
    destinationToken: Address

    @model_validator(mode='after')
    def offered(self):
        _destination_token(self.destinationChainId, self.destinationToken)
        return self


class QuoteRequest(StrictModel):
    originChainId: EvmChain
    originToken: Address
    destinationChainId: DestinationChain
    destinationToken: Address
    amountRaw: PositiveRaw
    slippageBps: Slippage
    # Ask for native gas on the destination with the funds (Relay's top-up). Only
    # meaningful when the delivered token is not the native one.
    destinationGas: Bool

    @model_validator(mode='after')
    def route(self):
        _destination_token(self.destinationChainId, self.destinationToken)
        if self.originChainId == self.destinationChainId:
            raise ValueError('same_chain')
        if self.destinationGas and self.destinationToken.lower() == ZERO:
            raise ValueError('native_output_carries_gas')
        if int(self.amountRaw) >= 2**128:
            raise ValueError('amount_too_large')
        return self


class StatusRequest(StrictModel):
    provider: Provider
    originChainId: EvmChain
    destinationChainId: DestinationChain
    depositTxHash: Hash
    # Relay's request id from the quote; Across tracks by the deposit transaction.
    requestId: Hash | None
    # The state the app last showed, so a lagging provider cannot move it back.
    previousState: State | None

    @model_validator(mode='after')
    def identity(self):
        if self.originChainId == self.destinationChainId:
            raise ValueError('same_chain')
        if (self.provider == 'relay') != (self.requestId is not None):
            raise ValueError('request_id_mismatch')
        return self


# Responses -----------------------------------------------------------------

class TokenAmount(StrictModel):
    amountRaw: Raw
    chainId: EvmChain
    token: NormalizedAddress


class AppFeeQuote(TokenAmount):
    charged: Literal['origin_input', 'destination_output']


class OriginGas(StrictModel):
    feeRaw: Raw | None
    usd: Usd | None


class DestinationGas(StrictModel):
    deliveredRaw: PositiveRaw


class Refund(StrictModel):
    chainId: EvmChain
    recipient: NormalizedAddress


class Tracking(StrictModel):
    requestId: NormalizedHash | None


class Candidate(StrictModel):
    provider: Provider
    status: Literal['quoted', 'destination_gas_unsupported', 'no_route', 'amount_too_low', 'amount_too_high',
                    'rate_limited', 'unavailable', 'rejected', 'unsafe', 'origin_not_supported']
    reason: SafeCode | None
    outputRaw: PositiveRaw | None
    minimumOutputRaw: PositiveRaw | None
    appFee: AppFeeQuote | None
    providerFee: TokenAmount | None
    originGas: OriginGas | None
    destinationGas: DestinationGas | None
    etaSeconds: Seconds | None
    refund: Refund | None
    tracking: Tracking | None

    @model_validator(mode='after')
    def consistent(self):
        priced = self.status in ('quoted', 'destination_gas_unsupported')
        fields = (self.outputRaw, self.minimumOutputRaw, self.appFee, self.originGas, self.refund, self.tracking)
        if priced:
            if any(value is None for value in fields) or int(self.minimumOutputRaw) > int(self.outputRaw):
                raise ValueError('candidate_quote_incomplete')
            if (self.provider == 'relay') != (self.tracking.requestId is not None):
                raise ValueError('candidate_tracking')
            if self.status == 'quoted' and self.reason is not None:
                raise ValueError('candidate_reason')
        elif any(value is not None for value in (*fields, self.providerFee, self.destinationGas, self.etaSeconds)) or self.reason is None:
            raise ValueError('candidate_unpriced')
        if self.provider == 'across' and self.destinationGas is not None:
            raise ValueError('candidate_destination_gas')
        if self.appFee is not None and (self.appFee.charged == 'origin_input') != (self.provider == 'relay'):
            raise ValueError('candidate_fee_side')
        return self


class Approval(StrictModel):
    token: NormalizedAddress
    spender: NormalizedAddress
    amountRaw: PositiveRaw


class Transaction(StrictModel):
    chainId: EvmChain
    to: NormalizedAddress
    data: Calldata
    valueRaw: Raw


class Step(StrictModel):
    kind: Literal['approval', 'deposit']
    transaction: Transaction
    # For an approval: the app may skip it when allowance(owner, spender) >= amountRaw.
    approval: Approval | None

    @model_validator(mode='after')
    def consistent(self):
        if (self.kind == 'approval') != (self.approval is not None):
            raise ValueError('step_kind')
        if self.approval is not None:
            approval, transaction = self.approval, self.transaction
            if (transaction.to != approval.token or transaction.valueRaw != '0'
                    or transaction.data != approve_data(approval.spender, int(approval.amountRaw))):
                raise ValueError('step_approval')
        return self


class QuoteIdentity(QuoteRequest):
    owner: NormalizedAddress
    originToken: NormalizedAddress
    destinationToken: NormalizedAddress


class Comparison(StrictModel):
    basis: Literal['expected_output_after_all_fees']
    advantageRaw: Raw | None
    advantageBps: Annotated[StrictInt, Field(ge=0, le=10**12)] | None


def deposit_targets(provider, chain, native):
    """The contract a deposit may call: Relay's Depository, Across' SpokePool (ERC-20) or SpokePoolPeriphery (native)."""
    pin = PINS['chains'].get(chain, {}).get(provider)
    if pin is None:
        return None
    if provider == 'relay':
        return pin['depository']
    return pin.get('spokePoolPeriphery') if native else pin['spokePool']


def approval_spender(provider, chain):
    pin = PINS['chains'].get(chain, {}).get(provider)
    if pin is None:
        return None
    return pin['depository'] if provider == 'relay' else pin['spokePool']


def ranked(candidates):
    """Eligible candidates, best first: the higher expected output, then the shorter wait, then provider order."""
    eligible = [c for c in candidates if c['status'] == 'quoted']
    return sorted(eligible, key=lambda c: (-int(c['outputRaw']),
                                           c['etaSeconds'] if c['etaSeconds'] is not None else 10**9,
                                           PROVIDERS.index(c['provider'])))


class QuotePlan(StrictModel):
    schemaVersion: SchemaVersion
    source: Literal['crosschain_quote_v1']
    requestedAt: Timestamp
    retrievedAt: Timestamp
    expiresAt: Timestamp
    requestFingerprint: Fingerprint
    request: QuoteIdentity
    appFeeBps: Annotated[StrictInt, Field(ge=APP_FEE_BPS, le=APP_FEE_BPS)]
    feeRecipient: NormalizedAddress
    decision: Provider | None
    reason: Literal['best_output', 'only_quote', 'no_quote']
    comparison: Comparison
    candidates: Annotated[list[Candidate], Field(min_length=2, max_length=2)]
    steps: Annotated[list[Step], Field(max_length=2)]

    @model_validator(mode='after')
    def consistent(self):
        request = self.request
        if not self.requestedAt <= self.retrievedAt < self.expiresAt or self.expiresAt != self.requestedAt + QUOTE_LIFETIME_SECONDS:
            raise ValueError('quote_times')
        if [c.provider for c in self.candidates] != list(PROVIDERS) or self.feeRecipient in (ZERO, request.owner):
            raise ValueError('quote_candidates')
        origin, amount, native = request.originChainId, request.amountRaw, request.originToken == ZERO
        for candidate in self.candidates:
            if candidate.refund is not None and (candidate.refund.chainId != origin or candidate.refund.recipient != request.owner):
                raise ValueError('quote_refund')
            if candidate.appFee is not None:
                fee_chain = origin if candidate.provider == 'relay' else request.destinationChainId
                if candidate.appFee.chainId != fee_chain:
                    raise ValueError('quote_fee_chain')
            if candidate.status == 'quoted' and request.destinationGas and candidate.destinationGas is None:
                raise ValueError('quote_destination_gas')
            if candidate.destinationGas is not None and not request.destinationGas:
                raise ValueError('quote_destination_gas')
        best = ranked([c.model_dump() for c in self.candidates])
        decision = best[0]['provider'] if best else None
        reason = 'no_quote' if not best else 'only_quote' if len(best) == 1 else 'best_output'
        if self.decision != decision or self.reason != reason:
            raise ValueError('quote_decision')
        advantage = (int(best[0]['outputRaw']) - int(best[1]['outputRaw'])) if len(best) == 2 else None
        if self.comparison.advantageRaw != (None if advantage is None else str(advantage)):
            raise ValueError('quote_comparison')
        if (self.comparison.advantageBps is None) != (advantage is None) or (
                advantage is not None and self.comparison.advantageBps != advantage * 10000 // int(best[1]['outputRaw'])):
            raise ValueError('quote_comparison')
        if decision is None:
            if self.steps:
                raise ValueError('quote_steps')
            return self
        kinds = [step.kind for step in self.steps]
        if kinds != (['deposit'] if native else ['approval', 'deposit']):
            raise ValueError('quote_steps')
        for step in self.steps:
            if step.transaction.chainId != origin:
                raise ValueError('quote_steps')
        deposit = self.steps[-1].transaction
        if deposit.to != deposit_targets(decision, origin, native) or deposit.valueRaw != (amount if native else '0'):
            raise ValueError('quote_deposit_target')
        if not native:
            approval = self.steps[0].approval
            if (approval.token != request.originToken or approval.amountRaw != amount
                    or approval.spender != approval_spender(decision, origin)):
                raise ValueError('quote_approval')
        return self


class OriginToken(StrictModel):
    address: NormalizedAddress
    symbol: Symbol | None
    decimals: Annotated[StrictInt, Field(ge=0, le=255)] | None
    providers: Annotated[list[Provider], Field(min_length=1, max_length=2)]

    @model_validator(mode='after')
    def ordered(self):
        if self.providers != [p for p in PROVIDERS if p in self.providers]:
            raise ValueError('token_providers')
        return self


class OriginChain(StrictModel):
    chainId: EvmChain
    name: ChainName
    tokens: Annotated[list[OriginToken], Field(min_length=1, max_length=MAX_ORIGIN_TOKENS)]

    @model_validator(mode='after')
    def unique(self):
        addresses = [token.address for token in self.tokens]
        if addresses != sorted(set(addresses)):
            raise ValueError('chain_tokens')
        return self


class ProviderListing(StrictModel):
    provider: Provider
    status: Literal['listed', 'unavailable', 'rate_limited']
    reason: SafeCode | None

    @model_validator(mode='after')
    def consistent(self):
        if (self.status == 'listed') != (self.reason is None):
            raise ValueError('listing_reason')
        return self


class OriginsList(StrictModel):
    schemaVersion: SchemaVersion
    destinationChainId: DestinationChain
    destinationToken: NormalizedAddress
    retrievedAt: Timestamp
    providers: Annotated[list[ProviderListing], Field(min_length=2, max_length=2)]
    chains: Annotated[list[OriginChain], Field(max_length=MAX_ORIGIN_CHAINS)]

    @model_validator(mode='after')
    def consistent(self):
        _destination_token(self.destinationChainId, self.destinationToken)
        if [p.provider for p in self.providers] != list(PROVIDERS):
            raise ValueError('origins_providers')
        listed = {p.provider for p in self.providers if p.status == 'listed'}
        ids = [chain.chainId for chain in self.chains]
        if ids != sorted(set(ids)) or self.destinationChainId in ids:
            raise ValueError('origins_chains')
        for chain in self.chains:
            if chain.name != PINS['chains'].get(chain.chainId, {}).get('name'):
                raise ValueError('origins_chain_name')
            for token in chain.tokens:
                if not set(token.providers) <= listed or any(
                        PINS['chains'][chain.chainId].get(provider) is None for provider in token.providers):
                    raise ValueError('origins_token_providers')
        return self


class FeeMeasure(StrictModel):
    status: Literal['measured', 'not_collected', 'pending', 'unavailable']
    reason: SafeCode | None
    amountRaw: Raw | None
    chainId: EvmChain | None
    token: NormalizedAddress | None
    evidence: Literal['relay_requests_v3', 'destination_receipt', 'provider_record'] | None

    @model_validator(mode='after')
    def consistent(self):
        known = self.status in ('measured', 'not_collected')
        if known != all(value is not None for value in (self.amountRaw, self.chainId, self.token, self.evidence)):
            raise ValueError('fee_fields')
        if not known and any(value is not None for value in (self.amountRaw, self.chainId, self.token, self.evidence)):
            raise ValueError('fee_fields')
        if self.status == 'measured' and int(self.amountRaw) == 0 or self.status == 'not_collected' and self.amountRaw != '0':
            raise ValueError('fee_amount')
        if self.status in ('pending', 'unavailable') and self.reason is None:
            raise ValueError('fee_reason')
        return self


class Recovery(StrictModel):
    kind: Literal['automatic_refund', 'refunded', 'manual_recovery']
    chainId: EvmChain
    recipient: NormalizedAddress


class StatusIdentity(StatusRequest):
    owner: NormalizedAddress
    depositTxHash: NormalizedHash
    requestId: NormalizedHash | None


class StatusReport(StrictModel):
    schemaVersion: SchemaVersion
    request: StatusIdentity
    checkedAt: Timestamp
    providerStatus: Annotated[str, Field(pattern=r'^[A-Za-z][A-Za-z_]{0,31}$')] | None
    observedState: State
    state: State
    transition: Literal['initial', 'unchanged', 'advanced', 'held']
    terminal: Bool
    nextCheckSeconds: Annotated[StrictInt, Field(ge=1, le=3600)] | None
    fillTxHash: NormalizedHash | None
    refundTxHash: NormalizedHash | None
    recovery: Recovery | None
    fee: FeeMeasure

    @model_validator(mode='after')
    def consistent(self):
        request = self.request
        if (self.state, self.transition) != advance(request.previousState, self.observedState):
            raise ValueError('status_transition')
        if self.terminal != (self.state in TERMINAL):
            raise ValueError('status_terminal')
        if self.nextCheckSeconds != POLL_SECONDS[request.provider].get(self.state):
            raise ValueError('status_poll')
        # Across has no record until it indexes the deposit; Relay always answers with a status.
        if (self.providerStatus is None) != (request.provider == 'across' and self.observedState == 'awaiting_deposit'):
            raise ValueError('status_provider')
        if self.fillTxHash is not None and self.state != 'filled':
            raise ValueError('status_fill')
        if self.fee.status in ('measured', 'not_collected') and self.state != 'filled':
            raise ValueError('status_fee')
        expected_recovery = {'refund_pending': 'automatic_refund', 'failed': 'automatic_refund',
                             'refunded': 'refunded', 'refund_failed': 'manual_recovery'}.get(self.state)
        if (self.recovery is None) != (expected_recovery is None) or (self.recovery is not None and (
                self.recovery.kind != expected_recovery or self.recovery.chainId != request.originChainId
                or self.recovery.recipient != request.owner)):
            raise ValueError('status_recovery')
        return self


class OriginsResponse(StrictModel):
    contractVersion: Literal[CONTRACT_VERSION]
    origins: OriginsList


class QuoteResponse(StrictModel):
    contractVersion: Literal[CONTRACT_VERSION]
    quote: QuotePlan


class StatusResponse(StrictModel):
    contractVersion: Literal[CONTRACT_VERSION]
    status: StatusReport


REQUEST_MODELS = {'origins': OriginsRequest, 'quote': QuoteRequest, 'status': StatusRequest}
RESPONSE_MODELS = {'origins': OriginsResponse, 'quote': QuoteResponse, 'status': StatusResponse}
ROUTES = frozenset(REQUEST_MODELS)


def validate_request(route, body):
    try:
        return REQUEST_MODELS[route].model_validate(body)
    except (KeyError, ValueError, TypeError):
        raise CrosschainError('invalid_request') from None


def validate_response(route, body):
    try:
        return RESPONSE_MODELS[route].model_validate(body).model_dump()
    except (KeyError, ValueError, TypeError):
        raise CrosschainError('upstream_contract_mismatch') from None
