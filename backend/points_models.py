"""Closed points-v1 contract: season 1's points for the app (docs/points/POINTS.md, part 3).

Two POST routes behind the authenticated private listener (points_api.py), both
for the SIWE session's wallet; no request names a wallet:
- points: the wallet's entry in the season's latest snapshot (its points, their
  parts, its revenue by kind, its referrer and how many wallets it referred),
  the season and the snapshot it comes from; a wallet the snapshot does not
  hold answers zero, and a season without a snapshot yet answers it as null;
- link: records the session wallet's referral link, signed by that wallet
  (EIP-191, points_referral.message); the first link of a season holds.

The owner's rule (7 Nov 2026): seeing points needs the wallet's sign-in.
"""
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

from onboarding_models import ERROR_STATUS_BY_CODE as AUTH_ERRORS

CONTRACT_VERSION = '1.0.0-rc.1'
MAX_BODY = 1024
MAX_RESPONSE = 8192
ERROR_STATUS_BY_CODE = {
    **AUTH_ERRORS,
    'points_capacity_busy': 429,
    'points_unavailable': 503,
    'referral_self': 422,
    'referral_wallet_excluded': 403,
    'referral_season_closed': 409,
    'referral_message_not_fresh': 422,
    'referral_signature_invalid': 422,
    'referral_signature_mismatch': 422,
}


class PointsError(Exception):
    def __init__(self, code):
        self.code = code if code in ERROR_STATUS_BY_CODE else 'upstream_unavailable'
        self.status = ERROR_STATUS_BY_CODE[self.code]
        super().__init__(self.code)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


Address = Annotated[str, Field(pattern=r'^0x[0-9a-f]{40}$', min_length=42, max_length=42)]
AddressIn = Annotated[str, Field(pattern=r'^0x[0-9a-fA-F]{40}$', min_length=42, max_length=42)]
Signature = Annotated[str, Field(pattern=r'^0x[0-9a-fA-F]{130}$', min_length=132, max_length=132)]
Points = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,29})\.[0-9]{6}$', max_length=37)]
Usd = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,29})\.[0-9]{18}$', max_length=49)]
Hex64 = Annotated[str, Field(pattern=r'^[0-9a-f]{64}$', min_length=64, max_length=64)]
Instant = Annotated[str, Field(pattern=r'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$', max_length=20)]
UnixSeconds = Annotated[StrictInt, Field(ge=0, le=2 ** 40)]


class PointsRequest(StrictModel):
    """No field: the wallet is the session's."""


class LinkRequest(StrictModel):
    referrer: AddressIn
    issuedAt: UnixSeconds
    signature: Signature


class Season(StrictModel):
    id: Annotated[str, Field(pattern=r'^[a-z0-9-]{1,40}$')]
    title: Annotated[str, Field(min_length=1, max_length=40)]
    start: Instant
    end: Instant
    configSha256: Hex64


class Snapshot(StrictModel):
    takenAt: UnixSeconds
    sha256: Hex64


class Revenue(StrictModel):
    assistedSwap: Usd
    automation: Usd
    autoExit: Usd
    bridge: Usd


class WalletPoints(StrictModel):
    address: Address
    points: Points
    usagePoints: Points
    referralPoints: Points
    revenueUsd: Revenue
    referrer: Address | None
    referees: Annotated[StrictInt, Field(ge=0, le=10 ** 9)]

    @model_validator(mode='after')
    def parts_add_up(self):
        if Decimal(self.points) != Decimal(self.usagePoints) + Decimal(self.referralPoints):
            raise ValueError('points_parts')
        if self.referrer == self.address:
            raise ValueError('points_self_referrer')
        return self


class PointsResponse(StrictModel):
    contractVersion: Literal[CONTRACT_VERSION]
    season: Season
    snapshot: Snapshot | None
    wallet: WalletPoints


class LinkResponse(StrictModel):
    contractVersion: Literal[CONTRACT_VERSION]
    status: Literal['recorded', 'existing']
    referee: Address
    referrer: Address

    @model_validator(mode='after')
    def two_wallets(self):
        if self.referee == self.referrer:
            raise ValueError('points_self_referrer')
        return self


REQUEST_MODELS = {'points': PointsRequest, 'link': LinkRequest}
RESPONSE_MODELS = {'points': PointsResponse, 'link': LinkResponse}


def validate_request(route, body):
    try:
        return REQUEST_MODELS[route].model_validate(body)
    except (KeyError, ValueError, TypeError):
        raise PointsError('invalid_request') from None


def validate_response(route, body):
    try:
        return RESPONSE_MODELS[route].model_validate(body).model_dump(exclude_none=False)
    except (KeyError, ValueError, TypeError):
        raise PointsError('upstream_contract_mismatch') from None
