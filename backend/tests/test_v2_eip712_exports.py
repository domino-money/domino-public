"""The V2 EIP-712 exports must match contracts/src/v2/DominoV2Types.sol.

scripts/v2/eip712_exports.py recomputes the typehashes and fixture digests with
eth_account, a second implementation of EIP-712, and renders the committed JSON
exports and the Solidity goldens. These tests fail when any of them is stale,
and pin a few properties the app and backend rely on.
"""
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/v2/eip712_exports.py'


def load_exporter():
    spec = importlib.util.spec_from_file_location('v2_eip712_exports', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class V2Eip712ExportsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.exporter = load_exporter()
        cls.exports, cls.goldens, cls.solidity = cls.exporter.build()

    def test_committed_exports_are_current(self):
        rendered = {
            self.exporter.OUT_TYPES: self.exporter.render_json(self.exports),
            self.exporter.OUT_GOLDENS: self.exporter.render_json(self.goldens),
            self.exporter.OUT_SOL: self.solidity,
        }
        for path, text in rendered.items():
            with self.subTest(path=str(path.relative_to(ROOT))):
                self.assertEqual(path.read_text(), text, 'run scripts/v2/eip712_exports.py and commit the result')

    def test_every_signed_type_is_exported_with_its_nested_types(self):
        encoded = self.exports['encodedTypes']
        self.assertEqual(set(encoded), {'PoolRef', 'PriceObservation', 'PositionIntent', 'ExitMandate'})
        self.assertTrue(encoded['PositionIntent'].endswith(self.exports['typeStrings']['PoolRef']))
        self.assertTrue(encoded['PriceObservation'].endswith(self.exports['typeStrings']['PoolRef']))

    def test_permit2_witness_is_the_position_intent(self):
        permit2 = self.exports['permit2']
        self.assertEqual(permit2['witnessType'], 'PositionIntent')
        self.assertTrue(permit2['witnessTypeString'].startswith('PositionIntent witness)'))
        self.assertTrue(permit2['witnessTypeString'].endswith('TokenPermissions(address token,uint256 amount)'))
        self.assertEqual(permit2['domain']['verifyingContract'], '0x000000000022D473030F116dDEE9F6B43aC78BA3')

    def test_fee_bps_in_the_intent_fixture_is_the_assisted_swap_tariff(self):
        self.assertEqual(self.goldens['fixtures']['PositionIntent']['feeBps'], 65)

    def test_exports_are_valid_json(self):
        for path in (self.exporter.OUT_TYPES, self.exporter.OUT_GOLDENS):
            json.loads(path.read_text())


if __name__ == '__main__':
    unittest.main()
