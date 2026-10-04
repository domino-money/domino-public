"""The V2 automation service's configuration and command line, and its return of a closed vault's reserves."""
import contextlib
import copy
from dataclasses import replace
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_abi import encode
from eth_hash.auto import keccak

from discovery import DataError, parse_block
from v2_automation import ChainAutomation, build, checked_config, load_automation_config, main
from v2_chains import chain as profile
from v2_executor import CallReverted
from v2_manifest import checked_deployment
from v2_observation import PublisherPolicy
from v2_plan import return_reserves_calldata, return_subject
from v2_planner import PlannerConfig
from test_v2_manifest import manifest_document
from test_v2_planner import member, vault_state

OPERATOR, PUBLISHER = '0x' + '04' * 20, '0x' + '05' * 20


def document(**changes):
    config = {
        'schemaVersion': 1, 'kind': 'domino-v2-automation', 'chain': 'base-8453',
        'deploymentFile': '/etc/domino/v2/base-8453/deployment.json',
        'rpc': {'chainRpcFile': '/etc/domino/v2/chain-rpc.json'},
        'headFile': '/run/domino-v2/base-8453.head.json',
        'journalFile': '/var/lib/domino-v2-automation/base-8453/journal.sqlite',
        'operator': {'address': OPERATOR, 'keystoreFile': '/etc/domino/v2/automation/operator.keystore.json',
                     'credential': 'v2-operator-keystore-password'},
        'publisher': {'address': PUBLISHER, 'keystoreFile': '/etc/domino/v2/automation/publisher.keystore.json',
                      'credential': 'v2-publisher-keystore-password'},
        'gas': {'maxGas': 3_000_000, 'maxFeePerGas': 2 * 10**9, 'priorityFeePerGas': 10**6,
                'maxCostWei': 3 * 10**15, 'dailyCapWei': 5 * 10**16, 'minBalanceWei': 10**16, 'confirmations': 3,
                'enabled': False},
        'planner': {'deadlineSeconds': 120, 'ownerHorizonSeconds': 604800, 'forecastHaircutBps': 2000},
        'observations': {'validitySeconds': 120, 'lookbackSeconds': [12, 60], 'maxDeviationBps': 50},
        'priceReferences': [{'token': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                             'pool': {'dex': 3, 'currency0': '0x4200000000000000000000000000000000000006',
                                      'currency1': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'fee': 500,
                                      'tickSpacing': 10, 'hooks': '0x' + '00' * 20}}],
        'earningsWindowSeconds': 3600, 'twapSeconds': 600, 'exitTwapSeconds': 600, 'deadlineSeconds': 120,
        'passSeconds': 10, 'headMaxAgeSeconds': 2, 'autoExit': True,
        # The owner's decisions of 2 Oct 2026.
        'vaultDefaults': {'mode': None,
                          'policy': {'triggerDistanceBps': 500, 'maxOverlapBps': 2000, 'minimumIntervalSeconds': 600,
                                     'maxPositions': 3},
                          'limits': {'maxSlippageBps': 100, 'maxPriceImpactBps': 100, 'maxObservationAgeSeconds': 300,
                                     'upsideBps': 5000},
                          'startPaused': False,
                          'ownerMaxima': {'maxSlippageBps': 500, 'maxPriceImpactBps': 500},
                          'exitMaxSlippageBps': 100},
        'vaultGasCeilingWei': None,
        'vaultGasCeilingsWei': {'0x' + 'cA' * 20: 10**15},
        'waitingFile': '/run/domino-v2/base-8453.waiting.json',
    }
    config.update(changes)
    return config


class ConfigTests(unittest.TestCase):
    def test_a_complete_configuration_loads(self):
        config = checked_config(document())
        self.assertEqual(config.chain.key, 'base-8453')
        self.assertEqual((config.operator.address, config.publisher.credential),
                         (OPERATOR, 'v2-publisher-keystore-password'))
        self.assertEqual((config.gas.max_gas, config.gas.enabled, config.gas.replace_after_seconds), (3_000_000, False, 60))
        self.assertEqual((config.planner.owner_horizon_seconds, config.planner.gas_buffer_bps), (604800, 1500))
        self.assertEqual(config.observations.lookback_seconds, (12, 60))
        self.assertEqual(config.price_references[0].token, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
        defaults = config.vault_defaults
        self.assertEqual((defaults.mode, defaults.start_paused, defaults.policy['minimumIntervalSeconds']),
                         (None, False, 600))
        self.assertEqual((defaults.limits['maxSlippageBps'], defaults.owner_maxima['maxSlippageBps'],
                          defaults.exit_max_slippage_bps), (100, 500, 100))
        self.assertEqual(config.vault_gas_ceiling_wei, None)
        self.assertEqual(config.vault_gas_ceilings_wei, {'0x' + 'ca' * 20: 10**15})
        self.assertEqual(config.waiting_file, '/run/domino-v2/base-8453.waiting.json')
        self.assertEqual(checked_config(document(vaultGasCeilingWei=2 * 10**15)).vault_gas_ceiling_wei, 2 * 10**15)
        self.assertEqual(checked_config(document(waitingFile=None)).waiting_file, None)

    def test_each_rule_refuses_the_whole_configuration(self):
        def variant(change):
            config = copy.deepcopy(document())
            change(config)
            return config
        cases = {
            'an extra key': lambda c: c.update(extra=1),
            'another kind': lambda c: c.update(kind='domino-automation'),
            'an unknown chain': lambda c: c.update(chain='optimism-10'),
            'robinhood from the v2 file': lambda c: c.update(chain='robinhood-4663'),
            'base from the provider file': lambda c: c.update(rpc={'providerFile': '/etc/domino/providers.json'}),
            'one key for both roles': lambda c: c['publisher'].update(address=OPERATOR),
            'one credential for both keys': lambda c: c['publisher'].update(credential='v2-operator-keystore-password'),
            'a relative path': lambda c: c.update(journalFile='journal.sqlite'),
            'a path that climbs': lambda c: c.update(headFile='/run/../etc/head.json'),
            'an unknown planner field': lambda c: c['planner'].update(horizon=1),
            'a gas policy above its cap': lambda c: c['gas'].update(maxCostWei=10**17),
            'a gas policy without a cap': lambda c: c['gas'].pop('dailyCapWei'),
            'a simple default with successors': lambda c: c['vaultDefaults'].update(mode=1),
            'a mode that is no mode': lambda c: c['vaultDefaults'].update(mode=3),
            'a trigger above the contract bound': lambda c: c['vaultDefaults']['policy'].update(triggerDistanceBps=2001),
            'no interval at all': lambda c: c['vaultDefaults']['policy'].update(minimumIntervalSeconds=0),
            'an interval below the vault floor': lambda c: c['vaultDefaults']['policy'].update(minimumIntervalSeconds=599),
            'a slippage maximum above the vault ceiling': lambda c: c['vaultDefaults']['ownerMaxima'].update(maxSlippageBps=1001),
            'a band maximum above the vault ceiling': lambda c: c['vaultDefaults']['ownerMaxima'].update(maxPriceImpactBps=501),
            'an observation age above the vault ceiling':
                lambda c: c['vaultDefaults']['limits'].update(maxObservationAgeSeconds=301),
            'a default above its maximum': lambda c: c['vaultDefaults']['limits'].update(maxSlippageBps=600),
            'a maximum of 100%': lambda c: c['vaultDefaults']['ownerMaxima'].update(maxPriceImpactBps=10_000),
            'no observation age': lambda c: c['vaultDefaults']['limits'].update(maxObservationAgeSeconds=0),
            'an exit slippage above the module': lambda c: c['vaultDefaults'].update(exitMaxSlippageBps=1001),
            'a zero gas ceiling': lambda c: c.update(vaultGasCeilingWei=0),
            'a relative waiting file': lambda c: c.update(waitingFile='waiting.json'),
            'a ceiling for no address': lambda c: c.update(vaultGasCeilingsWei={'vault': 1}),
            'a string interval': lambda c: c.update(passSeconds='10'),
            'a reference that is no pool': lambda c: c['priceReferences'][0].update(pool={}),
        }
        for label, change in cases.items():
            with self.subTest(label), self.assertRaises(DataError):
                checked_config(variant(change))

    def test_robinhood_reads_the_read_paths_provider_file(self):
        config = checked_config(document(chain='robinhood-4663', rpc={'providerFile': '/etc/domino/providers.json'},
                                         priceReferences=[]))
        self.assertEqual(config.rpc, {'providerFile': '/etc/domino/providers.json'})

    def test_the_file_must_be_private(self):
        directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, directory)
        os.chmod(directory, 0o700)
        path = directory / 'automation.json'
        path.write_text(json.dumps(document()))
        os.chmod(path, 0o600)
        self.assertEqual(load_automation_config(str(path)).chain.chainId, 8453)
        os.chmod(path, 0o644)
        with self.assertRaises(Exception):
            load_automation_config(str(path))

    def test_the_keys_must_be_the_manifests_operator_and_publisher(self):
        directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, directory)
        os.chmod(directory, 0o700)
        manifest = manifest_document()
        manifest['roles'].update(operator=OPERATOR, publisher=PUBLISHER)
        (directory / 'deployment.json').write_text(json.dumps(manifest))
        other = '0x' + '06' * 20

        def config(role=None):
            changes = {'deploymentFile': str(directory / 'deployment.json'),
                       'rpc': {'chainRpcFile': str(directory / 'absent.json')}}
            if role:
                changes[role] = {**document()[role], 'address': other}
            return checked_config(document(**changes))
        for role in ('operator', 'publisher'):
            with self.subTest(role), self.assertRaisesRegex(DataError, '^v2_signer_not_in_deployment$'):
                build(config(role))
        # The manifest's own keys pass, and so does any key when none is loaded (status, plan): the
        # next step is the chain's RPC file.
        for service, keys in ((config(), True), (config('operator'), False)):
            with self.assertRaisesRegex(DataError, '^v2_chain_rpc_config_unreadable$'):
                build(service, keys=keys)

    def test_the_command_line_prints_a_fixed_code_and_never_a_value(self):
        directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, directory)
        os.chmod(directory, 0o700)
        path = directory / 'automation.json'
        broken = document()
        broken['gas']['maxCostWei'] = 'SYNTHETIC_SECRET'
        path.write_text(json.dumps(broken))
        os.chmod(path, 0o600)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status = main(['--config', str(path), 'plan'])
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(out.getvalue()), {'error': 'v2_invalid_gas_policy'})
        self.assertNotIn('SYNTHETIC', out.getvalue())


class ReturnTests(unittest.TestCase):
    """The pass's return of a closed vault's reserves (ChainAutomation._return):
    what it reads, what it presimulates and what it hands the executor."""

    BLOCK = parse_block({'number': '0x64', 'hash': '0x' + 'ab' * 32, 'timestamp': '0x6500'})
    PAID = '0x' + encode(['uint256', 'uint256'], [1000, 3]).hex()

    class Executor:
        def __init__(self, result):
            self.result, self.calls = result, []
            self.policy = type('Policy', (), {'priority_fee_per_gas': 10**6})()

        def presimulate(self, target, data, head, *, output=False):
            self.calls.append((target, data, head, output))
            if isinstance(self.result, CallReverted):
                raise self.result
            return 480_000, 400_000, self.result

    class Reader:
        def __init__(self, reserves):
            self.amounts, self.reads = reserves, 0

        def reserves(self, vault, block):
            self.reads += 1
            return self.amounts

    class Rpc:
        call_gas_limit = 10**7

        def request(self, method, params):  # the OP Stack L1 fee bound, 1 gwei
            return '0x' + encode(['uint256'], [10**9]).hex()

    def service(self, executor, **changes):
        base = profile('base-8453')
        options = dict(chain=base, deployment=checked_deployment(manifest_document(), base), endpoints=None,
                       follower=None, planner=PlannerConfig(), observations=PublisherPolicy(), price_references=(),
                       earnings_window_seconds=600, twap_seconds=600, exit_twap_seconds=600, deadline_seconds=120,
                       executor=executor)
        options.update(changes)
        return ChainAutomation(**options)

    def returned(self, executor, reserves=(1000, 3), **changes):
        head = type('Head', (), {'block': self.BLOCK, 'base_fee_per_gas': 10**8})()
        vault = vault_state(member(liquidity=0), root_armed=False)
        return self.service(executor, **changes)._return(vault, self.Reader(reserves), self.Rpc(), head), vault

    def test_a_closed_vault_with_reserves_gets_one_presimulated_call(self):
        executor = self.Executor(self.PAID)
        entry, vault = self.returned(executor)
        self.assertEqual({k: entry[k] for k in ('act', 'reason', 'action', 'simulation', 'reserves', 'paid')},
                         {'act': True, 'reason': 'reserves_returnable', 'action': 'return_reserves',
                          'simulation': 'passed', 'reserves': ['1000', '3'], 'paid': ['1000', '3']})
        self.assertEqual(entry['plan'], {'calldata': return_reserves_calldata(),
                                         'deadline': self.BLOCK.timestamp + 120, 'gas': 480_000})
        self.assertEqual(entry['subject'], return_subject(8453, vault.vault, vault.state_nonce, self.BLOCK.number))
        self.assertEqual(executor.calls, [(vault.vault, return_reserves_calldata(), self.BLOCK, True)])

    def test_nothing_to_return_leaves_the_vault_to_the_planner(self):
        executor = self.Executor(self.PAID)
        entry, _ = self.returned(executor, reserves=(0, 0))
        self.assertIsNone(entry)
        self.assertEqual(executor.calls, [])

    def test_an_empty_closed_vault_is_read_again_only_once_its_state_moves(self):
        # Every change to a vault's reserves advances its state nonce.
        service = self.service(self.Executor(self.PAID))
        head = type('Head', (), {'block': self.BLOCK, 'base_fee_per_gas': 10**8})()
        vault, reader = vault_state(member(liquidity=0), root_armed=False), self.Reader((0, 0))
        self.assertIsNone(service._return(vault, reader, self.Rpc(), head))
        self.assertIsNone(service._return(vault, reader, self.Rpc(), head))
        self.assertEqual(reader.reads, 1)
        reader.amounts = (1000, 3)
        self.assertIsNone(service._return(vault, reader, self.Rpc(), head))
        moved = service._return(replace(vault, state_nonce=vault.state_nonce + 1), reader, self.Rpc(), head)
        self.assertEqual((reader.reads, moved['reason']), (2, 'reserves_returnable'))

    def test_the_registrys_halt_holds_it_and_a_pause_does_not(self):
        executor = self.Executor(self.PAID)
        head = type('Head', (), {'block': self.BLOCK, 'base_fee_per_gas': 10**8})()
        closed = vault_state(member(liquidity=0), root_armed=False)
        service = self.service(executor)
        self.assertIsNone(service._return(replace(closed, halted=True), self.Reader((1000, 3)), self.Rpc(), head))
        self.assertEqual(executor.calls, [])
        entry = service._return(replace(closed, paused=True), self.Reader((1000, 3)), self.Rpc(), head)
        self.assertEqual((entry['act'], entry['reason']), (True, 'reserves_returnable'))

    def test_a_return_that_would_pay_nothing_is_not_sent(self):
        # Every reserve is in a token the owner cannot receive (A8): it would stay idle.
        entry, _ = self.returned(self.Executor('0x' + encode(['uint256', 'uint256'], [0, 0]).hex()))
        self.assertEqual((entry['act'], entry['reason'], entry['simulation']), (False, 'reserves_unpayable', 'passed'))
        self.assertNotIn('plan', entry)

    def test_the_contracts_refusal_reaches_the_pass(self):
        refusal = CallReverted('0x' + keccak(b'RootOpen()')[:4].hex())
        with self.assertRaisesRegex(CallReverted, '^reverted_root_open$'):
            self.returned(self.Executor(refusal))

    def test_without_keys_it_is_reported_and_never_simulated(self):
        entry, _ = self.returned(None)
        self.assertEqual((entry['act'], entry['reason'], entry['action']),
                         (True, 'eligible_keyless', 'return_reserves'))
        self.assertNotIn('plan', entry)

    def test_the_vaults_gas_ceiling_holds(self):
        # 400,000 gas at 1.01e8 plus the 1 gwei L1 bound: 4.04e13 + 1e9 wei.
        entry, _ = self.returned(self.Executor(self.PAID), vault_gas_ceiling_wei=4 * 10**13)
        self.assertEqual((entry['act'], entry['reason']), (False, 'vault_gas_ceiling'))
        entry, _ = self.returned(self.Executor(self.PAID), vault_gas_ceiling_wei=4 * 10**13,
                                 vault_gas_ceilings_wei={'0x' + 'aa' * 20: 5 * 10**13})
        self.assertEqual((entry['act'], entry['reason']), (True, 'reserves_returnable'))


if __name__ == '__main__':
    unittest.main()
