"""The V2 deployment manifest the automation consumes: #301's schema (PR #302) and the backend's admission."""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_hash.auto import keccak
from eth_utils import to_checksum_address

from discovery import Block, DataError
from v2_chains import chain
from v2_manifest import (BUILD, COMPONENTS, CONTRACT_NAMES, CREATE_X, CREATE_X_CODE_HASH, DEPLOY_ORDER,
                         MAX_MANIFEST_BYTES, POLICIES, PUBLIC_TEST_ACCOUNTS, canonical, checked_deployment,
                         checked_manifest, component_salt, create3_address, create_address, load_deployment, predict,
                         profile_dependencies)
from v2_rpc import CodeCache

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().parent / 'fixtures'
BASE = chain('base-8453')
DEPLOYER = '0x' + '7d' * 20
SOURCES = {'src/v2/registry/DominoRegistry.sol': hashlib.sha256(b'registry').hexdigest(),
           'src/v2/autoexit/DominoAutoExit.sol': hashlib.sha256(b'autoExit').hexdigest()}
# Verbatim copies of PR #302's output at 20982b6 (#301's tooling): a Base fork
# rehearsal with the real dependencies, and deploy-local.mjs's offline fixture.
PR302 = {'v2-deployment-base-8453-fork-rehearsal.json': 'docs/deployments/v2-rehearsal-2026-10-02/base-8453-deployment.json',
         'v2-deployment-local-fixture.json': 'scripts/v2/deploy-fixtures/deployment.fixture.json'}


def role(name):
    return '0x' + keccak(b'role:' + name.encode())[12:].hex()


def manifest_document(profile=BASE, *, deployer=DEPLOYER, status='verified', environment='public-chain-preparation'):
    """A manifest as deploy.mjs prepares and verifies it on `profile` (synthetic roles, receipts and code)."""
    contracts, salts, guarded = predict(deployer)
    dependencies = profile_dependencies(profile)
    verified = status == 'verified'
    return {
        'schemaVersion': 1, 'kind': 'domino-v2-deployment', 'status': status, 'environment': environment,
        'chain': {'name': profile.name, 'chainId': profile.chainId, 'nativeCurrency': profile.nativeSymbol},
        'sourceCommit': '19e83e2' + '0' * 33, 'releaseTag': 'v2-release-2026-10-02',
        'contractNames': dict(CONTRACT_NAMES), 'contracts': contracts, 'dependencies': dependencies,
        'roles': {'deployer': deployer, **{name: role(name) for name in
                                           ('governance', 'guardian', 'feeRecipient', 'operator', 'publisher')}},
        'policies': dict(POLICIES),
        'chargeCurrencies': [{'token': c.address, 'rank': c.rank} for c in profile.chargeCurrencies],
        'runtimeCodeHashes': {**{name: '0x' + keccak(name.encode()).hex() for name in COMPONENTS},
                              **{name: profile.verified_codehash(address) for name, address in dependencies.items()}},
        'createx': {'address': CREATE_X, 'runtimeCodeHash': CREATE_X_CODE_HASH, 'salts': salts,
                    'guardedSalts': guarded},
        'build': {**BUILD, 'sourceTreeSha256': hashlib.sha256(canonical(SOURCES).encode()).hexdigest(),
                  'workingTreeSourceChanges': False, 'sourceHashes': dict(SOURCES),
                  'chainProfileSha256': hashlib.sha256(b'profile').hexdigest()},
        'deploymentReceipts': {name: {'transactionHash': '0x' + keccak(b'tx' + name.encode()).hex(),
                                      'blockNumber': 1000 + index,
                                      'blockHash': '0x' + keccak(b'block' + name.encode()).hex(),
                                      'gasUsed': str(1_000_000 + index), 'effectiveGasPrice': '1000000000'}
                               for index, name in enumerate(DEPLOY_ORDER)} if verified else {},
        'verification': {'blockNumber': 1011, 'blockHash': '0x' + keccak(b'verified').hex(), 'blockTag': 'finalized',
                         'codeHashes': 'exact_precomputed_immutable_runtime', 'wiring': 'checked',
                         'checkedAt': '2026-10-02T12:00:00.000Z'} if verified else None,
    }


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


def mutated(change, document=None):
    document = copy.deepcopy(document or manifest_document())
    change(document)
    return document


class Pr302Tests(unittest.TestCase):
    """The loader against what #301's tooling actually writes."""

    def test_the_copies_are_pr302s_files_once_they_are_in_the_repository(self):
        for copied, original in PR302.items():
            if (ROOT / original).exists():
                with self.subTest(original):
                    self.assertEqual(json.loads((ROOT / original).read_text()), fixture(copied))

    def test_a_fork_rehearsal_binds_to_the_real_profile_and_is_never_production(self):
        document = fixture('v2-deployment-base-8453-fork-rehearsal.json')
        deployment = checked_deployment(document, BASE, admission='fork-rehearsal')
        self.assertEqual(deployment.address('vaultExecutor.v4'), create_address(deployment.address('vault.v4'), 1))
        self.assertEqual(deployment.operator, document['roles']['operator'])
        self.assertEqual(deployment.start_block('vaultFactory.v4'),
                         document['deploymentReceipts']['vaultFactory.v4']['blockNumber'])
        with self.assertRaisesRegex(DataError, '^v2_deployment_not_admitted$'):
            checked_deployment(document, BASE)
        for other in ('robinhood-4663', 'arbitrum-42161'):
            with self.subTest(other), self.assertRaisesRegex(DataError, '^v2_deployment_chain_mismatch$'):
                checked_deployment(document, chain(other), admission='fork-rehearsal')
        # Published from committed sources and verified at `finalized`, the same record is production's
        # once its roles are the owner's: a rehearsal's are keys of the public test mnemonic.
        public = mutated(lambda d: (d.update(environment='public-chain-preparation'),
                                    d['verification'].update(blockTag='finalized')), document)
        with self.assertRaisesRegex(DataError, '^v2_deployment_not_admitted$'):
            checked_deployment(public, BASE)
        owned = mutated(lambda d: d['roles'].update({name: role(name) for name in d['roles'] if name != 'deployer'}),
                        public)
        self.assertEqual(checked_deployment(owned, BASE).registry, deployment.registry)

    def test_the_local_fixture_is_a_local_test_on_its_own_chain_id(self):
        document = fixture('v2-deployment-local-fixture.json')
        # deploy-local.mjs's offline profile: Base's, at the Anvil's chain id, with synthetic dependency code.
        local = BASE.model_copy(update={'chainId': document['chain']['chainId']})
        self.assertEqual(checked_deployment(document, local, admission='local-test').publisher,
                         document['roles']['publisher'])
        for admission in ('production', 'fork-rehearsal'):
            with self.subTest(admission), self.assertRaisesRegex(DataError, '^v2_deployment_not_admitted$'):
                checked_deployment(document, local, admission=admission)
        with self.assertRaisesRegex(DataError, '^v2_deployment_chain_mismatch$'):
            checked_deployment(document, BASE, admission='local-test')


class ManifestTests(unittest.TestCase):
    def test_a_manifest_loads_with_every_contract_its_roles_and_its_start_blocks(self):
        deployment = checked_deployment(manifest_document(), BASE)
        self.assertEqual(len(deployment.manifest['contracts']), 13)
        self.assertEqual(deployment.factory(4), deployment.address('vaultFactory.v4'))
        self.assertEqual(deployment.start_block('autoExit'), 1002)
        self.assertEqual((deployment.operator, deployment.publisher), (role('operator'), role('publisher')))
        with self.assertRaisesRegex(DataError, '^v2_deployment_component_unknown$'):
            deployment.start_block('vaultExecutor.v4')  # created by its implementation, no receipt of its own
        with self.assertRaisesRegex(DataError, '^v2_deployment_component_unknown$'):
            deployment.address('vault.v5')
        # The same deployer and salt give the same addresses on every chain (F0).
        arbitrum = checked_deployment(manifest_document(chain('arbitrum-42161')), chain('arbitrum-42161'))
        self.assertEqual(arbitrum.manifest['contracts'], deployment.manifest['contracts'])

    def test_the_salt_and_its_guard_are_f0s_and_createxs_rules(self):
        salt = component_salt(DEPLOYER, 'registry')
        # F1_REGISTRY_ANCHOR.md: bytes11 suffix of keccak256("domino.v2.registry").
        self.assertEqual(salt, '0x' + '7d' * 20 + '00' + '5808207249734df963985c')
        self.assertEqual(component_salt(DEPLOYER, 'priceAnchor')[-22:], '4c705838108da4e4e8af43')
        # #302's fixture: its deployer's registry lands where the guarded salt says.
        document = fixture('v2-deployment-local-fixture.json')
        deployer = document['roles']['deployer']
        self.assertEqual(create3_address(CREATE_X, deployer, component_salt(deployer, 'registry')),
                         document['contracts']['registry'])

    def test_each_rule_refuses_the_whole_manifest(self):
        def set_role(name, value):
            return lambda d: d['roles'].update({name: value})

        def receipt(change):
            return lambda d: change(d['deploymentReceipts']['registry'])

        def build(**values):
            return lambda d: d['build'].update(values)

        other_salt = '0x' + '7d' * 20 + '01' + '00' * 11
        cases = {
            'an extra key': lambda d: d.update(extra=1),
            'a missing key': lambda d: d.pop('policies'),
            'another kind': lambda d: d.update(kind='domino-public-mainnet-deployment'),
            'a float version': lambda d: d.update(schemaVersion=1.0),
            'a boolean version': lambda d: d.update(schemaVersion=True),
            'another status': lambda d: d.update(status='deployed'),
            'another environment': lambda d: d.update(environment='production'),
            'a chain not enabled outside local tests': lambda d: d['chain'].update(chainId=10),
            'a string chain id': lambda d: d['chain'].update(chainId='8453'),
            'a zero chain id in a local test': lambda d: (d.update(environment='local-test'),
                                                          d['chain'].update(chainId=0)),
            'no chain name': lambda d: d['chain'].update(name=''),
            'no native currency': lambda d: d['chain'].update(nativeCurrency=''),
            'an extra chain key': lambda d: d['chain'].update(profile='base-8453'),
            'a short commit': lambda d: d.update(sourceCommit='19e83e2'),
            'a release tag with a path': lambda d: d.update(releaseTag='v2/release'),
            'a missing executor': lambda d: d['contracts'].pop('vaultExecutor.v4'),
            'an executor at the second CREATE': lambda d: d['contracts'].update(
                {'vaultExecutor.v3': create_address(d['contracts']['vault.v3'], 2)}),
            'another contract name': lambda d: d['contractNames'].update({'registry': 'DominoRegistryV2'}),
            'an address its salt does not give': lambda d: d['contracts'].update({'registry': '0x' + '99' * 20}),
            "a component at another one's address": lambda d: d['contracts'].update(
                {'registry': d['contracts']['priceAnchor']}),
            # A salt off the rule, with the address its CREATE3 gives: only the rule refuses it.
            'a salt that is not the rule': lambda d: (
                d['createx']['salts'].update({'registry': other_salt}),
                d['contracts'].update({'registry': create3_address(CREATE_X, DEPLOYER, other_salt)})),
            'an unguarded salt': lambda d: d['createx']['guardedSalts'].update(
                {'registry': d['createx']['salts']['registry']}),
            # The addresses are derived from the deployer, so a recorded salt is checked on its own.
            "a salt that is not the address's": lambda d: d['createx']['salts'].update({'registry': other_salt}),
            'a CreateX key more': lambda d: d['createx'].update(deployer=DEPLOYER),
            'another CreateX': lambda d: d['createx'].update(address='0x' + '42' * 20),
            'another CreateX code': lambda d: d['createx'].update(runtimeCodeHash='0x' + '42' * 32),
            'another tariff': lambda d: d['policies'].update(autoExitFeeBps=25),
            'hooked pools': lambda d: d['policies'].update(hookedPoolsAllowed=True),
            'a string number': lambda d: d['policies'].update(timelockSeconds='86400'),
            'a role missing': lambda d: d['roles'].pop('guardian'),
            'operators as a list': lambda d: d['roles'].update(operator=[role('operator')]),
            'a placeholder role': set_role('guardian', '0x' + '11' * 20),
            'a precompile-range role': set_role('feeRecipient', '0x' + '00' * 18 + 'ffff'),
            'a zero role': set_role('feeRecipient', '0x' + '00' * 20),
            'a publisher who operates': lambda d: d['roles'].update(publisher=d['roles']['operator']),
            'a role that is a component': lambda d: d['roles'].update(feeRecipient=d['contracts']['registry']),
            'a role that is CreateX': set_role('governance', CREATE_X),
            'a checksummed role': set_role('governance', to_checksum_address(role('governance'))),
            'a missing dependency': lambda d: d['dependencies'].pop('v4Quoter'),
            'CreateX as a dependency': lambda d: d['dependencies'].update(createx=CREATE_X),
            'a zero dependency': lambda d: d['dependencies'].update(permit2='0x' + '00' * 20),
            'a missing code hash': lambda d: d['runtimeCodeHashes'].pop('vaultExecutor.v4'),
            'a code hash for nothing': lambda d: d['runtimeCodeHashes'].update({'vault.v5': '0x' + '01' * 32}),
            'a zero code hash': lambda d: d['runtimeCodeHashes'].update({'registry': '0x' + '00' * 32}),
            'an upper case hash': lambda d: d['runtimeCodeHashes'].update({'registry': '0x' + 'AB' * 32}),
            'one charge currency': lambda d: d.update(chargeCurrencies=d['chargeCurrencies'][:1]),
            'a charge currency twice': lambda d: d['chargeCurrencies'].append(dict(d['chargeCurrencies'][0])),
            'a rank of zero': lambda d: d['chargeCurrencies'][0].update(rank=0),
            'a rank of 256': lambda d: d['chargeCurrencies'][0].update(rank=256),
            'a charge token that is no address': lambda d: d['chargeCurrencies'][0].update(token='usdc'),
            'a charge currency key more': lambda d: d['chargeCurrencies'][0].update(symbol='USDC'),
            'another compiler': build(version='0.8.27+commit.40a35a09'),
            'a float optimizer run count': build(optimizerRuns=200.0),
            'an integer for via-IR': build(viaIR=1),
            'a source outside v2': lambda d: (d['build']['sourceHashes'].update({'src/Domino.sol': '00' * 32}),
                                              d['build'].update(sourceTreeSha256=hashlib.sha256(canonical(
                                                  d['build']['sourceHashes']).encode()).hexdigest())),
            'a source path that climbs': lambda d: (
                d['build']['sourceHashes'].update({'src/v2/../Domino.sol': '00' * 32}),
                d['build'].update(sourceTreeSha256=hashlib.sha256(canonical(
                    d['build']['sourceHashes']).encode()).hexdigest())),
            'a tree hash that is not the sources': build(sourceTreeSha256='00' * 32),
            'a source hash that is no hash': lambda d: (
                d['build']['sourceHashes'].update({'src/v2/registry/DominoRegistry.sol': 'x' * 64}),
                d['build'].update(sourceTreeSha256=hashlib.sha256(canonical(
                    d['build']['sourceHashes']).encode()).hexdigest())),
            'a profile hash that is no hash': build(chainProfileSha256='x' * 64),
            'no sources': build(sourceHashes={}, sourceTreeSha256=hashlib.sha256(b'{}').hexdigest()),
            'a string for source changes': build(workingTreeSourceChanges='false'),
            'a build key more': build(solc='0.8.26'),
            'a missing receipt': lambda d: d['deploymentReceipts'].pop('zap.v4'),
            "a receipt for an executor": lambda d: d['deploymentReceipts'].update(
                {'vaultExecutor.v3': dict(d['deploymentReceipts']['registry'])}),
            'one transaction for two components': lambda d: d['deploymentReceipts']['zap.v3'].update(
                transactionHash=d['deploymentReceipts']['zap.v4']['transactionHash']),
            'a numeric gas': receipt(lambda r: r.update(gasUsed=1932617)),
            'a padded gas price': receipt(lambda r: r.update(effectiveGasPrice='01')),
            'a receipt key more': receipt(lambda r: r.update(status='0x1')),
            'a hex block number': receipt(lambda r: r.update(blockNumber='0x3e8')),
            'no verification': lambda d: d.update(verification=None),
            'a verification key more': lambda d: d['verification'].update(signer=DEPLOYER),
            'unverified code hashes': lambda d: d['verification'].update(codeHashes='recorded'),
            'unchecked wiring': lambda d: d['verification'].update(wiring='skipped'),
            'a check time that is no time': lambda d: d['verification'].update(checkedAt='yesterday'),
            'a numeric check time': lambda d: d['verification'].update(checkedAt=0),
            'a numeric block tag': lambda d: d['verification'].update(blockTag=5),
            # The indexer's rules beyond #302's validator.
            'a receipt in the genesis block': receipt(lambda r: r.update(blockNumber=0)),
            'a zero transaction hash': receipt(lambda r: r.update(transactionHash='0x' + '00' * 32)),
            'a zero block hash': receipt(lambda r: r.update(blockHash='0x' + '00' * 32)),
            'two hashes for one block': lambda d: d['deploymentReceipts']['zap.v3'].update(
                blockNumber=d['deploymentReceipts']['zap.v4']['blockNumber']),
            'a verification before the receipts': lambda d: d['verification'].update(blockNumber=999),
            "a verification that disagrees with its block's receipt": lambda d: d['verification'].update(
                blockNumber=1010),
            'a zero verification hash': lambda d: d['verification'].update(blockHash='0x' + '00' * 32),
            'a check time without a zone': lambda d: d['verification'].update(checkedAt='2026-10-02T12:00:00'),
        }
        for label, change in cases.items():
            with self.subTest(label), self.assertRaisesRegex(DataError, '^v2_deployment_invalid$'):
                checked_deployment(mutated(change), BASE)
        prepared = manifest_document(status='prepared')
        for label, change in {
            'a prepared manifest with receipts': lambda d: d.update(
                deploymentReceipts=manifest_document()['deploymentReceipts']),
            'a prepared manifest with a verification': lambda d: d.update(
                verification=manifest_document()['verification']),
            'a prepared manifest with a list of receipts': lambda d: d.update(deploymentReceipts=[]),
        }.items():
            with self.subTest(label), self.assertRaisesRegex(DataError, '^v2_deployment_invalid$'):
                checked_manifest(mutated(change, prepared))

    def test_the_chain_and_its_dependencies_are_the_profiles(self):
        for label, change, code in (
                ('another chain id', lambda d: d['chain'].update(chainId=42161), 'chain_mismatch'),
                ('another name', lambda d: d['chain'].update(name='Base Sepolia'), 'chain_mismatch'),
                ('another native symbol', lambda d: d['chain'].update(nativeCurrency='WETH'), 'chain_mismatch'),
                ('a dependency elsewhere', lambda d: d['dependencies'].update(permit2='0x' + '99' * 20),
                 'dependency_mismatch'),
                ('another dependency code', lambda d: d['runtimeCodeHashes'].update(v4PoolManager='0x' + '99' * 32),
                 'dependency_mismatch'),
                ('reordered charge currencies', lambda d: d['chargeCurrencies'].reverse(), 'dependency_mismatch'),
                ('another rank', lambda d: d['chargeCurrencies'][0].update(rank=3), 'dependency_mismatch')):
            with self.subTest(label), self.assertRaisesRegex(DataError, f'^v2_deployment_{code}$'):
                checked_deployment(mutated(change), BASE)
        with self.assertRaisesRegex(DataError, '^v2_deployment_chain_mismatch$'):
            checked_deployment(manifest_document(), chain('arbitrum-42161'))
        # A local test runs synthetic code under any name, still at the profile's chain id and addresses.
        local = manifest_document(environment='local-test')
        checked_deployment(mutated(lambda d: (d['chain'].update(name='Local'),
                                              d['runtimeCodeHashes'].update(v4PoolManager='0x' + '99' * 32),
                                              d['chargeCurrencies'].reverse()), local), BASE, admission='local-test')
        for change in (lambda d: d['chain'].update(chainId=42161),
                       lambda d: d['dependencies'].update(permit2='0x' + '99' * 20)):
            with self.assertRaisesRegex(DataError, '^v2_deployment_(chain|dependency)_mismatch$'):
                checked_deployment(mutated(change, local), BASE, admission='local-test')

    def test_receipts_may_share_a_block_and_its_hash_with_the_verification(self):
        def shared(d):
            receipts = d['deploymentReceipts']
            for name in ('zap.v3', 'zap.v4'):
                receipts[name].update(blockNumber=1011, blockHash=d['verification']['blockHash'])
        self.assertEqual(checked_deployment(mutated(shared), BASE).start_block('zap.v4'), 1011)

    def test_the_profile_s_createx_is_the_one_the_deployment_went_through(self):
        elsewhere = BASE.model_copy(update={'deployer': BASE.deployer.model_copy(update={'address': '0x' + '42' * 20})})
        other_code = BASE.model_copy(update={'deployer': BASE.deployer.model_copy(
            update={'codehash': '0x' + '42' * 32})})
        local = manifest_document(environment='local-test')
        for profile, document, admission in ((elsewhere, manifest_document(), 'production'),
                                             (elsewhere, local, 'local-test'),
                                             (other_code, manifest_document(), 'production')):
            with self.subTest(admission), self.assertRaisesRegex(DataError, '^v2_deployment_dependency_mismatch$'):
                checked_deployment(document, profile, admission=admission)
        # A local test runs synthetic code, CreateX's too.
        self.assertEqual(checked_deployment(local, other_code, admission='local-test').chain, other_code)

    def test_production_refuses_a_role_held_by_a_public_test_key(self):
        from eth_account import Account
        Account.enable_unaudited_hdwallet_features()
        mnemonic = 'test test test test test test test test test test test junk'
        self.assertEqual(PUBLIC_TEST_ACCOUNTS, {
            Account.from_mnemonic(mnemonic, account_path=f"m/44'/60'/0'/0/{i}").address.lower() for i in range(10)})
        keys = sorted(PUBLIC_TEST_ACCOUNTS)
        for index, name in enumerate(('governance', 'guardian', 'feeRecipient', 'operator', 'publisher')):
            document = mutated(lambda d: d['roles'].update({name: keys[index]}))
            with self.subTest(name), self.assertRaisesRegex(DataError, '^v2_deployment_not_admitted$'):
                checked_deployment(document, BASE)
            for environment in ('fork-rehearsal', 'local-test'):
                checked_deployment(mutated(lambda d: d.update(environment=environment), document), BASE,
                                   admission=environment)
        # The deployer too: its key places every address on every chain.
        deployer = keys[0]
        public = manifest_document(deployer=deployer)
        with self.assertRaisesRegex(DataError, '^v2_deployment_not_admitted$'):
            checked_deployment(public, BASE)

    def test_production_admits_only_a_finalized_public_deployment_of_committed_sources(self):
        self.assertEqual(checked_deployment(manifest_document(), BASE).chain, BASE)
        for label, change in {
            'a fork rehearsal': lambda d: d.update(environment='fork-rehearsal'),
            'a local test': lambda d: d.update(environment='local-test'),
            'an unqualified source candidate': lambda d: d['build'].update(workingTreeSourceChanges=True),
            'a provisional verification': lambda d: d['verification'].update(blockTag='latest'),
            'a safe-tag verification': lambda d: d['verification'].update(blockTag='safe'),
        }.items():
            with self.subTest(label), self.assertRaisesRegex(DataError, '^v2_deployment_not_admitted$'):
                checked_deployment(mutated(change), BASE)
        # Each test admission takes its own environment only.
        for admission in ('fork-rehearsal', 'local-test'):
            with self.subTest(admission), self.assertRaisesRegex(DataError, '^v2_deployment_not_admitted$'):
                checked_deployment(manifest_document(), BASE, admission=admission)
        for admission in ('production', 'local-test'):
            with self.assertRaisesRegex(DataError, '^v2_deployment_not_executed$'):
                checked_deployment(manifest_document(status='prepared', environment='local-test'), BASE,
                                   admission=admission)
        with self.assertRaisesRegex(DataError, '^v2_deployment_admission_invalid$'):
            checked_deployment(manifest_document(), BASE, admission='staging')
        with self.assertRaisesRegex(DataError, '^v2_chain_profile_required$'):
            checked_deployment(manifest_document(), 'base-8453')

    def test_canonical_json_is_javascripts(self):
        # JSON.stringify of sorted keys: UTF-16 code units, so an astral character sorts before U+E000.
        self.assertEqual(canonical({'': 1, '\U0001f600': [2, {'b': True, 'a': None}], 'z': 'é'}),
                         '{"z":"é","\U0001f600":[2,{"a":null,"b":true}],"":1}')
        with self.assertRaisesRegex(DataError, '^v2_deployment_invalid$'):
            canonical({'src/v2/\ud800.sol': '00'})

    def test_a_file_loads_and_duplicate_keys_are_refused(self):
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, directory)
        path = directory / 'deployment.json'
        path.write_text(json.dumps(manifest_document()))
        self.assertEqual(load_deployment(path, BASE).start_block('registry'), 1000)
        path.write_text(json.dumps(manifest_document())[:-1] + ',"kind":"domino-v2-deployment"}')
        with self.assertRaisesRegex(DataError, '^v2_deployment_invalid$'):
            load_deployment(path, BASE)
        path.write_text(json.dumps(manifest_document()).replace('"rank": 1', '"rank": NaN'))
        with self.assertRaisesRegex(DataError, '^v2_deployment_invalid$'):
            load_deployment(path, BASE)
        # Numbers as JavaScript (and JSON Schema) read them: an integral value is an integer.
        path.write_text(json.dumps(manifest_document()).replace('"schemaVersion": 1', '"schemaVersion": 1.0')
                        .replace('"chainId": 8453', '"chainId": 8453e0'))
        chain_id = load_deployment(path, BASE).manifest['chain']['chainId']
        self.assertEqual((chain_id, type(chain_id)), (8453, int))
        path.write_text(json.dumps(manifest_document()).replace('"rank": 1', '"rank": 1.5'))
        with self.assertRaisesRegex(DataError, '^v2_deployment_invalid$'):
            load_deployment(path, BASE)
        path.write_text(json.dumps(manifest_document()).replace('"rank": 1', '"rank": 1e999'))
        with self.assertRaisesRegex(DataError, '^v2_deployment_invalid$'):
            load_deployment(path, BASE)
        path.write_text(json.dumps(manifest_document()) + ' ' * 262144)  # valid, but too large
        with self.assertRaisesRegex(DataError, '^v2_deployment_invalid$'):
            load_deployment(path, BASE)
        # As deep as the size limit allows: Python 3.14's parser overflows its stack there.
        path.write_text('[' * (MAX_MANIFEST_BYTES // 2) + ']' * (MAX_MANIFEST_BYTES // 2))
        with self.assertRaisesRegex(DataError, '^v2_deployment_invalid$'):
            load_deployment(path, BASE)
        path.write_bytes(json.dumps(manifest_document()).encode().replace(b'"verified"', b'"verified\xff"', 1))
        with self.assertRaisesRegex(DataError, '^v2_deployment_invalid$'):
            load_deployment(path, BASE)
        with self.assertRaisesRegex(DataError, '^v2_deployment_unreadable$'):
            load_deployment(directory / 'absent.json', BASE)


class CodeProofTests(unittest.TestCase):
    ANCHOR = '0x' + keccak(b'verified').hex()

    class Rpc:
        batch_reads = False

        def __init__(self, codes, anchor):
            self.codes, self.anchor, self.calls = codes, anchor, []

        def request(self, method, params):
            self.calls.append((method, params))
            if method == 'eth_getBlockByNumber':
                return {'number': params[0], 'hash': self.anchor, 'timestamp': '0x1'}
            return self.codes[params[0]]

    def setUp(self):
        self.document = manifest_document()
        self.codes = {}
        for name in COMPONENTS:
            code = '0x60' + keccak(name.encode())[:1].hex() + '00'
            self.codes[self.document['contracts'][name]] = code
            self.document['runtimeCodeHashes'][name] = '0x' + keccak(bytes.fromhex(code[2:])).hex()
        self.deployment = checked_deployment(self.document, BASE)

    def test_code_and_anchor_are_proven_once_per_process(self):
        rpc, cache = self.Rpc(self.codes, self.ANCHOR), CodeCache()
        self.deployment.verify_code(rpc, Block(2000, '0x' + '11' * 32, 1), cache=cache)
        self.assertEqual(rpc.calls[0], ('eth_getBlockByNumber', [hex(1011), False]))
        self.assertEqual(len(rpc.calls), 1 + len(COMPONENTS))
        self.deployment.verify_code(rpc, Block(2001, '0x' + '12' * 32, 2), cache=cache)
        self.assertEqual(len(rpc.calls), 1 + len(COMPONENTS))  # proven from block 2000 on

    def test_changed_code_a_reorganized_anchor_or_a_lagging_node_is_refused(self):
        block = Block(2000, '0x' + '11' * 32, 1)
        with self.assertRaisesRegex(DataError, '^v2_deployment_anchor_reorganized$'):
            self.deployment.verify_code(self.Rpc(self.codes, '0x' + '22' * 32), block, cache=CodeCache())
        with self.assertRaisesRegex(DataError, '^v2_deployment_ahead_of_head$'):
            self.deployment.verify_code(self.Rpc(self.codes, self.ANCHOR), Block(1010, '0x' + '11' * 32, 1),
                                        cache=CodeCache())
        self.codes[self.document['contracts']['vaultExecutor.v4']] = '0x6000'
        with self.assertRaisesRegex(DataError, '^v2_deployment_code_mismatch$'):
            self.deployment.verify_code(self.Rpc(self.codes, self.ANCHOR), block, cache=CodeCache())
        # A manifest recording the empty code's hash still needs code there.
        self.codes[self.document['contracts']['autoExit']] = '0x'
        self.document['runtimeCodeHashes']['autoExit'] = '0x' + keccak(b'').hex()
        with self.assertRaisesRegex(DataError, '^v2_deployment_code_mismatch$'):
            checked_deployment(self.document, BASE).verify_code(self.Rpc(self.codes, self.ANCHOR), block,
                                                                components=('autoExit',), cache=CodeCache())


if __name__ == '__main__':
    unittest.main()
