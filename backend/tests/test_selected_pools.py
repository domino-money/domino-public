"""The backend registration manifest must follow the reviewed product selection."""
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from discovery import DataError, address, bytes32
from selected_pools import CHAIN_SELECTED_POOLS, SELECTED_POOLS
from v2_chains import default_registry
from v2_uniswap import v3_pool_address

APP_CONFIG=Path(__file__).resolve().parents[2]/'app'/'src'/'config'/'selectedPools.ts'


def app_block(name):
    """The text of one exported constant of the app's file, up to its closing bracket at the line start."""
    match=re.search(r'^export const '+name+r'\b.*?^[\]}]$',APP_CONFIG.read_text(),re.M|re.S)
    assert match,name
    return match.group(0)


class SelectedPoolManifestTests(unittest.TestCase):
    def test_ids_are_well_formed_and_unique(self):
        self.assertEqual(len(SELECTED_POOLS),6)
        self.assertEqual(len(set(SELECTED_POOLS)),len(SELECTED_POOLS))
        for pool_id in SELECTED_POOLS:
            with self.subTest(pool_id=pool_id):
                self.assertEqual(bytes32(pool_id),pool_id)

    def test_manifest_matches_the_frontend_selection_in_order(self):
        # Robinhood's list is its own constant: an id of another chain's list never counts as one of its six.
        listed=re.findall(r"'(0x[0-9a-f]{64})'",app_block('SELECTED_POOLS'))
        self.assertTrue(listed)
        self.assertEqual(listed,list(SELECTED_POOLS))

    def test_each_chain_s_list_starts_with_its_profile_s_verified_weth_usdc_pool(self):
        # 4 Nov 2026: the WETH/USDC 0.05% v3 pool each profile checked on chain (getPool equals its CREATE2
        # address), recomputed here from the profile's factory and init code hash.
        registry=default_registry()
        self.assertEqual(sorted(CHAIN_SELECTED_POOLS),[8453,42161])
        for chain_id,pools in CHAIN_SELECTED_POOLS.items():
            with self.subTest(chain=chain_id):
                chain=registry.chain(chain_id)
                stable,weth=chain.chargeCurrencies[0].address,chain.wrappedNative.address
                expected=v3_pool_address(chain,*sorted((stable,weth)),500)
                self.assertEqual(pools[0],expected)
                record=next(item for item in chain.verification.contracts if item.address==expected)
                self.assertTrue(record.name.startswith('v3 pool WETH/USDC fee 500'),record.name)
                self.assertEqual(len(set(pools)),len(pools))
                for pool_id in pools:
                    self.assertEqual(address(pool_id) if len(pool_id)==42 else bytes32(pool_id),pool_id)

    def test_manifest_rejects_rubbish(self):
        with self.assertRaises(DataError):
            bytes32('0x'+'00'*31)


if __name__=='__main__':unittest.main()
