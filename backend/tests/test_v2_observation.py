"""Signed price observations: the F0 golden digest, the anchor's pinned signature, evidence and the publisher."""
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_abi import encode
from eth_hash.auto import keccak

from discovery import Block, DataError
from v2_chains import chain
from v2_observation import (HALF_ORDER, SECP256K1_N, ObservationSigner, PriceObservation, Publisher, PublisherPolicy,
                            SignedObservation, decode_evidence, observation_digest, recover_signer, within_band)
from v2_uniswap import PoolRef

ROOT = Path(__file__).resolve().parents[2]
GOLDENS = json.loads((ROOT / 'api-contracts/v2/eip712-goldens.json').read_text())
ANCHOR_TEST = (ROOT / 'contracts/test/v2/anchor/DominoPriceAnchor.t.sol').read_text()
# A public test label, the same key DominoPriceAnchor.t.sol signs its golden with.
TEST_KEY = keccak(b'domino.v2.f1.publisher')
GOLDEN_ANCHOR = GOLDENS['domain']['verifyingContract']
ZERO = '0x' + '00' * 20


def golden_observation():
    fixture = GOLDENS['fixtures']['PriceObservation']
    p = fixture['pool']
    return PriceObservation(PoolRef(p['dex'], p['currency0'], p['currency1'], p['fee'], p['tickSpacing'], p['hooks']),
                            fixture['sqrtPriceX96'], fixture['observedAt'], fixture['validUntil'], fixture['nonce'])


def manual_digest(chain_id, anchor, point):
    """A second EIP-712 implementation, from the Solidity type strings and eth_abi alone."""
    pool_type = 'PoolRef(uint8 dex,address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'
    observation_type = ('PriceObservation(PoolRef pool,uint160 sqrtPriceX96,uint64 observedAt,uint64 validUntil,'
                        'uint64 nonce)')
    p = point.pool
    pool_hash = keccak(encode(['bytes32', 'uint8', 'address', 'address', 'uint24', 'int24', 'address'],
                              [keccak(pool_type.encode()), p.dex, p.currency0, p.currency1, p.fee, p.tick_spacing,
                               p.hooks]))
    struct = keccak(encode(['bytes32', 'bytes32', 'uint160', 'uint64', 'uint64', 'uint64'],
                           [keccak((observation_type + pool_type).encode()), pool_hash, point.sqrt_price_x96,
                            point.observed_at, point.valid_until, point.nonce]))
    domain = keccak(encode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
                           [keccak(b'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
                            keccak(b'Domino'), keccak(b'2'), chain_id, anchor]))
    return '0x' + keccak(b'\x19\x01' + domain + struct).hex()


class DigestTests(unittest.TestCase):
    def test_the_digest_is_the_f0_golden_and_a_second_implementations(self):
        point = golden_observation()
        digest = observation_digest(4663, GOLDEN_ANCHOR, point)
        self.assertEqual(digest, GOLDENS['digests']['PriceObservation'])
        self.assertEqual(digest, manual_digest(4663, GOLDEN_ANCHOR, point))

    def test_the_domain_binds_the_chain_and_the_anchor(self):
        point = golden_observation()
        digests = {observation_digest(4663, GOLDEN_ANCHOR, point), observation_digest(8453, GOLDEN_ANCHOR, point),
                   observation_digest(4663, '0x' + '00' * 18 + 'd0d1', point)}
        self.assertEqual(len(digests), 3)
        self.assertEqual(observation_digest(8453, GOLDEN_ANCHOR, point), manual_digest(8453, GOLDEN_ANCHOR, point))


class SignerTests(unittest.TestCase):
    def test_the_signature_is_the_one_the_anchor_suite_pins(self):
        signer = ObservationSigner(TEST_KEY, chain_id=4663, anchor=GOLDEN_ANCHOR)
        signed = signer.sign(golden_observation())
        constant = lambda name: re.search(name + r' = (0x[0-9a-fA-F]+|\d+);', ANCHOR_TEST).group(1)
        self.assertEqual(signer.address, constant('GOLDEN_SIGNER').lower())
        r, s, v = signed.signature[:32], signed.signature[32:64], signed.signature[64]
        self.assertEqual(('0x' + r.hex(), '0x' + s.hex(), v),
                         (constant('GOLDEN_R'), constant('GOLDEN_S'), int(constant('GOLDEN_V'))))
        self.assertEqual(recover_signer(4663, GOLDEN_ANCHOR, signed), signer.address)

    def test_signatures_are_canonical_and_bound_to_the_domain(self):
        signer = ObservationSigner(keccak(b'domino.v2.test.publisher'), chain_id=8453, anchor='0x' + 'ab' * 20)
        point = golden_observation()
        for nonce in range(20):
            signed = signer.sign(PriceObservation(point.pool, point.sqrt_price_x96, 1, 2, nonce))
            self.assertLessEqual(int.from_bytes(signed.signature[32:64], 'big'), HALF_ORDER)
            self.assertIn(signed.signature[64], (27, 28))
        self.assertEqual(recover_signer(8453, '0x' + 'ab' * 20, signed), signer.address)
        self.assertNotEqual(recover_signer(4663, '0x' + 'ab' * 20, signed), signer.address)
        self.assertNotEqual(recover_signer(8453, '0x' + 'ac' * 20, signed), signer.address)

    def test_a_malleated_or_malformed_signature_recovers_no_one(self):
        signer = ObservationSigner(TEST_KEY, chain_id=4663, anchor=GOLDEN_ANCHOR)
        signed = signer.sign(golden_observation())
        r, s, v = signed.signature[:32], int.from_bytes(signed.signature[32:64], 'big'), signed.signature[64]
        twin = r + (SECP256K1_N - s).to_bytes(32, 'big') + bytes([55 - v])
        for signature in (twin, signed.signature[:64], signed.signature + b'\x00', r + s.to_bytes(32, 'big') + b'\x01'):
            self.assertIsNone(recover_signer(4663, GOLDEN_ANCHOR, SignedObservation(signed.observation, signature)))

    def test_a_signature_the_anchor_would_not_recover_never_leaves_the_signer(self):
        signer = ObservationSigner(TEST_KEY, chain_id=4663, anchor=GOLDEN_ANCHOR)
        honest = signer._account.sign_message

        def malleated(message):
            signed = honest(message)
            r, s, v = signed.signature[:32], int.from_bytes(signed.signature[32:64], 'big'), signed.signature[64]
            return type('Signed', (), {'signature': r + (SECP256K1_N - s).to_bytes(32, 'big') + bytes([55 - v])})()
        signer._account.sign_message = malleated
        with self.assertRaisesRegex(DataError, '^v2_observation_signature_invalid$'):
            signer.sign(golden_observation())

    def test_keys_and_observations_are_checked(self):
        with self.assertRaises(DataError):
            ObservationSigner(b'\x01' * 31, chain_id=4663, anchor=GOLDEN_ANCHOR)
        pool = golden_observation().pool
        for args in ((pool, 0, 1, 2, 3), (pool, 4295128739, 5, 4, 0), (pool, 4295128739, 1, 2**64, 0)):
            with self.assertRaises(DataError):
                PriceObservation(*args)
        self.assertNotIn(TEST_KEY.hex(), repr(ObservationSigner(TEST_KEY, chain_id=4663, anchor=GOLDEN_ANCHOR)))


class EvidenceTests(unittest.TestCase):
    def test_the_evidence_round_trips_and_is_never_32_bytes(self):
        signed = ObservationSigner(TEST_KEY, chain_id=4663, anchor=GOLDEN_ANCHOR).sign(golden_observation())
        raw = signed.evidence()
        self.assertNotEqual(len(raw), 32)
        self.assertEqual(decode_evidence(raw), signed)
        for bad in (raw[:-1], raw + b'\x00' * 32, (600).to_bytes(32, 'big'), b''):
            with self.assertRaises(DataError):
                decode_evidence(bad)


class FakeReader:
    def __init__(self, price):
        self.price, self.reads = price, []

    def pool(self, pool, block):
        self.reads.append(block)
        return type('State', (), {'sqrt_price_x96': self.price})()


class FakeHistory:
    def __init__(self, prices):
        self.prices, self.reads = prices, []

    def pool_price(self, pool, number):
        self.reads.append(number)
        return self.prices[number]


class PublisherTests(unittest.TestCase):
    PRICE = 2**96

    def setUp(self):
        self.base = chain('base-8453')  # 2 s blocks
        self.signer = ObservationSigner(TEST_KEY, chain_id=8453, anchor='0x' + 'ab' * 20)
        self.pool = PoolRef(4, ZERO, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 500, 10)
        self.head = Block(1000, '0x' + '11' * 32, 1_790_000_000)

    def publisher(self, history, **policy):
        return Publisher(self.base, self.signer, FakeReader(self.PRICE), history, PublisherPolicy(**policy))

    def test_it_signs_the_spot_at_the_head_dated_by_the_block(self):
        history = FakeHistory({994: self.PRICE, 970: self.PRICE + 1})
        signed = self.publisher(history).observe(self.pool, self.head, max_age_seconds=300)
        point = signed.observation
        self.assertEqual((point.pool, point.sqrt_price_x96, point.observed_at, point.valid_until, point.nonce),
                         (self.pool, self.PRICE, self.head.timestamp, self.head.timestamp + 120, 1000))
        self.assertEqual(history.reads, [994, 970])  # 12 s and 60 s back at 2 s per block
        self.assertEqual(recover_signer(8453, '0x' + 'ab' * 20, signed), self.signer.address)

    def test_the_consumers_maximum_age_bounds_the_validity(self):
        history = FakeHistory({994: self.PRICE, 970: self.PRICE})
        signed = self.publisher(history).observe(self.pool, self.head, max_age_seconds=30)
        self.assertEqual(signed.observation.valid_until - signed.observation.observed_at, 30)

    def test_a_price_that_was_not_held_over_the_look_back_is_not_signed(self):
        moved = self.PRICE * 10_051 // 10_000  # a little over 50 bps on the sqrt, about 1% on the price
        for prices in ({994: moved, 970: self.PRICE}, {994: self.PRICE, 970: moved}):
            with self.assertRaises(DataError) as caught:
                self.publisher(FakeHistory(prices)).observe(self.pool, self.head, max_age_seconds=300)
            self.assertEqual(str(caught.exception), 'v2_observation_unstable')

    def test_a_v3_pool_gets_observations_too(self):
        # A v3 vault whose pool's own history cannot guarantee the TWAP window is anchored on the signed spot, as a
        # v4 one (v2_oracle; the owner's decision of 5 Oct 2026): same look-back, same band, the pool's own PoolRef.
        v3 = PoolRef(3, '0x4200000000000000000000000000000000000006', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
                     500, 10)
        history = FakeHistory({994: self.PRICE, 970: self.PRICE})
        signed = self.publisher(history).observe(v3, self.head, max_age_seconds=300)
        self.assertEqual((signed.observation.pool, signed.observation.sqrt_price_x96), (v3, self.PRICE))
        self.assertEqual(recover_signer(8453, '0x' + 'ab' * 20, signed), self.signer.address)
        with self.assertRaisesRegex(DataError, '^v2_observation_unstable$'):
            self.publisher(FakeHistory({994: self.PRICE * 2, 970: self.PRICE})).observe(v3, self.head,
                                                                                      max_age_seconds=300)
        for pool, head in ((('pool',), self.head), (v3, 1000)):
            with self.subTest(pool=pool, head=head), self.assertRaisesRegex(DataError, '^v2_invalid_observation$'):
                self.publisher(history).observe(pool, head, max_age_seconds=300)

    def test_the_band_is_the_anchors(self):
        # AnchorMath.withinBand on the price, both orders, exact at the edge.
        self.assertTrue(within_band(100, 100, 0))
        self.assertTrue(within_band(10_000, 10_050, 101))
        self.assertFalse(within_band(10_000, 10_050, 100))
        self.assertTrue(within_band(10_050, 10_000, 101))
        self.assertFalse(within_band(0, 1, 10_000))


if __name__ == '__main__':
    unittest.main()
