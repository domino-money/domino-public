"""Residual allowance reads retain raw state and never invent revocation."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_abi import encode
from eth_hash.auto import keccak
from pydantic import ValidationError

from deposit_allowances import AllowanceReader
from deposit_contract_fixtures import NOW, HASH, OWNER, selection, build_fixtures
from deposit_models import validate_response
from deposit_receipt import PERMIT2
from discovery import DataError


class Rpc:
    def __init__(self):
        self.calls = []
        self.erc20 = 17
        self.permit = 11
        self.expiration = NOW-1
        self.fail_token = False
        self.changed = False
        self.blocks = 0
        self.chain = 4663

    def request(self, method, params):
        self.calls.append((method, deepcopy(params)))
        if method == 'eth_chainId': return hex(self.chain)
        if method == 'eth_getBlockByNumber':
            self.blocks += 1
            return {'number': '0x64', 'hash': '0x'+'cd'*32 if self.changed and self.blocks > 1 else HASH,
                    'timestamp': hex(NOW)}
        if method == 'eth_call':
            tx, pin = params
            if pin != {'blockHash': HASH, 'requireCanonical': True}: raise AssertionError('unpinned')
            if tx['to'] != PERMIT2:
                if self.fail_token: raise DataError('synthetic_failure')
                self.assert_selector = '0x'+keccak(b'allowance(address,address)')[:4].hex()
                assert tx['data'].startswith(self.assert_selector)
                return '0x'+encode(['uint256'], [self.erc20]).hex()
            assert tx['data'].startswith('0x'+keccak(b'allowance(address,address,address)')[:4].hex())
            return '0x'+encode(['uint160','uint48','uint48'], [self.permit, self.expiration, 9]).hex()
        raise AssertionError('unexpected RPC '+method)


class DepositAllowanceTests(unittest.TestCase):
    def read(self, rpc, native=False):
        return AllowanceReader(rpc, clock=lambda: NOW).read(OWNER, selection(native))

    def test_expired_permit_never_expires_the_persistent_erc20_allowance(self):
        rpc = Rpc()
        result = self.read(rpc)
        self.assertEqual(len(result['observations']), 2)
        for row in result['observations']:
            self.assertEqual((row['erc20Status'], row['erc20AllowanceRaw']), ('observed', '17'))
            self.assertEqual((row['permit2Status'], row['permit2AllowanceRaw']), ('expired', '11'))
            self.assertEqual(row['revocationGuidance'], 'wallet_erc20_approve_zero_and_permit2_approve_zero')
        self.assertLessEqual(len(rpc.calls), 8)
        self.assertEqual(set(method for method,_ in rpc.calls), {'eth_chainId','eth_getBlockByNumber','eth_call'})

    def test_boundary_active_zero_and_native_currency_require_no_approval(self):
        rpc=Rpc();rpc.expiration=NOW
        self.assertEqual(self.read(rpc, native=True)['observations'][0]['permit2Status'], 'active')
        rpc=Rpc();rpc.permit=0;rpc.erc20=0
        row=self.read(rpc)['observations'][0]
        self.assertEqual(row['permit2Status'], 'zero')
        self.assertEqual(row['erc20AllowanceRaw'], '0')

    def test_missing_token_read_is_null_and_other_allowance_remains_observed(self):
        rpc=Rpc();rpc.fail_token=True
        row=self.read(rpc)['observations'][0]
        self.assertEqual((row['erc20Status'],row['erc20AllowanceRaw']), ('unavailable',None))
        self.assertEqual(row['permit2AllowanceRaw'], '11')

    def test_changed_chain_snapshot_and_stale_read_are_rejected(self):
        rpc=Rpc();rpc.changed=True
        with self.assertRaisesRegex(DataError, 'allowance_snapshot_changed'): self.read(rpc)
        rpc=Rpc();rpc.chain=1
        with self.assertRaisesRegex(DataError, 'allowance_chain_mismatch'): self.read(rpc)
        with self.assertRaisesRegex(DataError, 'allowance_snapshot_stale'):
            AllowanceReader(Rpc(),clock=lambda:NOW+121).read(OWNER,selection())

    def test_contract_rejects_fake_current_values_identity_or_revocation_authority(self):
        response=build_fixtures()[1]['allowances']
        for changes in ({'erc20AllowanceRaw':None},{'currency':OWNER},
                        {'permit2Status':'active'}, {'permit2AllowanceRaw':str(2**160)},
                        {'revocationGuidance':'revoked_automatically'}):
            bad=deepcopy(response);bad['allowances']['observations'][0].update(changes)
            with self.subTest(changes=changes),self.assertRaises(ValidationError): validate_response('allowances',bad)
