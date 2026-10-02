"""The plan codec reproduces the F0/F2 goldens and encodes the exported zap functions."""
import json
from pathlib import Path
import sys
import unittest

from eth_abi import decode
from eth_account import Account
from eth_account.messages import _hash_eip191_message, encode_typed_data
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import v2_plan_codec as codec  # noqa: E402
from v2_abi import function  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
GOLDENS = json.loads((ROOT / 'api-contracts/v2/eip712-goldens.json').read_text())
EMPTY_ROUTES_HASH = '0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd'


def golden_intent(name='PositionIntent'):
    raw = GOLDENS['fixtures'][name]
    intent = raw if name == 'PositionIntent' else raw['intent']
    out = dict(intent)
    for key in ('tokenId', 'minLiquidity', 'nonce', 'deadline'):
        out[key] = str(intent[key])
    return out


def wallet_digest(typed):
    """What a wallet signs for this JSON: eth_account's own EIP-712 encoder."""
    return '0x' + _hash_eip191_message(encode_typed_data(full_message=typed)).hex()


class GoldenTests(unittest.TestCase):
    def test_routes_hash(self):
        self.assertEqual(codec.routes_hash([]), EMPTY_ROUTES_HASH)
        legs = [{**leg, 'amountIn': str(leg['amountIn']), 'minAmountOut': str(leg['minAmountOut'])}
                for leg in GOLDENS['fixtures']['SwapLeg']]
        self.assertEqual(codec.routes_hash(legs), GOLDENS['routesHash'])

    def test_domain_and_intent_hash(self):
        domain = GOLDENS['domain']
        self.assertEqual(codec.hexed(codec.domain_separator(domain['chainId'], domain['verifyingContract'])),
                         GOLDENS['domainSeparator'])
        intent = golden_intent()
        self.assertEqual(codec.hexed(codec.hash_intent(intent)), GOLDENS['structHashes']['PositionIntent'])
        self.assertEqual(codec.intent_hash(domain['chainId'], domain['verifyingContract'], intent),
                         GOLDENS['digests']['PositionIntent'])

    def test_permit2_batch_witness(self):
        domain = GOLDENS['domain']
        permit = GOLDENS['fixtures']['Permit2']
        intent = golden_intent()
        digest = codec.permit2_digest(domain['chainId'], permit['spender'], permit, intent)
        self.assertEqual(digest, GOLDENS['digests']['Permit2BatchWitness'])
        typed = codec.permit2_typed_data(domain['chainId'], permit['spender'], permit, intent)
        self.assertEqual(wallet_digest(typed), digest)
        self.assertNotIn('version', typed['domain'])
        self.assertEqual([f['name'] for f in typed['types']['EIP712Domain']], ['name', 'chainId', 'verifyingContract'])

    def test_relayed_position_action(self):
        domain = GOLDENS['domain']
        fixture = GOLDENS['fixtures']['RelayedPositionAction']
        relayed = {**{k: str(v) for k, v in fixture.items() if k not in ('intent', 'burn')},
                   'intent': golden_intent('RelayedPositionAction'), 'burn': fixture['burn']}
        self.assertEqual(codec.hexed(codec.hash_relayed(relayed)), GOLDENS['structHashes']['RelayedPositionAction'])
        digest = codec.relayed_digest(domain['chainId'], domain['verifyingContract'], relayed)
        self.assertEqual(digest, GOLDENS['digests']['RelayedPositionAction'])
        typed = codec.relayed_typed_data(domain['chainId'], domain['verifyingContract'], relayed)
        self.assertEqual(wallet_digest(typed), digest)

    def test_an_exit_signs_its_caps_as_zero_and_a_change_of_range_its_caps(self):
        intent = golden_intent('RelayedPositionAction')
        exit_plan = {'intent': intent, 'liquidityToRemove': '5', 'amount0MinRemoved': '1', 'amount1MinRemoved': '2',
                     'legs': [], 'burn': True}
        self.assertEqual(codec.relayed_fields('exit', exit_plan)['amount0Max'], '0')
        change = {**exit_plan, 'amount0Max': '7', 'amount1Max': '8', 'burnOld': False}
        fields = codec.relayed_fields('changeRange', change)
        self.assertEqual((fields['amount0Max'], fields['amount1Max'], fields['burn']), ('7', '8', False))


class CallTests(unittest.TestCase):
    def plan(self):
        intent = golden_intent()
        legs = [{**leg, 'amountIn': str(leg['amountIn']), 'minAmountOut': str(leg['minAmountOut'])}
                for leg in GOLDENS['fixtures']['SwapLeg']]
        return {'intent': intent, 'inputs': [{'token': GOLDENS['fixtures']['Permit2']['permitted'][0]['token'],
                                               'amount': '1000000000'}],
                'legs': legs, 'amount0Max': str(2**128 - 1), 'amount1Max': str(2**128 - 1), 'initSqrtPriceX96': '0'}

    def test_create_encodes_through_the_export(self):
        plan = self.plan()
        data = codec.call_data('create', 'direct', plan)
        fn = function('IDominoPositionActions', 'create')
        self.assertEqual(data[:10], fn.selector)
        self.assertEqual(fn.selector, '0x0e97b041')
        decoded, = decode(list(fn.inputs), bytes.fromhex(data[10:]))
        self.assertEqual(decoded[0][9].lower(), plan['intent']['recipient'])
        self.assertEqual(decoded[2][0][6], bytes.fromhex('deadbeef'))

    def test_permit_and_relayed_selectors(self):
        plan = self.plan()
        permit = {'permitted': plan['inputs'], 'nonce': '42', 'deadline': '1790871000'}
        data = codec.call_data('create', 'permit2', plan, permit=permit, signature='0x' + '11' * 65)
        self.assertEqual(data[:10], '0xec627dfe')
        exit_plan = {'intent': {**plan['intent'], 'action': 4}, 'liquidityToRemove': '1', 'amount0MinRemoved': '0',
                     'amount1MinRemoved': '0', 'legs': [], 'burn': False}
        self.assertEqual(codec.call_data('exit', 'direct', exit_plan)[:10], '0xda5951bb')
        self.assertEqual(codec.call_data('exit', 'relayed', exit_plan, signature='0x' + '22' * 65)[:10], '0x2573777b')
        with self.assertRaisesRegex(codec.CodecError, 'plan_consent_invalid'):
            codec.call_data('exit', 'permit2', exit_plan)

    def test_a_signed_permit_recovers_to_the_signer(self):
        account = Account.create('domino s1 codec test')
        domain = GOLDENS['domain']
        intent = {**golden_intent(), 'recipient': account.address.lower()}
        permit = {'permitted': [{'token': codec.ZERO[:-1] + '1', 'amount': '5'}], 'nonce': '42', 'deadline': '9'}
        typed = codec.permit2_typed_data(domain['chainId'], '0x' + 'd0' * 20, permit, intent)
        signed = Account.sign_typed_data(account.key, full_message=typed)
        self.assertEqual('0x' + signed.message_hash.hex().removeprefix('0x'),
                         codec.permit2_digest(domain['chainId'], '0x' + 'd0' * 20, permit, intent))

    def test_the_value_is_the_native_inputs(self):
        plan = {'inputs': [{'token': codec.ZERO, 'amount': '7'}, {'token': '0x' + '11' * 20, 'amount': '9'}]}
        self.assertEqual(codec.direct_value(plan), 7)

    def test_the_eip712_export_is_self_consistent(self):
        export = codec.eip712_export()
        self.assertEqual(export['typehashes']['PositionIntent'], '0x' + keccak(
            export['encodedTypes']['PositionIntent'].encode()).hex())


if __name__ == '__main__':
    unittest.main()
