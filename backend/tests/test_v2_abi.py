"""The backend's calls are built from the frozen V2 ABI exports, never re-declared."""
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

from eth_abi import decode, encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import DataError
import v2_abi
from v2_abi import ABI_DIRECTORY, event, events, function, interface


class ExportTests(unittest.TestCase):
    def test_every_export_loads_with_the_compiler_selectors(self):
        index = json.loads((ABI_DIRECTORY / 'index.json').read_text())
        for name, entry in index.items():
            with self.subTest(interface=name):
                functions = interface(name)
                self.assertEqual({f.signature: f.selector for f in functions.values()}, entry['functions'])
                for fn in functions.values():
                    self.assertEqual(fn.selector, '0x' + keccak(fn.signature.encode()).hex()[:8])

    def test_tuple_types_are_canonical(self):
        info = function('IV4PositionManagerMinimal', 'getPoolAndPositionInfo')
        self.assertEqual((info.signature, info.outputs, info.view),
                         ('getPoolAndPositionInfo(uint256)', ('(address,address,uint24,int24,address)', 'uint256'), True))
        create = function('IDominoPositionActions', 'create')
        self.assertTrue(create.signature.startswith('create(((uint8,(uint8,address,address,uint24,int24,address),'))
        self.assertFalse(create.view)
        positions = function('IUniswapV3PositionManagerMinimal', 'positions')
        self.assertEqual(len(positions.outputs), 12)

    def test_calls_encode_and_decode_through_the_export(self):
        ticks = function('IUniswapV3PoolMinimal', 'ticks')
        self.assertEqual(ticks.calldata(-600), ticks.selector + encode(['int24'], [-600]).hex())
        raw = '0x' + encode(list(ticks.outputs), [1, -2, 3, 4, -5, 6, 7, True]).hex()
        self.assertEqual(ticks.decode(raw), (1, -2, 3, 4, -5, 6, 7, True))
        self.assertEqual(decode(['int24'], bytes.fromhex(ticks.calldata(-600)[10:])), (-600,))
        with self.assertRaisesRegex(DataError, '^invalid_abi_response$'):
            ticks.decode('0x')

    def test_unknown_names_are_refused(self):
        for name in ('IUnknown', 'not-an-interface', '../chains/base-8453', None):
            with self.subTest(name=name), self.assertRaisesRegex(DataError, '^v2_abi_interface_unknown$'):
                interface(name)
        with self.assertRaisesRegex(DataError, '^v2_abi_function_unknown$'):
            function('IV4StateViewMinimal', 'getTickInfo')


class StaleExportTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.directory)
        shutil.copy(ABI_DIRECTORY / 'IV4StateViewMinimal.json', self.directory)
        self.path = self.directory / 'IV4StateViewMinimal.json'
        v2_abi.interface.cache_clear()
        self.addCleanup(v2_abi.interface.cache_clear)

    def edit(self, mutate):
        export = json.loads(self.path.read_text())
        mutate(export)
        self.path.write_text(json.dumps(export))

    def test_the_copy_loads(self):
        self.assertIn('getSlot0', interface('IV4StateViewMinimal', self.directory))

    def test_an_export_out_of_step_with_its_abi_is_refused(self):
        def wrong_selector(export):
            export['functions']['getLiquidity(bytes32)'] = '0x00000000'

        def missing_selector(export):
            del export['functions']['getLiquidity(bytes32)']

        def extra_selector(export):
            export['functions']['getTickInfo(bytes32,int24)'] = '0x7c40f1fe'

        def changed_input(export):
            next(item for item in export['abi'] if item.get('name') == 'getLiquidity')['inputs'][0]['type'] = 'uint256'

        def overloaded(export):
            export['abi'].append(dict(next(item for item in export['abi'] if item.get('name') == 'getLiquidity')))

        for mutate in (wrong_selector, missing_selector, extra_selector, changed_input, overloaded):
            with self.subTest(case=mutate.__name__):
                shutil.copy(ABI_DIRECTORY / 'IV4StateViewMinimal.json', self.directory)
                self.edit(mutate)
                v2_abi.interface.cache_clear()
                with self.assertRaisesRegex(DataError, '^v2_abi_export_invalid$'):
                    interface('IV4StateViewMinimal', self.directory)

    def test_an_unreadable_or_oversized_export_is_refused(self):
        self.path.write_text('{')
        with self.assertRaisesRegex(DataError, '^v2_abi_export_invalid$'):
            interface('IV4StateViewMinimal', self.directory)
        v2_abi.interface.cache_clear()
        self.path.write_text((ABI_DIRECTORY / 'IV4StateViewMinimal.json').read_text() + ' ' * v2_abi.MAX_EXPORT_BYTES)
        with self.assertRaisesRegex(DataError, '^v2_abi_export_invalid$'):
            interface('IV4StateViewMinimal', self.directory)



class EventTests(unittest.TestCase):
    def test_every_exported_event_loads_with_its_topic(self):
        index = json.loads((ABI_DIRECTORY / 'index.json').read_text())
        total = 0
        for name in index:
            for item in events(name).values():
                self.assertEqual(item.topic, '0x' + keccak(item.signature.encode()).hex())
                total += 1
        self.assertGreater(total, 30)
        # The signatures the automation reads, rebuilt by hand.
        self.assertEqual(event('IDominoVaultExecution', 'Executed').topic,
                         '0x' + keccak(b'Executed(bytes32,uint8,uint64)').hex())
        self.assertEqual(event('IDominoFeeEvents', 'FeeCharged').signature,
                         'FeeCharged(uint8,address,address,uint256,bytes32)')

    def test_a_log_decodes_by_name_and_only_against_its_own_shape(self):
        created = event('IDominoVaultFactory', 'VaultCreated')
        owner, vault = '0x' + '11' * 20, '0x' + '22' * 20
        log = {'topics': [created.topic, '0x' + encode(['address'], [owner]).hex(),
                          '0x' + encode(['address'], [vault]).hex(), '0x' + encode(['uint256'], [77]).hex()],
               'data': '0x' + encode(['uint8', 'uint256'], [4, 3]).hex()}
        self.assertEqual(created.decode(log), {'owner': owner, 'vault': vault, 'rootTokenId': 77, 'dex': 4,
                                               'ownerNonce': 3})
        bad = [dict(log, topics=log['topics'][:3]), dict(log, topics=[event('IDominoVault', 'RootRearmed').topic]
                                                            + log['topics'][1:]),
               dict(log, data=log['data'] + '00' * 32), dict(log, data='0xzz')]
        for item in bad:
            with self.assertRaisesRegex(DataError, '^v2_abi_event_mismatch$'):
                created.decode(item)
        with self.assertRaisesRegex(DataError, '^v2_abi_event_unknown$'):
            event('IDominoVaultFactory', 'Created')


if __name__ == '__main__':
    unittest.main()
