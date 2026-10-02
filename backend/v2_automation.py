"""The V2 automation service of one chain: compounds and auto-exits.

    python backend/v2_automation.py --config /etc/domino/v2/automation/base-8453.json status
    python backend/v2_automation.py --config ... plan        # keyless dry run: every vault's decision
    python backend/v2_automation.py --config ... run-once    # reconcile, then one pass with the keys
    python backend/v2_automation.py --config ... serve       # run-once every passSeconds

One process serves one chain (the Elysium isolation principle F6 follows),
with one operator key and one publisher key, each from its encrypted keystore
and the systemd credential holding its password (automation_keys: the V1
pattern, never a plain key on the VM). Each pass:

1. reads the head from the chain's shared follower (v2_head) and reconciles
   the operator's journal: nothing new is claimed while one is unresolved;
2. auto-exits first (a stop-loss is time-sensitive): every active mandate
   whose anchor crossed a trigger is presimulated and sent (v2_autoexit);
3. compounds: every factory vault (v2_vaults discovery, proven at the head)
   is read and planned (v2_planner); the best one that clears both gates
   with the presimulated gas is sent. A v4 vault's anchor is the publisher's
   observation of the spot at the head the plan was made at; a v3 vault's,
   the pool's TWAP through the price anchor.
Output is one JSON object per command, with decisions and fixed codes; no
key, password, keyed URL or raw provider message ever reaches it.

The configuration is a private file (0600 in a 0700 directory outside any
checkout), every value validated; see docs/v2/V2_AUTOMATION_BACKEND.md.
"""
import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

from discovery import DataError, address
from execution_cli import private_file
from local_config import load_config
from v2_autoexit import (MandateWatcher, eligible, module_parameters, plan_exit, position_ref, read_mandates,
                         twap_exit_evidence, vault_facts)
from v2_chains import DEX_V4, default_registry
from v2_manifest import load_deployment
from v2_executor import CallReverted, ChainExecutor, GasPolicy, Journal, OperatorKey, OperatorRpc
from v2_head import HeadFollower
from v2_observation import HistoricalPrices, ObservationSigner, Publisher, PublisherPolicy
from v2_plan import execute_calldata, plan_hash, twap_evidence
from v2_planner import FeeGrowth, GasQuote, PlannerConfig, decide, preconditions, price_book, remeasured
from v2_rpc import ChainIndexRpc, configured_endpoints, load_chain_rpc_config
from v2_uniswap import UniswapReader
from v2_vaults import (VaultDiscovery, VaultReader, anchor_min_twap, checked_references, earlier_block,
                       fee_growth_inside, l1_fee, reference_prices, twap_price, twap_window)

KIND = 'domino-v2-automation'
MAX_CONFIG_BYTES = 65536
SIGNER_KEYS = {'address', 'keystoreFile', 'credential'}
CONFIG_KEYS = {'schemaVersion', 'kind', 'chain', 'deploymentFile', 'rpc', 'headFile', 'journalFile', 'operator',
               'publisher', 'gas', 'planner', 'observations', 'priceReferences', 'earningsWindowSeconds',
               'twapSeconds', 'exitTwapSeconds', 'deadlineSeconds', 'passSeconds', 'headMaxAgeSeconds', 'autoExit',
               'vaultDefaults', 'vaultGasCeilingWei', 'vaultGasCeilingsWei', 'waitingFile'}
U256 = 2**256 - 1


@dataclass(frozen=True)
class VaultDefaults:
    """What a new vault is offered (IDominoVault.Init), and how far the owner
    may move it: the owner's decisions of 2 Oct 2026 (F7 spec §9, item 12),
    kept here under documented names so the app and the read API take them
    from one place. The automation plans with each vault's own on-chain values.

    mode None: no default, the owner chooses Auto-compound (1, 2%) or
    Domino-compound (2, 4%); maxPositions is the Domino default and Auto-compound
    always takes 1. ownerMaxima bound what the app lets the owner select;
    exitMaxSlippageBps is an exit mandate's default slippage, on top of the
    pool's fee (the module allows up to 10%).
    """
    mode: int | None
    policy: dict
    limits: dict
    start_paused: bool
    owner_maxima: dict
    exit_max_slippage_bps: int


def checked_vault_defaults(document):
    keys = {'mode', 'policy', 'limits', 'startPaused', 'ownerMaxima', 'exitMaxSlippageBps'}
    if type(document) is not dict or set(document) != keys:
        raise DataError('v2_automation_config_invalid')
    mode, policy, limits, maxima = document['mode'], document['policy'], document['limits'], document['ownerMaxima']
    policy_keys = {'triggerDistanceBps', 'maxOverlapBps', 'minimumIntervalSeconds', 'maxPositions'}
    limit_keys = {'maxSlippageBps', 'maxPriceImpactBps', 'maxObservationAgeSeconds', 'upsideBps'}
    if (mode not in (None, 1, 2) or type(mode) is bool or type(policy) is not dict or set(policy) != policy_keys
            or type(limits) is not dict or set(limits) != limit_keys or type(document['startPaused']) is not bool
            or type(maxima) is not dict or set(maxima) != {'maxSlippageBps', 'maxPriceImpactBps'}
            or any(type(v) is not int for v in (*policy.values(), *limits.values(), *maxima.values(),
                                                document['exitMaxSlippageBps']))):
        raise DataError('v2_automation_config_invalid')
    # DominoV2VaultBase._storePolicy / _storeLimits, and the auto-exit's MAX_SLIPPAGE_BPS.
    if (not 0 <= policy['triggerDistanceBps'] <= 2000 or not 0 <= policy['maxOverlapBps'] <= 2000
            or not 0 < policy['minimumIntervalSeconds'] < 2**32 or not 1 <= policy['maxPositions'] <= 255
            or (mode == 1 and policy['maxPositions'] != 1)
            or not 0 <= limits['maxSlippageBps'] <= maxima['maxSlippageBps'] < 10_000
            or not 0 <= limits['maxPriceImpactBps'] <= maxima['maxPriceImpactBps'] < 10_000
            or not 0 < limits['maxObservationAgeSeconds'] < 2**32 or not 1 <= limits['upsideBps'] <= 1_000_000
            or not 1 <= document['exitMaxSlippageBps'] <= 1000):
        raise DataError('v2_automation_config_invalid')
    return VaultDefaults(mode, dict(policy), dict(limits), document['startPaused'], dict(maxima),
                         document['exitMaxSlippageBps'])


@dataclass(frozen=True)
class SignerConfig:
    address: str
    keystore_file: str
    credential: str


@dataclass(frozen=True)
class AutomationConfig:
    chain: object
    deployment_file: str
    rpc: dict
    head_file: str
    journal_file: str
    operator: SignerConfig
    publisher: SignerConfig
    gas: GasPolicy
    planner: PlannerConfig
    observations: PublisherPolicy
    price_references: tuple
    earnings_window_seconds: int
    twap_seconds: int
    exit_twap_seconds: int
    deadline_seconds: int
    pass_seconds: int
    head_max_age_seconds: int
    auto_exit: bool
    vault_defaults: VaultDefaults
    vault_gas_ceiling_wei: int | None
    vault_gas_ceilings_wei: dict
    waiting_file: str | None


def _int(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise DataError('v2_automation_config_invalid')
    return value


def _path(value):
    if type(value) is not str or not value.startswith('/') or '..' in Path(value).parts or len(value) > 512:
        raise DataError('v2_automation_config_invalid')
    return value


def _signer(entry):
    if type(entry) is not dict or set(entry) != SIGNER_KEYS:
        raise DataError('v2_automation_config_invalid')
    if (type(entry['address']) is not str or not re.fullmatch(r'0x[0-9a-fA-F]{40}', entry['address'])
            or type(entry['credential']) is not str or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}', entry['credential'])):
        raise DataError('v2_automation_config_invalid')
    return SignerConfig(address(entry['address']), _path(entry['keystoreFile']), entry['credential'])


def _camel(fields):
    return {re.sub(r'_([a-z0-9])', lambda m: m.group(1).upper(), name): name for name in fields}


def _dataclass(kind, document, *, required=()):
    names = _camel(kind.__dataclass_fields__)
    if type(document) is not dict or not set(document) <= set(names) or not set(required) <= set(document):
        raise DataError('v2_automation_config_invalid')
    values = {names[key]: tuple(value) if type(value) is list else value for key, value in document.items()}
    return kind(**values)


def checked_config(document):
    """A validated automation configuration; refuses it whole."""
    if (type(document) is not dict or set(document) != CONFIG_KEYS or document.get('schemaVersion') != 1
            or type(document['schemaVersion']) is not int or document.get('kind') != KIND):
        raise DataError('v2_automation_config_invalid')
    chain = default_registry().chain(document['chain'])
    rpc = document['rpc']
    if type(rpc) is not dict or set(rpc) not in ({'chainRpcFile'}, {'providerFile'}):
        raise DataError('v2_automation_config_invalid')
    if ('providerFile' in rpc) != (chain.chainId == 4663):
        raise DataError('v2_automation_config_invalid')  # Robinhood reads the read path's provider file only
    operator, publisher = _signer(document['operator']), _signer(document['publisher'])
    if operator.address == publisher.address or operator.credential == publisher.credential:
        raise DataError('v2_automation_config_invalid')
    gas = _dataclass(GasPolicy, document['gas'], required=('maxGas', 'maxFeePerGas', 'priorityFeePerGas',
                                                            'maxCostWei', 'dailyCapWei', 'minBalanceWei'))
    if type(document['autoExit']) is not bool:
        raise DataError('v2_automation_config_invalid')
    overrides = document['vaultGasCeilingsWei']
    if type(overrides) is not dict or any(not isinstance(k, str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', k)
                                          for k in overrides):
        raise DataError('v2_automation_config_invalid')
    ceilings = {address(k): _int(v, 1, U256) for k, v in overrides.items()}
    ceiling = document['vaultGasCeilingWei']
    if ceiling is not None:
        ceiling = _int(ceiling, 1, U256)
    return AutomationConfig(
        chain=chain, deployment_file=_path(document['deploymentFile']), rpc={k: _path(v) for k, v in rpc.items()},
        head_file=_path(document['headFile']), journal_file=_path(document['journalFile']),
        operator=operator, publisher=publisher, gas=gas,
        planner=_dataclass(PlannerConfig, document['planner']),
        observations=_dataclass(PublisherPolicy, document['observations']),
        price_references=checked_references(chain, document['priceReferences']),
        earnings_window_seconds=_int(document['earningsWindowSeconds'], 60, 86400),
        twap_seconds=_int(document['twapSeconds'], 1, 86400),
        exit_twap_seconds=_int(document['exitTwapSeconds'], 1, 86400),
        deadline_seconds=_int(document['deadlineSeconds'], 10, 3600),
        pass_seconds=_int(document['passSeconds'], 1, 3600),
        head_max_age_seconds=_int(document['headMaxAgeSeconds'], 1, 60),
        auto_exit=document['autoExit'], vault_defaults=checked_vault_defaults(document['vaultDefaults']),
        vault_gas_ceiling_wei=ceiling, vault_gas_ceilings_wei=ceilings,
        waiting_file=None if document['waitingFile'] is None else _path(document['waitingFile']))


def load_automation_config(path):
    try:
        document = json.loads(private_file(path, MAX_CONFIG_BYTES))
    except DataError:
        raise
    except Exception:
        raise DataError('v2_automation_config_unreadable') from None
    return checked_config(document)


# ------------------------------------------------------------------ service
class ChainAutomation:
    """One chain's pass. Built from parts so tests can supply local ones."""

    def __init__(self, *, chain, deployment, endpoints, follower, planner, observations, price_references,
                 earnings_window_seconds, twap_seconds, exit_twap_seconds, deadline_seconds, executor=None,
                 publisher_signer=None, auto_exit=True, vault_gas_ceiling_wei=None, vault_gas_ceilings_wei=None,
                 quoter_factory=None, waiting_file=None, clock=time.time):
        self.chain, self.deployment, self.endpoints, self.follower = chain, deployment, endpoints, follower
        self.planner, self.observations, self.references = planner, observations, price_references
        self.window, self.twap_seconds, self.exit_twap_seconds = earnings_window_seconds, twap_seconds, exit_twap_seconds
        self.deadline_seconds, self.executor, self.publisher_signer = deadline_seconds, executor, publisher_signer
        self.auto_exit, self.clock = auto_exit, clock
        # The per-vault gas ceiling (native wei per execution) the vaults no longer
        # hold on-chain (A15): a default and per-vault overrides, owner decisions.
        self.gas_ceiling, self.gas_ceilings = vault_gas_ceiling_wei, dict(vault_gas_ceilings_wei or {})
        # The quote seam (v2_planner.PoolQuoter by default): a factory of quoters per pass.
        self.quoter_factory = quoter_factory
        # Where the read API finds why each vault and mandate waits (docs/v2/V2_AUTOMATION_BACKEND.md).
        self.waiting_file = Path(waiting_file) if waiting_file else None
        self.discovery = VaultDiscovery(deployment)
        self.mandates = MandateWatcher(deployment)
        self.proven = set()  # vaults proven to be the manifest's clones, once per process

    # ------------------------------------------------------------ clients
    def _clients(self, head):
        rpc = self.endpoints.read_rpc(anchor=head.block, batch_reads=True, max_requests=600)
        history = self.endpoints.history_rpc(batch_reads=True, max_requests=200)
        self.index = ChainIndexRpc(self.endpoints, batch_reads=True, max_requests=200)
        return rpc, UniswapReader(self.chain, rpc), history, UniswapReader(self.chain, history)

    def _publisher(self, reader, history_reader):
        if self.publisher_signer is None:
            return None
        return Publisher(self.chain, self.publisher_signer, reader, HistoricalPrices(history_reader),
                         self.observations)

    # -------------------------------------------------------------- pass
    def run_once(self, *, act=True):
        """One pass; with act=False nothing is signed or sent (a dry run)."""
        head = self.follower.head()
        block = head.block
        report = {'chain': self.chain.key, 'block': block.number, 'timestamp': block.timestamp, 'reconciled': [],
                  'exits': [], 'vaults': [], 'submitted': None}
        rpc, uniswap, history, history_uniswap = self._clients(head)
        # Reads shared by every vault of this pass: billed calls, made once.
        self._pass = {'references': None, 'growth': {}, 'min_twap': None}
        self.deployment.verify_code(rpc, block)
        busy = False
        if act and self.executor is not None:
            report['reconciled'] = [vars(o) for o in self.executor.reconcile_all()]
            busy = bool(self.executor.journal.unresolved() or self.executor.journal.attention())
            try:
                self.executor.check_signer(block)
            except DataError as error:
                # Plan and report, send nothing: the signer is not one to use now.
                report['signer'], busy = str(error), True
        publisher = self._publisher(uniswap, history_uniswap)
        if self.auto_exit:
            for entry in self._exits(head, rpc, uniswap, publisher):
                report['exits'].append(entry)
                if act and not busy and entry.get('plan') is not None:
                    report['submitted'] = self._submit('exit', self.deployment.auto_exit, entry, head)
                    busy = True
                entry.pop('plan', None)
        candidates = []
        for record in self.discovery.scan(self.index, block):
            entry = {'vault': record.vault, 'dex': record.dex}
            try:
                entry.update(self._compound(record, head, rpc, uniswap, history, publisher))
            except CallReverted as error:
                entry.update(act=False, reason=str(error), simulation='reverted')
            except DataError as error:
                entry.update(act=False, reason=str(error))
            report['vaults'].append(entry)
            if entry.get('act'):
                candidates.append(entry)
        if act and not busy and candidates:
            best = max(candidates, key=lambda e: e['netOwnerWei'])
            report['submitted'] = self._submit('compound', best['vault'], best, head)
        for entry in report['vaults']:
            entry.pop('plan', None)
        if act and self.executor is not None:
            self._record_waiting(report, block)
        return report

    def _record_waiting(self, report, block):
        """Each vault's and mandate's reason, since when it has held (`since` and
        `sinceBlock`: the journal keeps the first pass that gave the current
        reason, Journal.record_waiting) and last presimulation revert, durable in
        the journal and, when configured, in the read API's snapshot file."""
        journal = self.executor.journal
        entries = [('vault', e['vault'], e['reason'], e.get('simulation')) for e in report['vaults']]
        entries += [('mandate', e['mandate'], e['reason'], e.get('simulation')) for e in report['exits']]
        journal.record_waiting(entries, at=block.timestamp, block=block.number)
        if self.waiting_file is None:
            return
        snapshot = {'schemaVersion': 1, 'kind': 'domino-v2-automation-waiting', 'chainId': self.chain.chainId,
                    'block': block.number, 'timestamp': block.timestamp, **journal.waiting()}
        fd, temporary = tempfile.mkstemp(prefix='.waiting-', dir=self.waiting_file.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(snapshot, stream, sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o644)  # public chain data, read by the read API's user
            os.replace(temporary, self.waiting_file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _submit(self, kind, target, entry, head):
        plan = entry['plan']
        try:
            outcome = self.executor.submit(kind=kind, target=target, subject=entry['subject'], data=plan['calldata'],
                                           deadline=plan['deadline'], head=head.block, base_fee=head.base_fee_per_gas,
                                           gas=plan['gas'])
            return {'kind': kind, 'target': target, 'intent': outcome.intent, 'state': outcome.state,
                    'reason': outcome.reason}
        except DataError as error:
            return {'kind': kind, 'target': target, 'state': 'refused', 'reason': str(error)}

    # ---------------------------------------------------------- compound
    def _compound(self, record, head, rpc, uniswap, history, publisher):
        block = head.block
        reader = VaultReader(self.chain, self.deployment, rpc, uniswap, proven=self.proven)
        vault = reader.read(record, block)
        blocked = preconditions(vault, block.timestamp)
        if blocked is not None:  # nothing to price while the vault would refuse any plan
            return {'act': False, 'reason': blocked, 'stateNonce': vault.state_nonce}
        pool = vault.pool.pool
        if pool.dex == DEX_V4:
            anchor, evidence = vault.pool.sqrt_price_x96, None
        else:
            if self._pass['min_twap'] is None:
                self._pass['min_twap'] = anchor_min_twap(rpc, self.deployment, block)
            window = twap_window(vault.limits, self._pass['min_twap'], self.twap_seconds)
            anchor, evidence = twap_price(rpc, self.deployment, pool, window, block), twap_evidence(window)
        if self._pass['references'] is None:
            self._pass['references'] = reference_prices(self.chain, uniswap, self.references, block)
        prices = price_book(pool, anchor, self._pass['references'])
        gas = GasQuote(fee_per_gas=(head.base_fee_per_gas or 0) + (self.executor.policy.priority_fee_per_gas
                                                                    if self.executor else 0))
        ceiling = self.gas_ceilings.get(record.vault, self.gas_ceiling)
        quoter = self.quoter_factory(vault, rpc, block) if self.quoter_factory else None

        def plan(growth):
            return decide(vault, anchor, prices, gas, self.planner, growth_by_target=growth, quoter=quoter,
                          max_gas_cost_wei=ceiling)
        # The owner gate's evidence costs history reads: only for members whose
        # candidates already clear everything else.
        decision = plan({})
        waiting = {int(label.split(':')[0]) for label, reason in decision.considered
                   if reason == 'earnings_evidence_missing'}
        growth = self._growth(vault, rpc, history, block, waiting) if waiting else {}
        if growth:
            decision = plan(growth)
        result = {'act': decision.act, 'reason': decision.reason, 'considered': dict(decision.considered),
                  'stateNonce': vault.state_nonce}
        if not decision.act:
            return result
        if self.executor is None:
            return {**result, 'reason': 'eligible_keyless', 'target': decision.candidate.target,
                    'label': decision.candidate.label}
        if evidence is None:
            if publisher is None:
                return {**result, 'act': False, 'reason': 'publisher_unavailable'}
            signed = publisher.observe(pool, block, max_age_seconds=vault.limits.max_observation_age_seconds)
            evidence = signed.evidence()
            deadline = min(block.timestamp + self.deadline_seconds, signed.observation.valid_until)
        else:
            deadline = block.timestamp + self.deadline_seconds
        built = decision.plan(vault, anchor_evidence=evidence, deadline=deadline)
        raw = built.encode()
        calldata = execute_calldata(raw)
        gas_limit, estimate = self.executor.presimulate(record.vault, calldata, block)
        gas = GasQuote(gas.fee_per_gas, l1_fee(self.chain, rpc, len(calldata) // 2 - 1, block))
        checked = remeasured(decision, vault, prices, gas, self.planner, estimate,
                             growth=growth.get(decision.candidate.target), max_gas_cost_wei=ceiling)
        economics = checked.economics
        result.update(act=checked.act, reason=checked.reason, target=checked.candidate.target,
                      label=checked.candidate.label, gasEstimate=estimate, simulation='passed',
                      tariff=[str(v) for v in economics.tariff], tariffWei=str(int(economics.tariff_wei)),
                      gasWei=str(economics.gas_wei), netOwnerWei=int(economics.net_owner_wei or 0),
                      subject=plan_hash(self.chain.chainId, record.vault, raw),
                      plan={'calldata': calldata, 'deadline': deadline, 'gas': gas_limit})
        return result

    def _growth(self, vault, rpc, history, block, targets):
        """Fee growth evidence for `targets` (member token ids) over the
        configured window; one reading per pool and range per pass."""
        evidence, cache = {}, self._pass['growth']
        if 'start' not in cache:
            try:
                cache['start'] = earlier_block(history, block, self.window, self.chain.block_time)
            except DataError:
                cache['start'] = None
        start = cache['start']
        if start is None:
            return evidence
        for member in vault.members:
            if member.token_id not in targets:
                continue
            key = (vault.pool.pool, member.tick_lower, member.tick_upper)
            if key not in cache:
                try:
                    begin = fee_growth_inside(self.chain, history, vault.pool.pool, member.tick_lower,
                                              member.tick_upper, start)
                    end = fee_growth_inside(self.chain, rpc, vault.pool.pool, member.tick_lower, member.tick_upper,
                                            block)
                    cache[key] = FeeGrowth(begin[0], begin[1], start.timestamp, end[0], end[1], block.timestamp)
                except DataError:
                    cache[key] = None
            if cache[key] is not None:
                evidence[member.token_id] = cache[key]
        return evidence

    # --------------------------------------------------------------- exits
    def _exits(self, head, rpc, uniswap, publisher):
        block = head.block
        hashes = self.mandates.scan(self.index, block)
        if not hashes:
            return []
        parameters = module_parameters(rpc, self.deployment, block)
        entries = []
        for mandate in read_mandates(rpc, self.deployment, hashes, block):
            entry = {'mandate': mandate.hash, 'vault': mandate.vault, 'tokenId': mandate.token_id}
            try:
                if mandate.status != 1 or block.timestamp > mandate.valid_until:
                    # Revoked, executed or expired: final, so it is not read again.
                    self.mandates.forget(mandate.hash)
                    entry.update(act=False, reason='mandate_not_active' if mandate.status != 1 else 'mandate_expired')
                    entries.append(entry)
                    continue
                module, owner, pool = vault_facts(rpc, mandate, block)
                refusal = eligible(mandate, owner, module, self.deployment, block.timestamp)
                if refusal is not None:
                    entry.update(act=False, reason=refusal)
                    entries.append(entry)
                    continue
                position = uniswap.position(position_ref(self.chain, pool, mandate.token_id), block)
                if pool.dex == DEX_V4:
                    anchor = position.pool.sqrt_price_x96  # what the publisher signs at this block
                    if not mandate.triggered(anchor):
                        entry.update(act=False, reason='trigger_not_reached')
                        entries.append(entry)
                        continue
                    if publisher is None:
                        entry.update(act=True, reason='triggered_keyless')
                        entries.append(entry)
                        continue
                    signed = publisher.observe(pool, block, max_age_seconds=parameters.max_observation_age_seconds)
                    evidence, deadline = signed.evidence(), signed.observation.valid_until
                else:
                    window, evidence = twap_exit_evidence(parameters, self.exit_twap_seconds)
                    anchor = twap_price(rpc, self.deployment, pool, window, block)
                    deadline = block.timestamp + self.deadline_seconds
                exit_plan = plan_exit(mandate, pool, position, anchor, evidence, deadline)
                if exit_plan is None:
                    entry.update(act=False, reason='trigger_not_reached')
                elif self.executor is None:
                    entry.update(act=True, reason='triggered_keyless')
                else:
                    gas_limit, estimate = self.executor.presimulate(self.deployment.auto_exit, exit_plan.calldata, block)
                    entry.update(act=True, reason='triggered', gasEstimate=estimate, subject=mandate.hash,
                                 simulation='passed',
                                 plan={'calldata': exit_plan.calldata, 'deadline': deadline, 'gas': gas_limit})
            except CallReverted as error:
                entry.update(act=False, reason=str(error), simulation='reverted')
            except DataError as error:
                entry.update(act=False, reason=str(error))
            entries.append(entry)
        return entries


# --------------------------------------------------------------------- CLI
def build(config, *, keys=True, endpoint_options=None):
    """The service from its configuration; keys only when they are needed."""
    from automation_keys import keystore_key
    chain = config.chain
    deployment = load_deployment(config.deployment_file, chain)
    if keys and (config.operator.address != deployment.operator or config.publisher.address != deployment.publisher):
        raise DataError('v2_signer_not_in_deployment')
    options = endpoint_options or {}
    if 'providerFile' in config.rpc:
        endpoints = configured_endpoints(chain, provider_config=load_config(config.rpc['providerFile']), **options)
    else:
        endpoints = configured_endpoints(chain, chain_rpc_config=load_chain_rpc_config(config.rpc['chainRpcFile']),
                                         **options)
    follower = HeadFollower(endpoints, max_age_seconds=config.head_max_age_seconds, shared_path=config.head_file)
    executor = publisher = None
    if keys:
        operator = OperatorKey(keystore_key(config.operator.keystore_file, config.operator.credential,
                                            config.operator.address))
        publisher = ObservationSigner(keystore_key(config.publisher.keystore_file, config.publisher.credential,
                                                   config.publisher.address),
                                      chain_id=chain.chainId, anchor=deployment.price_anchor)
        journal = Journal(config.journal_file, chain.chainId, operator.address)
        executor = ChainExecutor(chain, deployment, OperatorRpc(endpoints), operator, journal, config.gas)
    return ChainAutomation(chain=chain, deployment=deployment, endpoints=endpoints, follower=follower,
                           planner=config.planner, observations=config.observations,
                           price_references=config.price_references,
                           earnings_window_seconds=config.earnings_window_seconds, twap_seconds=config.twap_seconds,
                           exit_twap_seconds=config.exit_twap_seconds, deadline_seconds=config.deadline_seconds,
                           executor=executor, publisher_signer=publisher, auto_exit=config.auto_exit,
                           vault_gas_ceiling_wei=config.vault_gas_ceiling_wei,
                           vault_gas_ceilings_wei=config.vault_gas_ceilings_wei, waiting_file=config.waiting_file)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Domino V2 automation of one chain')
    parser.add_argument('--config', required=True)
    parser.add_argument('operation', choices=('status', 'plan', 'run-once', 'serve', 'intents', 'acknowledge'))
    parser.add_argument('--intent', help='acknowledge: the intent id an operator looked at')
    args = parser.parse_args(argv)
    try:
        config = load_automation_config(args.config)
        if args.operation in ('intents', 'acknowledge'):
            journal = Journal(config.journal_file, config.chain.chainId, config.operator.address)
            try:
                if args.operation == 'acknowledge':
                    if not args.intent or not re.fullmatch(r'0x[0-9a-f]{64}', args.intent):
                        raise DataError('v2_intent_not_found')
                    journal.acknowledge(args.intent)
                report = {'chain': config.chain.key, 'unresolved': journal.unresolved(),
                          'attention': journal.attention()}
            finally:
                journal.close()
            print(json.dumps(report, sort_keys=True))
            return 0
        keyed = args.operation in ('run-once', 'serve')
        service = build(config, keys=keyed)
        if args.operation == 'status':
            head = service.follower.head()
            rpc = service.endpoints.read_rpc(anchor=head.block, batch_reads=True)
            service.deployment.verify_code(rpc, head.block)
            index = ChainIndexRpc(service.endpoints, batch_reads=True)
            defaults = config.vault_defaults
            report = {'chain': config.chain.key, 'block': head.block.number, 'deployment': 'verified',
                      'vaults': len(service.discovery.scan(index, head.block)), 'calls': service.endpoints.calls(),
                      'vaultDefaults': {'mode': defaults.mode, 'policy': defaults.policy, 'limits': defaults.limits,
                                        'startPaused': defaults.start_paused, 'ownerMaxima': defaults.owner_maxima,
                                        'exitMaxSlippageBps': defaults.exit_max_slippage_bps},
                      'dailyCapWei': str(config.gas.daily_cap_wei),
                      'vaultGasCeilingWei': None if config.vault_gas_ceiling_wei is None
                      else str(config.vault_gas_ceiling_wei)}
        elif args.operation == 'plan':
            report = service.run_once(act=False)
        elif args.operation == 'run-once':
            report = service.run_once(act=True)
        else:
            while True:
                try:
                    print(json.dumps(service.run_once(act=True), sort_keys=True), flush=True)
                except DataError as error:
                    print(json.dumps({'error': str(error)}), flush=True)
                time.sleep(config.pass_seconds)
    except DataError as error:
        print(json.dumps({'error': str(error)}))
        return 1
    print(json.dumps(report, sort_keys=True, default=str))
    return 0


if __name__ == '__main__':
    sys.exit(main())
