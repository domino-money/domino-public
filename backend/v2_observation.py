"""Signed price observations for Domino V2 anchors: the publisher's side.

A v4 vault (and the auto-exit on a v4 pool) is bounded by an anchor price that
an admitted publisher signs off-chain, EIP-712, and the operator passes as
evidence; there is no publication transaction (docs/v2/F0_INTERFACES.md,
docs/v2/F1_REGISTRY_ANCHOR.md, "Publisher service"). This module:

- builds the typed data from the frozen export api-contracts/v2/eip712.json
  (domain Domino/2, the chain id, verifyingContract = the chain's priceAnchor
  from the deployment manifest), never re-declaring the types;
- signs PriceObservation with the publisher's key: 65 bytes r ‖ s ‖ v, low s,
  v 27 or 28, which is what DominoPriceAnchor._recover accepts;
- encodes the evidence abi.encode(PriceObservation, bytes signature);
- reads the price it signs itself (Publisher): the pool's spot at a block the
  chain's head follower pinned, with observedAt = that block's timestamp,
  never a wall clock ahead of the chain, and validUntil - observedAt within
  the consumer's maximum age. Before signing it requires the spot to have been
  stable over a short look-back (several earlier blocks within a band), so a
  price pushed for a single block is not attested: a manipulator has to hold
  it across the window, exposed to arbitrage. The anchor then bounds the
  execution's spot against the signed price (the band) and the floors use it.

The key is loaded by the caller through the keystore + systemd-credential
pattern (automation_keys.keystore_key); test keys appear in tests only.
Observations are public data: nothing here is secret except the key.
"""
from dataclasses import dataclass
from functools import lru_cache
import json
from pathlib import Path

from eth_abi import decode, encode
from eth_account import Account
from eth_account.messages import _hash_eip191_message, encode_typed_data
from eth_keys import keys
from eth_utils import to_checksum_address

from discovery import Block, DataError, address, parse_block
from v2_chains import DEX_V4, ChainProfile
from v2_uniswap import PoolRef
from v4_math import MAX_SQRT, MIN_SQRT

ROOT = Path(__file__).resolve().parents[1]
EIP712_EXPORT = ROOT / 'api-contracts/v2/eip712.json'
POOL_REF_ABI = '(uint8,address,address,uint24,int24,address)'
OBSERVATION_ABI = f'({POOL_REF_ABI},uint160,uint64,uint64,uint64)'
U64 = 2**64 - 1
SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
# DominoPriceAnchor.HALF_CURVE_ORDER: a higher s is the malleated twin.
HALF_ORDER = SECP256K1_N // 2
BPS = 10_000
# AnchorMath.MIN_SQRT_PRICE / MAX_SQRT_PRICE (TickMath's bounds, inclusive of the maximum).
MAX_SQRT_PRICE = MAX_SQRT


@lru_cache(maxsize=1)
def _export():
    data = json.loads(EIP712_EXPORT.read_text())
    types = data['types']
    if (data['domain']['name'], data['domain']['version']) != ('Domino', '2'):
        raise DataError('v2_eip712_export_invalid')
    return data['domain']['fields'], {'PoolRef': types['PoolRef'], 'PriceObservation': types['PriceObservation']}


@dataclass(frozen=True)
class PriceObservation:
    """DominoV2Types.PriceObservation."""
    pool: PoolRef
    sqrt_price_x96: int
    observed_at: int
    valid_until: int
    nonce: int

    def __post_init__(self):
        if (not isinstance(self.pool, PoolRef) or type(self.sqrt_price_x96) is not int
                or not MIN_SQRT <= self.sqrt_price_x96 <= MAX_SQRT_PRICE
                or any(type(v) is not int or not 0 <= v <= U64 for v in (self.observed_at, self.valid_until,
                                                                         self.nonce))
                or self.valid_until < self.observed_at):
            raise DataError('v2_invalid_observation')

    def as_tuple(self):
        p = self.pool
        return ((p.dex, p.currency0, p.currency1, p.fee, p.tick_spacing, p.hooks), self.sqrt_price_x96,
                self.observed_at, self.valid_until, self.nonce)

    def message(self):
        p = self.pool
        return {'pool': {'dex': p.dex, 'currency0': to_checksum_address(p.currency0),
                         'currency1': to_checksum_address(p.currency1), 'fee': p.fee, 'tickSpacing': p.tick_spacing,
                         'hooks': to_checksum_address(p.hooks)},
                'sqrtPriceX96': self.sqrt_price_x96, 'observedAt': self.observed_at,
                'validUntil': self.valid_until, 'nonce': self.nonce}


@dataclass(frozen=True)
class SignedObservation:
    observation: PriceObservation
    signature: bytes  # r ‖ s ‖ v

    def evidence(self):
        """abi.encode(PriceObservation, bytes signature): the anchor's non-TWAP evidence."""
        return encode([OBSERVATION_ABI, 'bytes'], [self.observation.as_tuple(), self.signature])


def typed_data(chain_id, anchor, observation):
    """The EIP-712 message a wallet or eth_account signs, from the frozen export."""
    domain_fields, types = _export()
    return {'types': {'EIP712Domain': domain_fields, **types}, 'primaryType': 'PriceObservation',
            'domain': {'name': 'Domino', 'version': '2', 'chainId': chain_id,
                       'verifyingContract': to_checksum_address(address(anchor))},
            'message': observation.message()}


def observation_digest(chain_id, anchor, observation):
    """The digest the anchor's hashObservation returns, and the publisher signs."""
    if type(chain_id) is not int or chain_id <= 0 or not isinstance(observation, PriceObservation):
        raise DataError('v2_invalid_observation')
    return '0x' + _hash_eip191_message(encode_typed_data(full_message=typed_data(chain_id, anchor,
                                                                                    observation))).hex()


def decode_evidence(raw):
    """The SignedObservation inside a non-TWAP evidence, canonical bytes only."""
    if type(raw) is not bytes or len(raw) == 32:
        raise DataError('v2_invalid_observation_evidence')
    try:
        point, signature = decode([OBSERVATION_ABI, 'bytes'], raw)
        (dex, c0, c1, fee, spacing, hooks), price, observed, valid, nonce = point
        signed = SignedObservation(PriceObservation(PoolRef(dex, c0, c1, fee, spacing, hooks), price, observed,
                                                    valid, nonce), bytes(signature))
    except DataError:
        raise
    except Exception:
        raise DataError('v2_invalid_observation_evidence') from None
    if signed.evidence() != raw:
        raise DataError('v2_invalid_observation_evidence')
    return signed


def recover_signer(chain_id, anchor, signed):
    """The publisher a signature recovers to, as the anchor's _recover would:
    65 bytes, s at most half the curve order, v 27 or 28; otherwise None."""
    signature = signed.signature
    if type(signature) is not bytes or len(signature) != 65:
        return None
    if int.from_bytes(signature[32:64], 'big') > HALF_ORDER or signature[64] not in (27, 28):
        return None
    digest = bytes.fromhex(observation_digest(chain_id, anchor, signed.observation)[2:])
    try:
        recovered = keys.Signature(signature[:64] + bytes([signature[64] - 27]))
        return recovered.recover_public_key_from_msg_hash(digest).to_checksum_address().lower()
    except Exception:
        return None


class ObservationSigner:
    """Signs PriceObservation for one chain's anchor with the publisher's key."""

    def __init__(self, key, *, chain_id, anchor):
        if type(key) is not bytes or len(key) != 32:
            raise DataError('v2_publisher_key_invalid')
        self._account = Account.from_key(key)
        self.address = self._account.address.lower()
        if type(chain_id) is not int or chain_id <= 0:
            raise DataError('v2_invalid_observation')
        self.chain_id, self.anchor = chain_id, address(anchor)

    def __repr__(self):
        return f'ObservationSigner(address={self.address!r}, chain_id={self.chain_id}, anchor={self.anchor!r})'

    def sign(self, observation):
        message = encode_typed_data(full_message=typed_data(self.chain_id, self.anchor, observation))
        signed = self._account.sign_message(message)
        signature = bytes(signed.signature)
        result = SignedObservation(observation, signature)
        # eth_keys signs canonically (low s, v 27/28); refuse anything the
        # anchor would not recover, before it leaves this boundary.
        if recover_signer(self.chain_id, self.anchor, result) != self.address:
            raise DataError('v2_observation_signature_invalid')
        return result


@dataclass(frozen=True)
class PublisherPolicy:
    """How long an observation lives and how stable the price must have been.

    validity_seconds: validUntil - observedAt; a consumer passes its own
    maximum (a vault's maxObservationAgeSeconds, the auto-exit's 300 s) and
    the smaller one is used. lookback_seconds: earlier points the spot is
    compared with (converted to blocks with the profile's nominal block time,
    at least one block each); max_deviation_bps: the band all of them must be
    in around the signed spot.
    """
    validity_seconds: int = 120
    lookback_seconds: tuple = (12, 60)
    max_deviation_bps: int = 50

    def __post_init__(self):
        object.__setattr__(self, 'lookback_seconds', tuple(self.lookback_seconds))
        if (type(self.validity_seconds) is not int or not 1 <= self.validity_seconds <= 3600
                or not 1 <= len(self.lookback_seconds) <= 4
                or any(type(s) is not int or not 1 <= s <= 3600 for s in self.lookback_seconds)
                or type(self.max_deviation_bps) is not int or not 1 <= self.max_deviation_bps <= 2000):
            raise DataError('v2_invalid_publisher_policy')


def within_band(a, b, bps):
    """AnchorMath.withinBand: max(a, b)^2 * 10000 <= min(a, b)^2 * (10000 + bps), exactly."""
    if a == 0 or b == 0:
        return False
    high, low = max(a, b), min(a, b)
    return high * high * BPS <= low * low * (BPS + bps)


class HistoricalPrices:
    """A pool's spot at an earlier block, through a history reader
    (v2_uniswap.UniswapReader over a v2_rpc.ChainHistoryRpc): the header
    first, so the block is pinned by its hash, then slot0 at it."""

    def __init__(self, reader):
        self.reader = reader

    def pool_price(self, pool, number):
        block = parse_block(self.reader.rpc.request('eth_getBlockByNumber', [hex(number), False]))
        if block.number != number:
            raise DataError('block_unavailable')
        return self.reader.pool(pool, block).sqrt_price_x96


class Publisher:
    """Reads a v4 pool's spot at a pinned block and signs it.

    `reader` reads current state at the head (a UniswapReader over the chain's
    ChainReadRpc seeded with the head); `history` gives earlier spots
    (HistoricalPrices). The signer is the publisher's ObservationSigner."""

    def __init__(self, chain, signer, reader, history, policy=PublisherPolicy()):
        if not isinstance(chain, ChainProfile) or not isinstance(signer, ObservationSigner):
            raise DataError('v2_invalid_publisher')
        if signer.chain_id != chain.chainId or not isinstance(policy, PublisherPolicy):
            raise DataError('v2_invalid_publisher')
        self.chain, self.signer, self.policy = chain, signer, policy
        self.reader, self.history = reader, history

    def lookback_blocks(self, head):
        seconds_per_block = self.chain.block_time
        blocks = []
        for seconds in self.policy.lookback_seconds:
            count = max(1, int(seconds / seconds_per_block))
            if count > head.number:
                raise DataError('v2_observation_history_unavailable')
            blocks.append(head.number - count)
        return blocks

    def observe(self, pool, head, *, max_age_seconds):
        """A signed observation of `pool` at `head`, valid for at most max_age_seconds."""
        if not isinstance(pool, PoolRef) or pool.dex != DEX_V4 or not isinstance(head, Block):
            raise DataError('v2_observation_v4_only')
        if type(max_age_seconds) is not int or max_age_seconds <= 0:
            raise DataError('v2_invalid_observation')
        state = self.reader.pool(pool, head)
        spot = state.sqrt_price_x96
        for number in self.lookback_blocks(head):
            earlier = self.history.pool_price(pool, number)
            if not within_band(spot, earlier, self.policy.max_deviation_bps):
                raise DataError('v2_observation_unstable')
        validity = min(self.policy.validity_seconds, max_age_seconds)
        # nonce: the block number. Two observations of one pool at one block
        # with the same validity are the same attestation.
        return self.signer.sign(PriceObservation(pool, spot, head.timestamp, head.timestamp + validity,
                                                 head.number))
