"""The V2 automation end to end on the real V2 contracts, on a disposable Base Anvil.

Uniswap is the bytecode deployed on Base (F1c's fixtures, set at its Base
addresses), so the service reads the real Base chain profile, unmodified; the
V2 stack is every F0 component at its CREATE3 address, deployed by this suite's
fixture (tests/v2_local_chain.py), not by #301's deploy-local.mjs, whose offline
mode has no real Uniswap; its manifest is #302's format, admitted as a
local test. What runs is the service's own
pass (v2_automation.ChainAutomation): discovery, the vault's state, the
planner, the publisher's signed observation, the presimulation, the journal,
the signed transaction, the receipt and its reconciliation.
"""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_abi import encode
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_hash.auto import keccak
from eth_utils import to_checksum_address

from discovery import ZERO
from v2_abi import event
from v2_automation import ChainAutomation
from v2_chains import chain as profile
from v2_manifest import load_deployment
from v2_executor import ChainExecutor, GasPolicy, Journal, OperatorKey, OperatorRpc
from v2_head import HeadFollower
from v2_observation import ObservationSigner, PriceObservation, PublisherPolicy, observation_digest
from v2_planner import PlannerConfig
from v2_rpc import ChainEndpoints, Endpoint
from v2_uniswap import PoolRef
from v4_math import sqrt_at_tick
from v2_local_chain import LocalChain, calldata, deploy_v2

KEY_TYPE = '(address,address,uint24,int24,address)'
INIT_TYPE = '((uint8,address,uint256),(uint8,uint16,uint16,uint32,uint8),(uint16,uint16,uint32,uint32),bool,bool)'
MANDATE_TYPE = '(address,address,uint256,uint160,uint160,uint8,address,uint16,uint64,uint256)'
OPERATOR_KEY = keccak(b'domino.v2.test.operator')
PUBLISHER_KEY = keccak(b'domino.v2.test.publisher')
OWNER_KEY = keccak(b'domino.v2.test.owner')
# GasPriceOracle stand-in at 0x42…0f: every call returns 1 gwei (the L1 fee bound).
L1_ORACLE_RUNTIME = '0x633b9aca0060005260206000f3'
EIP712 = json.loads((Path(__file__).resolve().parents[2] / 'api-contracts/v2/eip712.json').read_text())


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires isolated local Anvil')
class AutomationEvmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chain = profile('base-8453')
        cls.local = local = LocalChain(8453)
        cls.addClassCleanup(local.stop)
        local.etch_base_uniswap(cls.chain)
        local.request('anvil_setCode', ['0x420000000000000000000000000000000000000f', L1_ORACLE_RUNTIME])
        cls.operator = Account.from_key(OPERATOR_KEY).address.lower()
        cls.publisher = Account.from_key(PUBLISHER_KEY).address.lower()
        cls.owner = Account.from_key(OWNER_KEY).address.lower()
        cls.deployer, cls.governance, cls.guardian, cls.lp = local.accounts[:4]
        cls.fee_recipient = '0x' + 'fe' * 20
        for account in (cls.operator, cls.owner):
            local.fund(account)
        local.fund(cls.deployer, 10**30)
        cls.v4 = cls.chain.uniswap.v4
        cls.weth = cls.chain.wrappedNative.address
        cls.token = local.deploy(cls.deployer, 'OfficialV4Fixture.sol', 'OfficialFixtureToken')
        manifest = deploy_v2(local, cls.chain, deployer=cls.deployer, governance=cls.governance,
                             guardian=cls.guardian, fee_recipient=cls.fee_recipient, operator=cls.operator,
                             publisher=cls.publisher)
        cls.directory = Path(tempfile.mkdtemp()).resolve()
        cls.addClassCleanup(shutil.rmtree, cls.directory)
        os.chmod(cls.directory, 0o700)
        (cls.directory / 'deployment.json').write_text(json.dumps(manifest))
        cls.deployment = load_deployment(cls.directory / 'deployment.json', cls.chain, admission='local-test')
        currencies = sorted([cls.weth, cls.token])
        cls.pool = PoolRef(4, currencies[0], currencies[1], 3000, 60)
        cls.key = (cls.pool.currency0, cls.pool.currency1, 3000, 60, ZERO)
        local.send(cls.deployer, cls.v4.poolManager,
                   calldata('initialize(' + KEY_TYPE + ',uint160)', [KEY_TYPE, 'uint160'], [cls.key, 2**96]))
        cls.driver = local.deploy(cls.deployer, 'OfficialV4Fixture.sol', 'OfficialV4SwapDriver', ['address'],
                                  [cls.v4.poolManager])
        cls.fund_tokens(cls.driver, 10**21)
        # Other liquidity in the pool, so the vault's additions earn against someone's (the owner gate).
        cls.position(cls.lp, 4 * 10**20)

    # ------------------------------------------------------------ helpers
    @classmethod
    def fund_tokens(cls, holder, amount):
        local = cls.local
        local.send(cls.deployer, cls.token, calldata('mint(address,uint256)', ['address', 'uint256'], [holder, amount]))
        local.send(cls.deployer, cls.weth, calldata('deposit()'), value=amount)
        local.send(cls.deployer, cls.weth, calldata('transfer(address,uint256)', ['address', 'uint256'], [holder, amount]))

    @classmethod
    def position(cls, owner, liquidity):
        """A [-600, 600) position minted to `owner` by a controller it deploys; returns the token id."""
        local = cls.local
        impersonate = owner == cls.owner
        controller = local.deploy(owner, 'OfficialV4Fixture.sol', 'OfficialV4Controller', ['address', 'address'],
                                  [cls.v4.poolManager, cls.v4.positionManager], impersonate=impersonate)
        cls.fund_tokens(controller, 10**21)
        token_id, = local.call(cls.v4.positionManager, 'nextTokenId()', ['uint256'])
        local.send(owner, controller, calldata('seed(' + KEY_TYPE + ',uint128)', [KEY_TYPE, 'uint128'],
                                               [cls.key, liquidity]), impersonate=impersonate)
        owner_of, = local.call(cls.v4.positionManager, 'ownerOf(uint256)', ['address'], ['uint256'], [token_id])
        assert owner_of.lower() == owner
        return token_id

    def vault(self, token_id, *, interval=600, paused=False):
        """The owner's vault on `token_id`, approved first as F3 prescribes."""
        local, factory = self.local, self.deployment.factory(4)
        nonce, = local.call(factory, 'nextNonce(address)', ['uint256'], ['address'], [self.owner])
        predicted, = local.call(factory, 'predictVault(address,uint256)', ['address'], ['address', 'uint256'],
                                [self.owner, nonce])
        local.send(self.owner, self.v4.positionManager, calldata('approve(address,uint256)', ['address', 'uint256'],
                                                                  [predicted, token_id]), impersonate=True)
        init = ((4, self.v4.positionManager, token_id), (1, 500, 2000, interval, 1), (100, 100, 300, 1000), paused, True)
        local.send(self.owner, factory, calldata('createVault(' + INIT_TYPE + ',uint256)', [INIT_TYPE, 'uint256'],
                                                 [init, nonce]), impersonate=True)
        return predicted.lower()

    def swaps(self, rounds, amount=5 * 10**17, seconds=3):
        for _ in range(rounds):
            for direction in (True, False):
                self.local.send(self.deployer, self.driver, calldata('swap(' + KEY_TYPE + ',bool,uint256)',
                                                                     [KEY_TYPE, 'bool', 'uint256'],
                                                                     [self.key, direction, amount]))
            self.local.mine(1, seconds)

    def chain_time(self):
        return int(self.local.head()['timestamp'], 16)

    def service(self, *, executor=True, planner=None, waiting_file=None):
        local = self.local

        def anvil(_, body):
            request = urllib.request.Request(local.url, json.dumps(body).encode(), {'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        endpoint = Endpoint('local', 'anvil.invalid', 'https://anvil.invalid/', None, 100, None, None)
        endpoints = ChainEndpoints(self.chain, (endpoint,), 'test', send=anvil)
        follower = HeadFollower(endpoints, max_age_seconds=1, max_block_age_seconds=3600, clock=self.chain_time)
        journal_directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, journal_directory)
        os.chmod(journal_directory, 0o700)
        chain_executor = None
        if executor:
            policy = GasPolicy(max_gas=3_000_000, max_fee_per_gas=10**11, priority_fee_per_gas=10**6,
                               max_cost_wei=3 * 10**17, daily_cap_wei=10**18, min_balance_wei=10**16,
                               confirmations=1, enabled=True)
            journal = Journal(journal_directory / 'journal.sqlite', 8453, self.operator, clock=self.chain_time)
            self.addCleanup(journal.close)
            chain_executor = ChainExecutor(self.chain, self.deployment, OperatorRpc(endpoints), OperatorKey(OPERATOR_KEY),
                                           journal, policy, clock=self.chain_time)
        return ChainAutomation(chain=self.chain, deployment=self.deployment, endpoints=endpoints, follower=follower,
                               planner=planner or PlannerConfig(), observations=PublisherPolicy(),
                               price_references=(), earnings_window_seconds=120, twap_seconds=600,
                               exit_twap_seconds=600, deadline_seconds=120, executor=chain_executor,
                               publisher_signer=ObservationSigner(PUBLISHER_KEY, chain_id=8453,
                                                                  anchor=self.deployment.price_anchor),
                               auto_exit=True, waiting_file=waiting_file)

    def liquidity(self, token_id):
        return self.local.call(self.v4.positionManager, 'getPositionLiquidity(uint256)', ['uint128'], ['uint256'],
                               [token_id])[0]

    def reserves(self, vault):
        return tuple(self.local.call(vault, 'reserves(address)', ['uint256'], ['address'], [token])[0]
                     for token in (self.pool.currency0, self.pool.currency1))

    def close(self, token_id, *, burn=False):
        """The owner closes its position on Uniswap itself, as the Uniswap app
        does: all its liquidity out (DECREASE_LIQUIDITY) or the NFT burned
        (BURN_POSITION), then TAKE_PAIR of everything to the owner."""
        if burn:
            actions, first = bytes([0x03, 0x11]), encode(['uint256', 'uint128', 'uint128', 'bytes'], [token_id, 0, 0, b''])
        else:
            actions = bytes([0x01, 0x11])
            first = encode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'],
                           [token_id, self.liquidity(token_id), 0, 0, b''])
        pair = encode(['address', 'address', 'address'], [self.pool.currency0, self.pool.currency1, self.owner])
        unlock = encode(['bytes', 'bytes[]'], [actions, [first, pair]])
        self.local.send(self.owner, self.v4.positionManager,
                        calldata('modifyLiquidities(bytes,uint256)', ['bytes', 'uint256'],
                                 [unlock, self.chain_time() + 600]), impersonate=True)

    def compounded(self, service, vault):
        """One pass that compounds `vault`, and the next one, which confirms it.
        The follower serves its head while the chain has moved at most 1 s:
        2 s later, each pass reads the chain as it is."""
        report = service.run_once()
        submitted = report['submitted']
        self.assertEqual((submitted['kind'], submitted['target'], submitted['state']), ('compound', vault, 'submitted'),
                         report)
        self.local.mine(1, 2)
        service.run_once()
        self.assertEqual(service.executor.journal.intent(submitted['intent'])['state'], 'confirmed')

    def balance(self, token, holder):
        return self.local.call(token, 'balanceOf(address)', ['uint256'], ['address'], [holder])[0]

    def logs(self, effect, interface, name, emitter):
        item = event(interface, name)
        return [item.decode(log) for log in effect['logs'] if log['address'] == emitter and log['topics'][0] == item.topic]

    # ---------------------------------------------------------------- tests
    def test_the_signers_digest_is_the_anchors_own(self):
        point = PriceObservation(self.pool, 2**96, 1_790_000_000, 1_790_000_120, 42)
        on_chain, = self.local.call(self.deployment.price_anchor, 'hashObservation(((uint8,address,address,uint24,int24,address),uint160,uint64,uint64,uint64))',
                                    ['bytes32'], ['((uint8,address,address,uint24,int24,address),uint160,uint64,uint64,uint64)'],
                                    [point.as_tuple()])
        self.assertEqual('0x' + on_chain.hex(), observation_digest(8453, self.deployment.price_anchor, point))

    def test_a_vault_compounds_end_to_end_and_pays_the_tariff_once(self):
        token_id = self.position(self.owner, 10**20)
        vault = self.vault(token_id)
        self.swaps(30)
        self.local.mine(35, 2)  # the price holds still over the publisher's look-back
        before = self.liquidity(token_id)
        recipient_before = (self.balance(self.pool.currency0, self.fee_recipient),
                            self.balance(self.pool.currency1, self.fee_recipient))
        service = self.service()
        report = service.run_once()
        entry = next(v for v in report['vaults'] if v['vault'] == vault)
        self.assertTrue(entry['act'], entry)
        self.assertEqual((report['submitted']['kind'], report['submitted']['target']), ('compound', vault), report)
        self.assertEqual(report['submitted']['state'], 'submitted', report)
        identifier = report['submitted']['intent']
        # The next pass reconciles the receipt.
        self.local.mine(1, 1)
        service.run_once()
        intent = service.executor.journal.intent(identifier)
        self.assertEqual(intent['state'], 'confirmed', intent)
        effect = json.loads(intent['effect'])
        executed = self.logs(effect, 'IDominoVaultExecution', 'Executed', vault)
        compounded, = self.logs(effect, 'IDominoVault', 'Compounded', vault)
        charged = [log for log in self.logs(effect, 'IDominoFeeEvents', 'FeeCharged', vault)]
        self.assertEqual(len(executed), 1)
        self.assertEqual('0x' + executed[0]['planHash'].hex(), entry['subject'])
        self.assertEqual(self.liquidity(token_id) - before, compounded['liquidityAdded'])
        self.assertGreater(compounded['liquidityAdded'], 0)
        # 2% (simple mode) of the consumed fees, once, in both tokens, to the registry's recipient.
        self.assertEqual(sorted(c['amount'] for c in charged), sorted([compounded['serviceFee0'], compounded['serviceFee1']]))
        self.assertTrue(all(c['kind'] == 2 for c in charged))
        self.assertGreater(compounded['serviceFee0'] + compounded['serviceFee1'], 0)
        paid = (self.balance(self.pool.currency0, self.fee_recipient) - recipient_before[0],
                self.balance(self.pool.currency1, self.fee_recipient) - recipient_before[1])
        self.assertEqual(paid, (compounded['serviceFee0'], compounded['serviceFee1']))
        nonce, = self.local.call(vault, 'stateNonce()', ['uint64'])
        self.assertEqual(nonce, entry['stateNonce'] + 1)
        # Nothing new while the interval runs: the vault would refuse it.
        again = next(v for v in self.service().run_once(act=False)['vaults'] if v['vault'] == vault)
        self.assertEqual((again['act'], again['reason']), (False, 'too_soon'))
        self.local.send(self.owner, vault, calldata('pause()'), impersonate=True)

    def test_a_dropped_execution_is_resent_as_the_same_bytes_and_spends_its_own_nonce(self):
        token_id = self.position(self.owner, 10**20)
        vault = self.vault(token_id)
        self.swaps(30)
        self.local.mine(35, 2)
        service = self.service()
        self.local.request('evm_setAutomine', [False])
        try:
            report = service.run_once()
            submitted = report['submitted']
            self.assertEqual((submitted['target'], submitted['state']), (vault, 'submitted'), report)
            journal = service.executor.journal
            attempt, = journal.intent(submitted['intent'])['attempts']
            self.local.request('anvil_dropTransaction', [attempt['tx_hash']])
            self.assertIsNone(self.local.request('eth_getTransactionByHash', [attempt['tx_hash']]))
            # The node lost it: the same signed bytes go again, after the call presimulates again.
            outcome = service.executor.reconcile(submitted['intent'])
            self.assertEqual(outcome.reason, 'resent')
            self.assertIsNotNone(self.local.request('eth_getTransactionByHash', [attempt['tx_hash']]))
            self.assertEqual(len(journal.intent(submitted['intent'])['attempts']), 1)
            self.local.request('evm_mine', [])
        finally:
            self.local.request('evm_setAutomine', [True])
        self.local.mine(1, 1)
        outcome = service.executor.reconcile(submitted['intent'])
        self.assertEqual(outcome.state, 'confirmed')
        receipt = self.local.request('eth_getTransactionReceipt', [attempt['tx_hash']])
        self.assertEqual(receipt['status'], '0x1')
        self.local.send(self.owner, vault, calldata('pause()'), impersonate=True)

    def test_the_excess_of_one_token_is_swapped_through_the_vaults_own_pool(self):
        token_id = self.position(self.owner, 10**20)
        vault = self.vault(token_id)
        self.swaps(30)
        # The price moves up inside the range: the position now takes more token1
        # than the balanced fees hold, so part of the token0 fees is swapped.
        pool_id = bytes.fromhex(self.pool.pool_id[2:])
        price = self.local.call(self.v4.stateView, 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'],
                                ['bytes32'], [pool_id])[0]
        active, = self.local.call(self.v4.stateView, 'getLiquidity(bytes32)', ['uint128'], ['bytes32'], [pool_id])
        target = min(price * 1015 // 1000, sqrt_at_tick(600) * 995 // 1000)
        self.assertGreater(target, price)
        push = active * (target - price) // 2**96  # token1 in moves the sqrt price up by amount / liquidity
        self.local.send(self.deployer, self.driver, calldata('swap(' + KEY_TYPE + ',bool,uint256)',
                                                             [KEY_TYPE, 'bool', 'uint256'], [self.key, False, push]))
        self.local.mine(35, 2)
        before = self.liquidity(token_id)
        service = self.service()
        report = service.run_once()
        entry = next(v for v in report['vaults'] if v['vault'] == vault)
        self.assertTrue(entry['act'], entry)
        self.assertTrue(entry['label'].startswith('swap_'), entry)
        self.assertEqual(report['submitted']['target'], vault, report)
        self.local.mine(1, 1)
        service.run_once()
        intent = service.executor.journal.intent(report['submitted']['intent'])
        self.assertEqual(intent['state'], 'confirmed', intent)
        effect = json.loads(intent['effect'])
        swapped, = self.logs(effect, 'IDominoVaultLedger', 'Swapped', vault)
        compounded, = self.logs(effect, 'IDominoVault', 'Compounded', vault)
        self.assertEqual((swapped['source'], swapped['zeroForOne']), (token_id, True))
        self.assertGreater(swapped['amountOut'], 0)
        self.assertEqual(self.liquidity(token_id) - before, compounded['liquidityAdded'])
        # The swap's output funded the add (A5): at most 1/100 of it stayed.
        lot, = self.local.call(vault, 'lot(uint256,address)', ['(uint128,uint128)'], ['uint256', 'address'],
                               [token_id, self.pool.currency1])
        self.assertLessEqual(lot[1], swapped['amountOut'] // 100)
        self.local.send(self.owner, vault, calldata('pause()'), impersonate=True)

    def test_an_auto_exit_executes_once_the_anchor_crosses_and_charges_twenty_bps(self):
        token_id = self.position(self.owner, 10**20)
        vault = self.vault(token_id)
        self.local.send(self.owner, vault, calldata('setExitModule(address)', ['address'], [self.deployment.auto_exit]),
                        impersonate=True)
        self.local.mine(35, 2)
        price = self.local.call(self.v4.stateView, 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'],
                                ['bytes32'], [bytes.fromhex(self.pool.pool_id[2:])])[0]
        mandate_hash = self.register_mandate(vault, token_id, below=price * 101 // 100, convert_to=self.weth, nonce=1)
        # A mandate whose trigger is not reached stays.
        other = self.register_mandate(vault, token_id, below=price * 90 // 100, convert_to=self.weth, nonce=2)
        weth_before = self.balance(self.weth, self.owner)
        service = self.service()
        report = service.run_once()
        exits = {e['mandate']: e for e in report['exits']}
        self.assertEqual((exits[other]['act'], exits[other]['reason']), (False, 'trigger_not_reached'))
        self.assertTrue(exits[mandate_hash]['act'], report)
        self.assertEqual(report['submitted']['kind'], 'exit', report)
        self.local.mine(1, 1)
        service.run_once()
        intent = service.executor.journal.intent(report['submitted']['intent'])
        self.assertEqual(intent['state'], 'confirmed', intent)
        effect = json.loads(intent['effect'])
        executed, = self.logs(effect, 'IDominoAutoExit', 'MandateExecuted', self.deployment.auto_exit)
        fees = self.logs(effect, 'IDominoFeeEvents', 'FeeCharged', self.deployment.auto_exit)
        status, = self.local.call(self.deployment.auto_exit, 'mandateStatus(bytes32)', ['uint8'], ['bytes32'],
                                  [bytes.fromhex(mandate_hash[2:])])
        self.assertEqual(status, 3)
        self.assertEqual(self.liquidity(token_id), 0)
        armed, = self.local.call(vault, 'rootArmed()', ['bool'])
        self.assertFalse(armed)
        # Converted into WETH, a charge currency: 20 bps of the converted output, in WETH.
        delivered = executed['amount0'] if self.pool.currency0 == self.weth else executed['amount1']
        self.assertGreater(delivered, 0)
        self.assertEqual([(f['kind'], f['token']) for f in fees], [(3, self.weth)])
        self.assertEqual(fees[0]['amount'], (delivered + fees[0]['amount']) * 20 // 10_000)
        self.assertGreaterEqual(self.balance(self.weth, self.owner) - weth_before, delivered)
        # One shot: the next pass sees it executed, sends nothing for it, and stops reading it.
        later = self.service()
        report = later.run_once(act=False)
        self.assertEqual({e['mandate']: e['reason'] for e in report['exits']}[mandate_hash], 'mandate_not_active')
        report = later.run_once(act=False)
        self.assertNotIn(mandate_hash, {e['mandate'] for e in report['exits']})

    def test_a_paused_vault_still_exits_protection_without_compounding(self):
        # Owner decision, 2 Oct: a vault created paused with the exit module enabled.
        token_id = self.position(self.owner, 10**20)
        vault = self.vault(token_id, paused=True)
        self.local.send(self.owner, vault, calldata('setExitModule(address)', ['address'], [self.deployment.auto_exit]),
                        impersonate=True)
        self.local.mine(35, 2)
        price = self.local.call(self.v4.stateView, 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'],
                                ['bytes32'], [bytes.fromhex(self.pool.pool_id[2:])])[0]
        mandate_hash = self.register_mandate(vault, token_id, below=price * 101 // 100, convert_to=0, nonce=11)
        service = self.service()
        report = service.run_once()
        self.assertEqual({v['vault']: v['reason'] for v in report['vaults']}[vault], 'vault_paused')
        self.assertEqual((report['submitted']['kind'], report['submitted']['state']), ('exit', 'submitted'), report)
        self.local.mine(1, 1)
        service.run_once()
        self.assertEqual(service.executor.journal.intent(report['submitted']['intent'])['state'], 'confirmed')
        status, = self.local.call(self.deployment.auto_exit, 'mandateStatus(bytes32)', ['uint8'], ['bytes32'],
                                  [bytes.fromhex(mandate_hash[2:])])
        self.assertEqual(status, 3)
        self.assertEqual(self.liquidity(token_id), 0)

    def test_why_a_vault_or_a_mandate_waits_is_recorded_for_the_read_api(self):
        token_id = self.position(self.owner, 10**20)
        vault = self.vault(token_id)
        self.local.send(self.owner, vault, calldata('setExitModule(address)', ['address'], [self.deployment.auto_exit]),
                        impersonate=True)
        self.local.mine(35, 2)
        price = self.local.call(self.v4.stateView, 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'],
                                ['bytes32'], [bytes.fromhex(self.pool.pool_id[2:])])[0]
        mandate_hash = self.register_mandate(vault, token_id, below=price * 101 // 100, convert_to=0, nonce=12)
        # The owner withdraws the vault's approval: the exit's presimulation reverts in the vault.
        self.local.send(self.owner, self.v4.positionManager, calldata('approve(address,uint256)', ['address', 'uint256'],
                                                                      [ZERO, token_id]), impersonate=True)
        directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, directory)
        waiting_file = directory / 'base-8453.waiting.json'
        service = self.service(waiting_file=waiting_file)
        report = service.run_once()
        entry = {e['mandate']: e for e in report['exits']}[mandate_hash]
        self.assertEqual((entry['act'], entry['reason']), (False, 'reverted_automation_unavailable'))
        self.assertIsNone(report['submitted'])
        snapshot = json.loads(waiting_file.read_text())
        head = self.local.head()
        self.assertEqual((snapshot['kind'], snapshot['chainId'], snapshot['block']),
                         ('domino-v2-automation-waiting', 8453, int(head['number'], 16)))
        waiting = snapshot['mandates'][mandate_hash]
        self.assertEqual(waiting['lastRevert'], {'code': 'reverted_automation_unavailable',
                                                 'at': int(head['timestamp'], 16), 'block': int(head['number'], 16)})
        # The first pass that gave the reason: this one.
        self.assertEqual((waiting['since'], waiting['sinceBlock']),
                         (int(head['timestamp'], 16), int(head['number'], 16)))
        self.assertIn(vault, snapshot['vaults'])
        self.assertEqual(oct(os.stat(waiting_file).st_mode & 0o777), '0o644')
        # Keep this mandate from firing in later tests.
        self.local.send(self.owner, self.deployment.auto_exit, calldata('revokeMandate(bytes32)', ['bytes32'],
                                                                       [bytes.fromhex(mandate_hash[2:])]),
                        impersonate=True)
        self.local.send(self.owner, vault, calldata('pause()'), impersonate=True)

    def test_a_spot_pushed_in_the_last_block_does_not_fire_an_exit(self):
        token_id = self.position(self.owner, 10**20)
        vault = self.vault(token_id)
        self.local.send(self.owner, vault, calldata('setExitModule(address)', ['address'], [self.deployment.auto_exit]),
                        impersonate=True)
        self.local.mine(35, 2)
        price = self.local.call(self.v4.stateView, 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'],
                                ['bytes32'], [bytes.fromhex(self.pool.pool_id[2:])])[0]
        mandate_hash = self.register_mandate(vault, token_id, below=price * 99 // 100, convert_to=0, nonce=3)
        # One large swap pushes the spot below the trigger in the newest block only.
        zero_for_one = True
        self.local.send(self.deployer, self.driver, calldata('swap(' + KEY_TYPE + ',bool,uint256)',
                                                             [KEY_TYPE, 'bool', 'uint256'],
                                                             [self.key, zero_for_one, 7 * 10**18]))
        pushed = self.local.call(self.v4.stateView, 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'],
                                 ['bytes32'], [bytes.fromhex(self.pool.pool_id[2:])])[0]
        self.assertLess(pushed, price * 99 // 100)
        report = self.service().run_once()
        entry = {e['mandate']: e for e in report['exits']}[mandate_hash]
        self.assertEqual((entry['act'], entry['reason']), (False, 'v2_observation_unstable'))
        self.assertIsNone(report['submitted'])
        status, = self.local.call(self.deployment.auto_exit, 'mandateStatus(bytes32)', ['uint8'], ['bytes32'],
                                  [bytes.fromhex(mandate_hash[2:])])
        self.assertEqual(status, 1)
        # Revoke it, pause this vault and put the price back for the other tests.
        self.local.send(self.owner, self.deployment.auto_exit, calldata('revokeMandate(bytes32)', ['bytes32'],
                                                                       [bytes.fromhex(mandate_hash[2:])]),
                        impersonate=True)
        self.local.send(self.owner, vault, calldata('pause()'), impersonate=True)
        self.local.send(self.deployer, self.driver, calldata('swap(' + KEY_TYPE + ',bool,uint256)',
                                                             [KEY_TYPE, 'bool', 'uint256'],
                                                             [self.key, False, 7 * 10**18]))

    def test_a_vault_whose_owner_closed_the_root_returns_its_reserves_before_any_compound(self):
        # The V1 incident of 2 Oct 2026: the owner closes the automated position
        # on Uniswap itself, and the fees the automation collected stay in the vault.
        first = self.position(self.owner, 10**20)
        closed = self.vault(first)
        self.swaps(30)
        self.local.mine(35, 2)
        service = self.service()
        self.compounded(service, closed)
        reserves = self.reserves(closed)
        self.assertGreater(sum(reserves), 0, 'the compound left reserves')
        self.close(first)
        self.local.mine(1, 2)
        self.assertEqual(self.liquidity(first), 0)
        armed, = self.local.call(closed, 'rootArmed()', ['bool'])
        self.assertFalse(armed)
        self.assertEqual(self.reserves(closed), reserves, 'the close itself returns nothing')
        # Past the closed vault's 600 s interval (the vault's floor), so what it
        # waits for at the end is its disarmed root, not its interval.
        self.local.mine(1, 600)
        # Another vault becomes eligible to compound in the same pass.
        second = self.position(self.owner, 10**20)
        other = self.vault(second)
        self.swaps(30)
        self.local.mine(35, 2)
        owner_before = tuple(self.balance(token, self.owner) for token in (self.pool.currency0, self.pool.currency1))
        report = service.run_once()
        entries = {v['vault']: v for v in report['vaults']}
        entry = entries[closed]
        self.assertEqual((entry['act'], entry['reason'], entry['action'], entry['simulation']),
                         (True, 'reserves_returnable', 'return_reserves', 'passed'), entry)
        self.assertEqual(entry['paid'], [str(amount) for amount in reserves])
        self.assertTrue(entries[other]['act'], entries[other])
        submitted = report['submitted']
        self.assertEqual((submitted['kind'], submitted['target'], submitted['state']), ('return', closed, 'submitted'),
                         report)
        journal = service.executor.journal
        self.assertEqual(journal.waiting()['vaults'][closed]['reason'], 'reserves_returnable')
        self.local.mine(1, 2)
        report = service.run_once()  # confirms the return, then compounds the other vault
        intent = journal.intent(submitted['intent'])
        self.assertEqual((intent['state'], intent['kind']), ('confirmed', 'return'), intent)
        effect = json.loads(intent['effect'])
        paid = {log['token'].lower(): log['amount'] for log in self.logs(effect, 'IDominoVault', 'ReservesWithdrawn',
                                                                          closed)}
        self.assertEqual(paid, {token: amount for token, amount in zip((self.pool.currency0, self.pool.currency1),
                                                                        reserves) if amount})
        self.assertEqual(tuple(self.balance(token, self.owner) - before for token, before in
                               zip((self.pool.currency0, self.pool.currency1), owner_before)), reserves)
        self.assertEqual(self.reserves(closed), (0, 0))
        self.assertEqual((report['submitted']['kind'], report['submitted']['target']), ('compound', other), report)
        # Nothing is left to return: the closed vault waits for nothing more.
        self.assertEqual({v['vault']: v for v in report['vaults']}[closed]['reason'], 'root_disarmed')
        self.local.mine(1, 2)
        service.run_once()
        self.local.send(self.owner, other, calldata('pause()'), impersonate=True)

    def test_a_burned_root_returns_its_reserves_too(self):
        token_id = self.position(self.owner, 10**20)
        vault = self.vault(token_id)
        self.swaps(30)
        self.local.mine(35, 2)
        service = self.service()
        self.compounded(service, vault)
        reserves = self.reserves(vault)
        self.assertGreater(sum(reserves), 0, 'the compound left reserves')
        self.close(token_id, burn=True)
        self.local.mine(1, 2)
        exists = self.local.raw({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_call', 'params': [
            {'to': self.v4.positionManager, 'data': calldata('ownerOf(uint256)', ['uint256'], [token_id])}, 'latest']})
        self.assertIn('error', exists, 'burned')
        owner_before = tuple(self.balance(token, self.owner) for token in (self.pool.currency0, self.pool.currency1))
        report = service.run_once()
        entry = {v['vault']: v for v in report['vaults']}[vault]
        self.assertEqual((entry['act'], entry['reason']), (True, 'reserves_returnable'), entry)
        submitted = report['submitted']
        self.assertEqual((submitted['kind'], submitted['target']), ('return', vault), report)
        self.local.mine(1, 2)
        report = service.run_once()
        self.assertEqual(service.executor.journal.intent(submitted['intent'])['state'], 'confirmed')
        self.assertEqual(tuple(self.balance(token, self.owner) - before for token, before in
                               zip((self.pool.currency0, self.pool.currency1), owner_before)), reserves)
        self.assertEqual(self.reserves(vault), (0, 0))
        self.assertIsNone(report['submitted'])

    # ------------------------------------------------------------ mandates
    def register_mandate(self, vault, token_id, *, below, convert_to, nonce):
        mode = 0 if convert_to == 0 else 1
        target = ZERO if convert_to == 0 else convert_to
        valid_until = self.chain_time() + 86400
        message = {'owner': to_checksum_address(self.owner), 'vault': to_checksum_address(vault), 'tokenId': token_id,
                   'triggerBelowSqrtPriceX96': below, 'triggerAboveSqrtPriceX96': 0, 'receiveMode': mode,
                   'convertTo': to_checksum_address(target), 'maxSlippageBps': 100, 'validUntil': valid_until,
                   'nonce': nonce}
        typed = {'types': {'EIP712Domain': EIP712['domain']['fields'], 'ExitMandate': EIP712['types']['ExitMandate']},
                 'primaryType': 'ExitMandate',
                 'domain': {'name': 'Domino', 'version': '2', 'chainId': 8453,
                            'verifyingContract': to_checksum_address(self.deployment.auto_exit)},
                 'message': message}
        signature = bytes(Account.from_key(OWNER_KEY).sign_message(encode_typed_data(full_message=typed)).signature)
        values = (self.owner, vault, token_id, below, 0, mode, target, 100, valid_until, nonce)
        receipt = self.local.send(self.deployer, self.deployment.auto_exit,
                                  calldata('registerMandate(' + MANDATE_TYPE + ',bytes)', [MANDATE_TYPE, 'bytes'],
                                           [values, signature]))
        registered = event('IDominoAutoExit', 'MandateRegistered')
        log = next(l for l in receipt['logs'] if l['topics'][0] == registered.topic)
        return '0x' + registered.decode({'topics': log['topics'], 'data': log['data']})['mandateHash'].hex()


if __name__ == '__main__':
    unittest.main()
