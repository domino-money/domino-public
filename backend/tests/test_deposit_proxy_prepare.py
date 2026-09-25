"""Admission integration across composition and already-persisted handoffs."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

from eth_abi import encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deposit_models import DepositError
from deposit_prepare import DirectDepositPreparer, validate_admission_manifest
from discovery import ZERO
from token_admission import POLICY, IMPLEMENTATION_SLOT, ADMIN_SLOT, BEACON_SLOT, ZERO_WORD, digest
from test_deposit_prepare import Rpc, Provider, CODE_HASH, OWNER, TOKEN0, TOKEN1, NOW, selection, signed_manifest
from test_token_admission import profile, seal, word
from uniswap_position import UniswapPosition


def reviewed_manifest():
    value = signed_manifest()
    value.update(schemaVersion=2, policyVersion=POLICY)
    profiles = []
    for i, currency in enumerate((TOKEN0, TOKEN1)):
        p = profile('erc1967_uups')
        p.update(address=currency, codeHash=CODE_HASH,
            implementation={'address': '0x' + str(i + 4) * 40, 'codeHash': CODE_HASH},
            stateStorage=[{'slot': word(4), 'mask': word(0xff << 160), 'value': ZERO_WORD}],
            accountStorage=[{'slot': word(6), 'mask': word(0xff), 'value': ZERO_WORD,
                             'accounts': ['owner', 'permit2', 'pool_manager']}])
        profiles.append(seal(p))
    value['tokens'] = profiles
    return seal(value, 'manifestId')


class ProxyRpc(Rpc):
    def __init__(self):
        super().__init__()
        self.manifest = reviewed_manifest()
        self.storage = {}
        for p in self.manifest['tokens']:
            self.storage[p['address'], IMPLEMENTATION_SLOT] = word(p['implementation']['address'])
    def _result(self, method, params):
        if method == 'eth_getStorageAt':
            assert set(params[-1]) == {'blockHash', 'requireCanonical'}
            return self.storage.get((params[0], params[1]), ZERO_WORD)
        return super()._result(method, params)


class ProxyPreparationTests(unittest.TestCase):
    def setup_flow(self):
        rpc, provider = ProxyRpc(), Provider()
        preparer = DirectDepositPreparer(UniswapPosition('offline-test', transport=provider,
            clock=lambda: NOW), lambda: rpc, admission=rpc.manifest, clock=lambda: NOW)
        return rpc, provider, preparer

    def denied(self, callback, code):
        with self.assertRaises(DepositError) as caught: callback()
        self.assertEqual(caught.exception.code, code)

    def test_reviewed_identity_is_bound_and_rechecked_on_redelivery(self):
        rpc, provider, preparer = self.setup_flow()
        artifact = preparer.prepare(OWNER, selection())
        self.assertEqual(artifact['admission']['policyVersion'], POLICY)
        self.assertEqual(artifact['admission']['tokenReviews'],
            [{'address': p['address'], 'reviewId': p['reviewId']} for p in rpc.manifest['tokens']])
        self.assertEqual(len(provider.calls), 1)
        before = len(rpc.calls)
        preparer.revalidate(OWNER, selection(), artifact)
        self.assertGreater(len(rpc.calls), before)
        self.assertEqual(len(provider.calls), 1)  # Re-delivery never recomposes calldata.
        rpc.storage[TOKEN0, IMPLEMENTATION_SLOT] = word('0x' + '9'*40)
        self.denied(lambda: preparer.revalidate(OWNER, selection(), artifact), 'deposit_token_changed')

    def test_upgrade_during_provider_composition_never_emits_wallet_artifact(self):
        rpc, provider, preparer = self.setup_flow()
        provider.after = lambda: rpc.storage.__setitem__((TOKEN1, IMPLEMENTATION_SLOT), word('0x'+'8'*40))
        self.denied(lambda: preparer.prepare(OWNER, selection()), 'deposit_token_changed')

    def test_pause_freeze_or_missing_reads_block_handoff_without_recomposition(self):
        for mode in ('pause', 'freeze', 'missing'):
            with self.subTest(mode=mode):
                rpc, provider, preparer = self.setup_flow()
                artifact = preparer.prepare(OWNER, selection())
                if mode == 'pause':
                    rpc.storage[TOKEN0, word(4)] = word(1 << 160)
                elif mode == 'freeze':
                    slot = '0x' + keccak(encode(['address','uint256'], [OWNER,6])).hex()
                    rpc.storage[TOKEN0, slot] = word(1)
                else:
                    rpc.storage[TOKEN0, IMPLEMENTATION_SLOT] = 'invalid'
                code = 'deposit_token_check_unavailable' if mode == 'missing' else 'deposit_token_restricted'
                self.denied(lambda: preparer.revalidate(OWNER, selection(), artifact), code)
                self.assertEqual(len(provider.calls), 1)

    def test_changed_manifest_or_wallet_state_cannot_reuse_old_handoff(self):
        for mode in ('manifest', 'owner_code', 'nonce'):
            with self.subTest(mode=mode):
                rpc, _, preparer = self.setup_flow()
                artifact = preparer.prepare(OWNER, selection())
                if mode == 'manifest':
                    preparer.admission['reviewReference'] = 'new reviewed policy'
                    seal(preparer.admission, 'manifestId')
                elif mode == 'owner_code': rpc.codes[OWNER] = '0x6000'
                else: rpc.final_nonce += 1
                self.denied(lambda: preparer.revalidate(OWNER, selection(), artifact),
                    'deposit_token_changed' if mode == 'manifest' else 'deposit_state_changed')

    def test_a_delegated_owner_redelivers_while_its_code_stays_a_designator(self):
        rpc, provider, preparer = self.setup_flow()
        rpc.codes[OWNER] = '0xef0100' + 'ab' * 20
        artifact = preparer.prepare(OWNER, selection())
        preparer.revalidate(OWNER, selection(), artifact)
        self.assertEqual(len(provider.calls), 1)
        rpc.codes[OWNER] = '0x6000'
        self.denied(lambda: preparer.revalidate(OWNER, selection(), artifact), 'deposit_state_changed')

    def test_archived_profile_does_not_authorize_a_new_deposit(self):
        rpc, provider, _ = self.setup_flow()
        value = deepcopy(rpc.manifest)
        value['reviewArchive'] = [value['tokens'].pop()]
        seal(value, 'manifestId')
        validate_admission_manifest(value, now=NOW)
        preparer = DirectDepositPreparer(UniswapPosition('offline-test', transport=provider,
            clock=lambda: NOW), lambda: rpc, admission=value, clock=lambda: NOW)
        self.denied(lambda: preparer.prepare(OWNER, selection()), 'deposit_admission_required')
        self.assertFalse(provider.calls)


if __name__ == '__main__':
    unittest.main()
