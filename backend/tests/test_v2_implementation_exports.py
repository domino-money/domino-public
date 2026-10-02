"""The deployable V2 contracts' events and errors (api-contracts/v2/implementations, F7 D7), checked offline.

scripts/v2/export-abi.mjs writes them from the same compilation as the frozen
interface exports, and its --check runs in the Contracts CI job. Here: every
topic and selector is the Keccak-256 of its canonical signature, the zap's
receipt events are the ones F2 documents with F7's topics, every error the zap
can surface (its steps' included) is listed, and the S1 planner names
simulation reverts with the same selectors.
"""
import json
from pathlib import Path
import sys
import unittest

from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from v2_position_plan import ERRORS  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / 'api-contracts/v2/implementations'
# F7 §2.11's topic0 table.
RECEIPT_TOPICS = {
    'SwapLegExecuted(uint8,address,address,address,uint256,uint256)': '0x60154ef230959d31cc953d02fea179f08acb4195f22d3ac43bc9ce7219c0cf31',
    'FeeCharged(uint8,address,address,uint256,bytes32)': '0x9a37304a80e9ccbeef339119cc8e57118bbbf4ba4b01df2a1ef6a0dc843a7bca',
    'FeeDeferred(address,uint256,uint256)': '0xf48e46df15f5fe31c1c79e6219014406d25e1f90301334682c98267482a8221b',
    'InputPulled(bytes32,address,address,uint256)': '0xc9ee6073c7a83985d230183c509eada6d701370f470716bde0c37568a49711ad',
    'PositionLiquidityChanged(bytes32,address,uint256,(uint8,address,address,uint24,int24,address),int256,int256,int256)':
        '0xf6a97c0d2054864127258f1e392259b35bdb4e5360f3f78285bf30675b4b8b9a',
    'Refunded(address,address,uint256)': '0xec1e5ed733e00f1a00915d56caef57b4f52312dde4f9b3165f213319a0da156b',
    'PositionActionExecuted(uint8,address,uint256,uint256,uint128,bytes32)':
        '0xa7c6a820069d8f01991283e8f527fa1678590447c17064fd43148892d2863a92',
    'NoncesInvalidated(address,uint256,uint256)': '0x41a696ce0dbffb78931eef7ecfa24d3ab6270c8a321cc6564df24b38f16c4e4f',
}


def load(name):
    return json.loads((DIRECTORY / name).read_text())


def surface(component):
    index = load('index.json')
    topics, selectors = {}, {}
    for name in index['components'][component]:
        topics.update(index['contracts'][name]['eventTopics'])
        selectors.update(index['contracts'][name]['errorSelectors'])
    return topics, selectors


class ImplementationExportTests(unittest.TestCase):
    def test_every_topic_and_selector_is_the_keccak_of_its_signature(self):
        index = load('index.json')
        for name, entry in index['contracts'].items():
            export = load(name + '.json')
            self.assertEqual({k: export[k] for k in ('source', 'eventTopics', 'errorSelectors')}, entry)
            for signature, topic in entry['eventTopics'].items():
                self.assertEqual(topic, '0x' + keccak(signature.encode()).hex())
            for signature, selector in entry['errorSelectors'].items():
                self.assertEqual(selector, '0x' + keccak(signature.encode())[:4].hex())
            self.assertEqual(len(export['abi']), len(entry['eventTopics']) + len(entry['errorSelectors']))

    def test_the_components_are_the_deployment_manifests(self):
        components = load('index.json')['components']
        self.assertEqual(set(components), {'registry', 'priceAnchor', 'autoExit', 'vaultSwap', 'vault.v3', 'vault.v4',
                                           'vaultFactory.v3', 'vaultFactory.v4', 'zap.v4.steps', 'zap.v3', 'zap.v4',
                                           'vaultExecutor.v3', 'vaultExecutor.v4'})

    def test_the_zaps_surface_their_receipt_events_and_every_error(self):
        for component in ('zap.v3', 'zap.v4'):
            topics, selectors = surface(component)
            with self.subTest(component=component):
                self.assertEqual({k: topics[k] for k in RECEIPT_TOPICS}, RECEIPT_TOPICS)
                for signature in ('InsufficientLiquidity(uint128,uint128)', 'PartialBurn(uint256,uint128,uint128)',
                                  'PositionPoolMismatch(uint256)', 'InvalidRange(int24,int24,int24)', 'InvalidPlan()',
                                  'FeeMismatch()', 'SwapEffectMismatch()', 'TokenCallFailed(address)'):
                    self.assertIn(signature, selectors)
        _, v4 = surface('zap.v4')
        self.assertIn('OpenDelta(int256,int256)', v4)
        self.assertIn('DirectCall()', v4)

    def test_the_planner_names_reverts_with_the_compiled_selectors(self):
        compiled = {}
        for component in ('zap.v3', 'zap.v4'):
            compiled.update(surface(component)[1])
        for signature, selector in compiled.items():
            if signature in ERRORS.values():
                self.assertEqual(ERRORS[selector], signature)
        domino = [s for s in ERRORS.values() if s in compiled]
        self.assertGreaterEqual(len(domino), 25)


if __name__ == '__main__':
    unittest.main()
