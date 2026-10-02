"""Measure the compound sandwich on a forked Robinhood pool (review D-01, D-02).

Forks Robinhood Chain (4663) at a selected head block, deploys the V4 stack from the
built artifacts, gives a synthetic owner a root position in a real pool through
DominoSetup, earns it fees with round-trip swaps, and then runs one compound per
scenario from one common snapshot:

  honest            observation at the true spot, compound, nobody interferes;
  pre-observation   the attacker moves spot by X, an honest publisher reads the
                    moved pool, the operator compounds at it, the attacker
                    restores - the residual no on-chain band can see;
  post-observation  observation at the true spot, then the attacker moves spot
                    by X before the compound - what the anchor refuses, and
                    what it lets through inside maxPriceImpactBps;
  ceiling           post-observation inside the impact limit, with the plan's
                    maxAdded set to the honest amounts - what D-02 refuses.

Receipts supply actual swap proceeds, consumed amounts and gas products.
Valuation uses the stated fixed-price/range formulas; quote differences are
estimates and are never substituted for receipts. Balances, impersonation,
ArbSys emulation and snapshots are child-only controls. This Anvil experiment
does not reproduce Nitro's EVM opcode overrides or qualify live execution.

The fork's upstream is either the read gateway over the configured historical
source, or a loopback JSON-RPC port (an SSH-forwarded self-hosted node), so no
provider credential ever enters this process or its output.
"""
import argparse
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from eth_abi import decode, encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deposit_fork import DepositFork
from discovery import CHAIN_ID, PUBLIC_RPC_URL, POOL_MANAGER, POSITION_MANAGER, STATE_VIEW, ZERO, DataError
from fork_read_gateway import ForkReadGateway
from local_config import load_config
from rpc_config import DEFAULT_RPC_HOSTS, PUBLIC_RPC_HOST, configured_history_rpc_source
import execution_models as m
import execution_v4 as v
import general_compound_receipts as g
from qualify_deposit_fork import POOLS, WETH

ROOT = Path(__file__).resolve().parents[1]
Q96 = 2**96
KEY_TYPE = '(address,address,uint24,int24,address)'
POLICY_TYPE = '(uint16,uint16,uint16,uint32,uint8,uint64,bool)'
LIMITS_TYPE = '(uint64,uint32,uint16,uint16,uint128,uint32,uint32)'
INIT_TYPE = '(uint256,bytes32,address,address,address,bool,' + POLICY_TYPE + ',' + LIMITS_TYPE + ')'
MINT_TYPE = '(bytes32,int24,int24,uint128,uint128,uint128,uint160,uint160,uint160,uint64)'
OBSERVATION_TYPE = '(bytes32,uint64,bytes32,uint64,uint64,uint160)'
FORK_ARTIFACTS = {name: 'src/' + name + '.sol' for name in (
    'DominoVaultFactoryV4', 'DominoVaultReadHelper', 'DominoRoutingHelperV4',
    'DominoPriceGuardV4', 'DominoExecutionEngineV4', 'DominoVaultV4', 'DominoSetup')}
FORK_ARTIFACTS.update({'MockNitroArbSys': 'test/shared/NitroTestSetup.sol',
    'OfficialV4SwapDriver': 'test/reference/OfficialV4Fixture.sol'})

# Synthetic experiment accounts, impersonated on the child only.
DEPLOYER = '0x00000000000000000000000000000000000d0d0d'
OWNER = '0x000000000000000000000000000000000000dead'
OPERATOR = '0x0000000000000000000000000000000000000b0b'
PUBLISHER = '0x000000000000000000000000000000000000f00d'
ATTACKER = '0x000000000000000000000000000000000000bad0'
GUARDIAN = '0x0000000000000000000000000000000000006a2d'
RECIPIENT = '0x0000000000000000000000000000000000000fee'

# The vault's own limits: 1% price impact against the anchor, 400 bps Domino service fee.
MAX_PRICE_IMPACT_BPS = 100
SERVICE_FEE_BPS = 400
GUARD_BAND_BPS = 2000

ERRORS = {keccak(name.encode())[:4].hex(): name for name in (
    'InvalidPrice()', 'InvalidAmount()', 'InvalidExecution()', 'InvalidObservation()',
    'InsufficientReserve()', 'InvalidRoute()', 'PermissionUnavailable()', 'UnexpectedCallback()',
    'InvalidPosition()', 'InvalidSetup()', 'Unauthorized()')}


def calldata(signature, types=(), values=()):
    return '0x' + (keccak(signature.encode())[:4] + encode(types, values)).hex()


def sqrt_at_tick(tick):
    return int(round(math.sqrt(1.0001 ** tick) * Q96))


def amounts_for_liquidity(liquidity, price, lower, upper):
    price = min(max(price, lower), upper)
    amount0 = liquidity * (upper - price) * Q96 // (price * upper) if price < upper else 0
    amount1 = liquidity * (price - lower) // Q96 if price > lower else 0
    return amount0, amount1


def liquidity_for_amounts(amount0, amount1, price, lower, upper):
    price = min(max(price, lower), upper)
    from0 = amount0 * price * upper // ((upper - price) * Q96) if price < upper else 2**128
    from1 = amount1 * Q96 // (price - lower) if price > lower else 2**128
    return min(from0, from1)


def quote_value(amount0, amount1, price):
    """Both currencies in units of currency1 at a sqrt price."""
    return amount1 + amount0 * price * price // 2**192


def load_fork_artifact(root, source, name):
    """Reject stale/unpinned builds and bind exact source bytes to loaded code."""
    try:
        target = FORK_ARTIFACTS[name]
        if Path(target).name != source:
            raise DataError('fork_artifact_target_mismatch')
        contracts = (Path(root) / 'contracts').resolve()
        raw = (contracts / 'out' / source / (name + '.json')).read_bytes()
        artifact = json.loads(raw)
        metadata = artifact['metadata']
        settings = metadata['settings']
        if (metadata['compiler']['version'] != '0.8.26+commit.8a97fa7a'
                or settings.get('compilationTarget') != {target: name}
                or settings.get('optimizer') != {'enabled': True, 'runs': 200}
                or settings.get('viaIR') is not True or settings.get('evmVersion') != 'cancun'
                or settings.get('metadata', {}).get('bytecodeHash') != 'none'):
            raise DataError('fork_artifact_profile_mismatch')
        sources = {}
        if target not in metadata['sources']:
            raise DataError('fork_artifact_source_missing')
        for path, entry in metadata['sources'].items():
            if (not path.startswith(('src/', 'test/', 'lib/')) or '\\' in path
                    or any(part in ('', '.', '..') for part in path.split('/'))):
                raise DataError('fork_artifact_unsafe_source')
            resolved = (contracts / path).resolve()
            if not resolved.is_relative_to(contracts):
                raise DataError('fork_artifact_unsafe_source')
            data = resolved.read_bytes()
            digest = '0x' + keccak(data).hex()
            if digest != entry['keccak256']:
                raise DataError('fork_artifact_source_changed')
            sources[path] = {'sha256': hashlib.sha256(data).hexdigest(), 'keccak256': digest}
        hashes = {}
        for key, label in (('bytecode', 'creationCodeHash'), ('deployedBytecode', 'runtimeTemplateHash')):
            code = artifact[key]['object']
            if not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+', code) or artifact[key].get('linkReferences'):
                raise DataError('fork_artifact_invalid_bytecode')
            hashes[label] = '0x' + keccak(bytes.fromhex(code[2:])).hex()
        provenance = {'artifactSha256': hashlib.sha256(raw).hexdigest(), **hashes,
            'compilationTarget': target, 'compilerVersion': metadata['compiler']['version'],
            'sourceManifestSha256': hashlib.sha256(json.dumps(sources, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
            'sourcePaths': sorted(sources)}
        return artifact, provenance, sources
    except DataError:
        raise
    except (AttributeError, KeyError, TypeError, ValueError, OSError):
        raise DataError('fork_artifact_invalid_or_unavailable') from None


def receipt_metrics(receipt, engine, vault, intent_id, currencies):
    """Decode only the known engine's identity-bound economic events.

    This is experimental receipt extraction, not the production canonical
    verifier. Missing successful swap events are a harness error, never zero.
    """
    added = {currency: 0 for currency in currencies}
    conversions = []
    for log in receipt.get('logs', []):
        if log.get('address', '').lower() != engine.lower():
            continue
        topics = log.get('topics', [])
        if not topics or topics[0] not in (v.APPLIED, v.CONVERTED):
            continue
        if (len(topics) != 4 or topics[1].lower() != '0x' + encode(['address'], [vault]).hex()
                or topics[2].lower() != intent_id.lower()):
            raise DataError('fork_receipt_identity_mismatch')
        types = (['address', 'uint256', g.AMOUNTS_TYPE] if topics[0] == v.APPLIED else
                 ['address', 'address', 'uint128', 'uint128', g.AMOUNTS_TYPE, 'uint128', 'uint128'])
        raw = bytes.fromhex(log['data'][2:])
        values = decode(types, raw)
        if encode(types, values) != raw:
            raise DataError('fork_receipt_noncanonical_data')
        if topics[0] == v.APPLIED:
            currency, _, amounts = values
            if currency not in added:
                raise DataError('fork_receipt_currency_mismatch')
            added[currency] += amounts[6]
        else:
            cin, cout, amount_in, amount_out, amounts, before, after = values
            if (cin not in added or cout not in added or cin == cout or amount_in != amounts[6]
                    or after != before + amount_out or conversions):
                raise DataError('fork_receipt_conversion_mismatch')
            conversions.append({'status': 'measured', 'sourceId': topics[3], 'currencyIn': cin,
                'currencyOut': cout, 'amountInRaw': str(amount_in), 'amountOutRaw': str(amount_out),
                'serviceFeeInputRaw': str(amounts[5]), 'receiptLogIndex': int(log['logIndex'], 16)})
    return tuple(added[c] for c in currencies), conversions


def scenario_metrics(scenario, controls, reference):
    """Same-recipe controls and separately labelled actual/estimated swap metrics."""
    name = 'swap-honest' if scenario.get('swap') else 'honest'
    control = controls.get(name)
    result = {'controlScenario': name}
    if scenario.get('outcome') == 'harness-error' or scenario.get('vaultValueAfterQuote') is None:
        result['comparisonStatus'] = 'unavailable'
    elif not control or control.get('outcome') != 'executed':
        result['comparisonStatus'] = 'unavailable'
    else:
        result['comparisonStatus'] = 'computed_from_recorded_balances'
        result['vaultValueDeltaVersusControlQuote'] = str(int(scenario['vaultValueAfterQuote']) - int(control['vaultValueAfterQuote']))
    if scenario.get('attackerPnlQuote') is not None:
        result['attackerPoolCostQuote'] = str(-int(scenario['attackerPnlQuote']))
    if scenario.get('swap') and scenario.get('outcome') == 'executed':
        swap = scenario.get('swapExecution', {})
        amount = int(scenario['swapIn0'])
        reference_quote = quote_value(amount, 0, reference)
        result['swapReferenceQuote'] = str(reference_quote)
        result['preSwapSpotQuoteDifference'] = str(reference_quote - quote_value(amount, 0, int(scenario['sqrtPriceAtCompound'])))
        result['preSwapSpotQuoteDifferenceBasis'] = 'quote_estimate_before_pool_fee_and_swap_impact'
        if swap.get('status') == 'measured':
            if int(swap['amountInRaw']) != amount:
                raise DataError('fork_receipt_input_mismatch')
            result['swapShortfallStatus'] = 'measured_output_vs_reference_quote'
            result['swapShortfallQuote'] = str(reference_quote - int(swap['amountOutRaw']))
            result['swapShortfallBasis'] = 'includes_pool_fee_and_swap_impact; not_pure_manipulation_loss'
            control_swap = (control or {}).get('swapExecution', {})
            if control_swap.get('status') == 'measured' and control_swap['amountInRaw'] == swap['amountInRaw']:
                result['swapOutputDeltaVersusControlQuote'] = str(int(swap['amountOutRaw']) - int(control_swap['amountOutRaw']))
            else:
                result['swapOutputComparisonStatus'] = 'unavailable_or_different_input_amount'
        else:
            result['swapShortfallStatus'] = 'unavailable_missing_conversion_receipt'
    return result


def correct_historical_report(report):
    """Preserve original files; derived revisions never invent missing outputs."""
    report = json.loads(json.dumps(report))
    controls = {row['scenario']: row for row in report['scenarios'] if row['scenario'] in ('honest', 'swap-honest')}
    for row in report['scenarios']:
        old = {key: row.pop(key) for key in ('lossVersusHonestQuote', 'lossFractionOfCompounded', 'breakevenCompoundedQuote', 'attackerCostQuote') if key in row}
        if old:
            row['supersededMetrics'] = old
        if row.get('swap') and row.get('outcome') == 'executed' and 'swapExecution' not in row:
            row['swapExecution'] = {'status': 'unavailable', 'reason': 'historical_receipt_not_recorded'}
        row.update(scenario_metrics(row, controls, int(report['referenceSqrtPrice'])))
    report['evidenceVersion'] = 2
    report['historicalCorrection'] = {'actualSwapOutputsRecovered': False,
        'basis': 'same-recipe controls recomputed from original recorded after-values; missing receipts remain unavailable',
        'beforeValueCaveat': 'legacy before-values queried accrued fees after the scenario; not an initial-value measurement',
        'addedAmountsCaveat': 'legacy added amounts are formula estimates at pre-swap spot, not receipt amounts'}
    report['economicScope'] = 'single-action point samples; no profitable-attack threshold or per-vault safety bound; exposure aggregates across a shared pool/window'
    return report


class ReportCheckpoint:
    """Reserve a new evidence path and atomically retain every completed row."""
    def __init__(self, path, report):
        self.path, self.report = Path(path), report

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Never overwrite a historical report, even if source setup later fails.
        with self.path.open('x') as handle:
            json.dump(self.report, handle, indent=1)
        self.report['runStatus'] = 'running'
        self.save()
        return self

    def save(self):
        self.report['updatedAt'] = int(time.time())
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=self.path.parent,
                    prefix=self.path.name + '.', suffix='.tmp', delete=False) as handle:
                temporary = Path(handle.name)
                json.dump(self.report, handle, indent=1)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def __exit__(self, kind, error, traceback):
        self.report['finishedAt'] = int(time.time())
        if error is not None:
            self.report['runStatus'] = 'interrupted' if isinstance(error, KeyboardInterrupt) else 'harness-error'
            # Fixed exception type avoids serializing provider URLs/diagnostics.
            self.report['runErrorType'] = type(error).__name__
        else:
            incomplete = any(row.get('outcome') == 'harness-error' for row in self.report['scenarios'])
            incomplete |= self.report.get('lifecycle', {}).get('outcome') == 'harness-error'
            self.report['runStatus'] = 'partial' if incomplete else 'complete'
        self.save()
        return False


class ScenarioBudget:
    """Check a scenario deadline/request budget before every child RPC.

    DepositFork bounds an already-started RPC to 20 s. Snapshot cleanup uses
    the underlying fork once so expiration cannot prevent rollback.
    """
    def __init__(self, fork, seconds, max_requests=2000):
        self.fork, self.url = fork, fork.url
        self.deadline = time.monotonic() + seconds
        self.max_requests, self.count = max_requests, 0

    def check(self):
        if time.monotonic() >= self.deadline:
            raise DataError('fork_scenario_time_budget')
        if self.count >= self.max_requests:
            raise DataError('fork_scenario_request_budget')

    def request(self, method, params=()):
        self.check()
        self.count += 1
        return self.fork.request(method, params)

    def mine(self):
        return self.request('anvil_mine', ['0x1', '0x0'])


class Loopback:
    """A loopback JSON-RPC source (an SSH-forwarded node) in the gateway's place."""
    def __init__(self, url):
        parsed = urlsplit(url)
        if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.port is None:
            raise DataError('fork_gateway_required')
        self.url = url

    def request(self, method, params=()):
        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': list(params)}).encode()
        request = urllib.request.Request(self.url, body, {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
        if 'error' in result:
            raise DataError('fork_upstream_rpc_error')
        return result['result']

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Experiment:
    def __init__(self, fork, pool_name, band_bps, scenario_seconds=180):
        self.fork = fork
        self.pool_id, self.key = POOLS[pool_name]
        self.band_bps = band_bps
        self.currencies = (self.key.currency0, self.key.currency1)
        self.native = self.key.currency0 == ZERO
        # One sale size per move: every scenario starts from the same snapshot.
        self.move_amounts = {}
        self.move_failures = {}
        self.scenario_seconds = scenario_seconds
        self.artifact_provenance = {'basis': 'validated_compiler_metadata_and_exact_local_source_bytes',
            'artifacts': {}, 'sources': {}}

    # ---------------------------------------------------------------- rpc
    def call(self, target, signature, outputs, types=(), values=()):
        data = self.fork.request('eth_call', [{'to': target, 'data': calldata(signature, types, values),
            'gas': hex(5_000_000)}, 'latest'])
        return decode(outputs, bytes.fromhex(data[2:]))

    def send(self, sender, target, data='0x', value=0, gas=10_000_000):
        """Like DepositFork.send, with a receipt wait sized for swaps that cross
        many ticks of a real pool - each fresh tick is an upstream fetch."""
        tx = {'from': sender, 'data': data, 'gas': hex(gas), 'value': hex(value)}
        if target is not None:
            tx['to'] = target
        if self.fork.request('eth_chainId') != hex(CHAIN_ID):
            raise DataError('fork_chain_mismatch')
        digest = self.fork.request('eth_sendTransaction', [tx])
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            receipt = self.fork.request('eth_getTransactionReceipt', [digest])
            if receipt is not None:
                return receipt
            time.sleep(.1)
        raise DataError('fork_receipt_unavailable')

    def must(self, sender, target, data='0x', value=0, what='transaction'):
        try:
            receipt = self.send(sender, target, data, value)
        except DataError as error:
            # Anvil refuses a transaction whose estimation reverts; say why.
            if str(error) != 'fork_rpc_rejected':
                raise
            raise DataError(f'fork_step_failed:{what}:{self.revert_reason(sender, target, data, value)}') from None
        if receipt['status'] != '0x1':
            raise DataError(f'fork_step_failed:{what}:{self.revert_reason(sender, target, data, value)}')
        return receipt

    def revert_reason(self, sender, target, data, value=0):
        """Replay a failed transaction as a call to read its revert selector."""
        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_call', 'params': [
            {'from': sender, 'to': target, 'data': data, 'value': hex(value), 'gas': hex(10_000_000)}, 'latest']}).encode()
        request = urllib.request.Request(self.fork.url, body, {'Content-Type': 'application/json'})
        timeout = 30
        if isinstance(self.fork, ScenarioBudget):
            self.fork.check()
            timeout = min(timeout, max(.001, self.fork.deadline - time.monotonic()))
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = json.load(response)
        except OSError:
            return 'unknown'
        error = result.get('error') or {}
        payload = error.get('data') if isinstance(error, dict) else None
        if isinstance(payload, dict):
            payload = payload.get('data')
        if isinstance(payload, str) and payload.startswith('0x') and len(payload) >= 10:
            return ERRORS.get(payload[2:10], 'selector:' + payload[2:10])
        return 'reverted:' + str(error.get('message', ''))[:60]

    def balance(self, currency, account):
        if currency == ZERO:
            return int(self.fork.request('eth_getBalance', [account, 'latest']), 16)
        return self.call(currency, 'balanceOf(address)', ['uint256'], ['address'], [account])[0]

    def spot(self):
        return self.call(STATE_VIEW, 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'],
            ['bytes32'], [bytes.fromhex(self.pool_id[2:])])[:2]

    def artifact(self, source, name):
        root = Path(os.environ.get('DOMINO_COMPOUND_EVM_ROOT', ROOT))
        artifact, provenance, sources = load_fork_artifact(root, source, name)
        recorded = self.artifact_provenance['artifacts'].get(name)
        if recorded and recorded['artifactSha256'] != provenance['artifactSha256']:
            raise DataError('fork_artifact_changed_during_run')
        for path, digest in sources.items():
            prior = self.artifact_provenance['sources'].get(path)
            if prior and prior != digest:
                raise DataError('fork_artifact_sources_changed_during_run')
        self.artifact_provenance['artifacts'].setdefault(name, provenance)
        self.artifact_provenance['sources'].update(sources)
        return artifact

    def emulate_arbsys(self):
        """Explicit child-only precompile stand-in, never a live Nitro proof."""
        code = self.artifact('NitroTestSetup.sol', 'MockNitroArbSys')['deployedBytecode']['object']
        address = '0x0000000000000000000000000000000000000064'
        self.fork.request('anvil_setCode', [address, code])
        actual = self.fork.request('eth_getCode', [address, 'latest'])
        if actual != code:
            raise DataError('fork_arbsys_emulation_failed')
        self.artifact_provenance['artifacts']['MockNitroArbSys'].update({'installedAt': address,
            'installedRuntimeCodeHash': '0x' + keccak(bytes.fromhex(actual[2:])).hex()})
        return {'mode': 'explicit_anvil_arbsys_emulation', 'address': address,
            'codeHash': '0x' + keccak(bytes.fromhex(code[2:])).hex(),
            'nitroOpcodeQualification': False,
            'scope': 'ArbSys uses child NUMBER/BLOCKHASH; does not reproduce Nitro opcode overrides'}

    def deploy(self, sender, source, name, types=(), values=()):
        artifact = self.artifact(source, name)
        initcode = artifact['bytecode']['object'] + encode(types, values).hex()
        receipt = self.must(sender, None, initcode, what='deploy:' + name)
        address = receipt['contractAddress'].lower()
        runtime = self.fork.request('eth_getCode', [address, 'latest'])
        if not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+', runtime):
            raise DataError('fork_deployed_code_missing')
        self.artifact_provenance['artifacts'][name].update({'deployedAt': address,
            'initcodeHash': '0x' + keccak(bytes.fromhex(initcode[2:])).hex(),
            'deployedRuntimeCodeHash': '0x' + keccak(bytes.fromhex(runtime[2:])).hex()})
        return address

    def fund_native(self, account, amount):
        self.fork.request('anvil_setBalance', [account, hex(amount)])

    def fund(self, currency, account, amount):
        """Real tokens on the child: wrap for WETH, borrow from the pool manager otherwise."""
        if currency == ZERO:
            self.fund_native(account, amount + 10**21)
        elif currency == WETH:
            self.fund_native(account, amount + 10**21)
            self.must(account, WETH, calldata('deposit()'), amount, 'wrap')
        else:
            held = self.balance(currency, POOL_MANAGER)
            if amount * 10 > held:
                raise DataError('fork_seed_balance_unavailable')
            self.fund_native(POOL_MANAGER, 10**18)
            self.fork.request('anvil_impersonateAccount', [POOL_MANAGER])
            self.must(POOL_MANAGER, currency, calldata('transfer(address,uint256)', ['address', 'uint256'],
                [account, amount]), what='seed:' + currency)
            self.fork.request('anvil_stopImpersonatingAccount', [POOL_MANAGER])

    # -------------------------------------------------------------- stack
    def deploy_stack(self):
        for account in (DEPLOYER, OWNER, OPERATOR, PUBLISHER, ATTACKER):
            self.fund_native(account, 10**22)
            self.fork.request('anvil_impersonateAccount', [account])
        self.fork.fresh_block()
        d = self.deploy
        self.factory = d(DEPLOYER, 'DominoVaultFactoryV4.sol', 'DominoVaultFactoryV4', ['address'] * 4,
            [POOL_MANAGER, POSITION_MANAGER, STATE_VIEW, RECIPIENT])
        self.helper = d(DEPLOYER, 'DominoVaultReadHelper.sol', 'DominoVaultReadHelper', ['address'] * 2,
            [POSITION_MANAGER, STATE_VIEW])
        self.routing = d(DEPLOYER, 'DominoRoutingHelperV4.sol', 'DominoRoutingHelperV4')
        self.guard = d(DEPLOYER, 'DominoPriceGuardV4.sol', 'DominoPriceGuardV4', ['address', 'address', 'uint256', 'address'],
            [PUBLISHER, STATE_VIEW, self.band_bps, GUARDIAN])
        self.engine = d(DEPLOYER, 'DominoExecutionEngineV4.sol', 'DominoExecutionEngineV4', ['address'] * 4,
            [self.factory, self.helper, self.routing, self.guard])
        self.implementation = d(DEPLOYER, 'DominoVaultV4.sol', 'DominoVaultV4', ['address'] * 7,
            [self.factory, POOL_MANAGER, POSITION_MANAGER, STATE_VIEW, RECIPIENT, self.helper, self.engine])
        self.setup = d(DEPLOYER, 'DominoSetup.sol', 'DominoSetup',
            ['address', 'address', 'address', 'address', 'uint16', 'uint64'],
            [POOL_MANAGER, POSITION_MANAGER, STATE_VIEW, RECIPIENT, 65, 1])
        self.must(DEPLOYER, self.factory, calldata('finalizeImplementation(address)', ['address'],
            [self.implementation]), what='finalize')
        self.driver = d(ATTACKER, 'OfficialV4Fixture.sol', 'OfficialV4SwapDriver', ['address'], [POOL_MANAGER])

    def key_tuple(self):
        return (self.key.currency0, self.key.currency1, self.key.fee_pips, self.key.tick_spacing, self.key.hooks)

    def open_root(self, amount0, amount1, width_ticks):
        """A real root position through DominoSetup, around the current tick."""
        price, tick = self.spot()
        spacing = self.key.tick_spacing
        lower = (tick - width_ticks) // spacing * spacing
        upper = -((-(tick + width_ticks)) // spacing) * spacing
        for currency, amount in zip(self.currencies, (amount0, amount1)):
            self.fund(currency, OWNER, amount)
            if currency != ZERO:
                self.must(OWNER, currency, calldata('approve(address,uint256)', ['address', 'uint256'],
                    [self.setup, amount]), what='approve')
        operation = self.call(self.setup, 'nextOperationId(address)', ['bytes32'], ['address'], [OWNER])[0]
        self.must(OWNER, self.setup, calldata('open(bytes32,' + KEY_TYPE + ',uint128,uint128)',
            ['bytes32', KEY_TYPE, 'uint128', 'uint128'], [operation, self.key_tuple(), amount0, amount1]),
            amount0 if self.native else 0, 'open')
        lower_price, upper_price = sqrt_at_tick(lower), sqrt_at_tick(upper)
        liquidity = liquidity_for_amounts(amount0 * 98 // 100, amount1 * 98 // 100, price, lower_price, upper_price)
        token = self.call(POSITION_MANAGER, 'nextTokenId()', ['uint256'])[0]
        # DominoSetup bounds a deadline to 1200 s past the block it executes in.
        head = self.fork.request('eth_getBlockByNumber', ['latest', False])
        deadline = int(head['timestamp'], 16) + 600
        plan = (operation, lower, upper, liquidity, amount0, amount1, price * 95 // 100, price * 105 // 100, 0, deadline)
        self.must(OWNER, self.setup, calldata('mint(' + MINT_TYPE + ')', [MINT_TYPE], [plan]), what='mint')
        held = self.call(POSITION_MANAGER, 'getPositionLiquidity(uint256)', ['uint128'], ['uint256'], [token])[0]
        if held != liquidity:
            raise DataError('fork_root_liquidity_mismatch')
        self.token, self.lower, self.upper = token, lower, upper
        self.lower_price, self.upper_price = lower_price, upper_price
        return {'tokenId': token, 'tickLower': lower, 'tickUpper': upper, 'liquidity': str(liquidity),
            'tickAtOpen': tick, 'sqrtPriceAtOpen': str(price)}

    def create_vault(self):
        self.vault = self.call(self.factory, 'predictVault(address,uint256)', ['address'],
            ['address', 'uint256'], [OWNER, 0])[0]
        self.must(OWNER, POSITION_MANAGER, calldata('approve(address,uint256)', ['address', 'uint256'],
            [self.vault, self.token]), what='approve root')
        params = (self.token, bytes.fromhex(self.pool_id[2:]), *self.currencies, OPERATOR, True,
            (SERVICE_FEE_BPS, 500, 1000, 1, 4, 1, False), (1, 5000, 100, MAX_PRICE_IMPACT_BPS, 10**18, 120, 3600))
        self.must(OWNER, self.factory, calldata('createVault(' + INIT_TYPE + ',uint256)', [INIT_TYPE, 'uint256'],
            [params, 0]), what='createVault')
        self.sequence = self.call(self.vault, 'sequenceIdentityHash()', ['bytes32'])[0]
        if not self.call(self.vault, 'rootPermissionValid()', ['bool'])[0]:
            raise DataError('fork_vault_not_armed')

    # -------------------------------------------------------------- swaps
    def swap(self, zero_for_one, amount):
        """The attacker's driver swaps exact input against the real pool."""
        return self.must(ATTACKER, self.driver, calldata('swap(' + KEY_TYPE + ',bool,uint256)',
            [KEY_TYPE, 'bool', 'uint256'], [self.key_tuple(), zero_for_one, amount]), what='swap')

    def fund_driver(self, amount0, amount1):
        for currency, amount in zip(self.currencies, (amount0, amount1)):
            if amount == 0:
                continue
            if currency == ZERO:
                self.fund_native(self.driver, amount)
            else:
                self.fund(currency, ATTACKER, amount)
                self.must(ATTACKER, currency, calldata('transfer(address,uint256)', ['address', 'uint256'],
                    [self.driver, amount]), what='fund driver')

    def driver_balances(self):
        return tuple(self.balance(c, self.driver) for c in self.currencies)

    def earn_fees(self, rounds, leg):
        """Round trips of `leg` currency0 each way; the vault's share of the pool's fee."""
        for _ in range(rounds):
            self.swap(True, leg)
            received = self.balance(self.key.currency1, self.driver)
            self.swap(False, received)

    def restore(self, checkpoint):
        fork = self.fork.fork if isinstance(self.fork, ScenarioBudget) else self.fork
        if fork.request('evm_revert', [checkpoint]) is not True:
            raise DataError('fork_snapshot_restore_failed')

    def price_after(self, zero_for_one, amount):
        checkpoint = self.fork.request('evm_snapshot')
        try:
            self.swap(zero_for_one, amount)
            return self.spot()[0]
        finally:
            self.restore(checkpoint)

    def amount_for_move(self, move_bps):
        """Bisect the currency0 sale that lowers currency0's price by move_bps."""
        if move_bps in self.move_amounts:
            return self.move_amounts[move_bps]
        if move_bps in self.move_failures:
            raise DataError('fork_move_unavailable_cached:' + self.move_failures[move_bps])
        try:
            start = self.spot()[0]
            target = int(start * math.sqrt(1 - move_bps / 10000))
            low, high = 0, 10**18
            while self.price_after(True, high) > target:
                high *= 4
                if high > 10**26:
                    raise DataError('fork_move_unreachable')
            for _ in range(16):
                mid = (low + high) // 2
                if self.price_after(True, mid) > target:
                    low = mid
                else:
                    high = mid
            self.move_amounts[move_bps] = high
            return high
        except Exception as error:  # sizing is identical across the common-snapshot families
            self.move_failures[move_bps] = type(error).__name__ + ':' + str(error)[:120]
            raise

    def amount_for_rise(self, target, cap):
        """Bisect the currency1 sale, up to `cap`, that lifts currency0's sqrt price to at least `target`."""
        low, high = 0, min(10**9, cap)
        while self.price_after(False, high) < target:
            if high >= cap:
                raise DataError('fork_rise_unreachable_within_budget')
            high = min(high * 4, cap)
        for _ in range(16):
            mid = (low + high) // 2
            if self.price_after(False, mid) < target:
                low = mid
            else:
                high = mid
        return high

    def successor_range(self, parent):
        """A successor geometry validateSuccessor accepts: floor 2% under the
        parent's ceiling, ceiling the first aligned tick at least 50% above it."""
        spacing = self.key.tick_spacing
        lower = (self.upper - 200) // spacing * spacing
        upper = -((-(self.upper + 4000)) // spacing) * spacing
        for _ in range(60):
            data = calldata('validateSuccessor(' + g.POSITION_TYPE + ',int24,int24,int24,bool,uint16,uint32)',
                [g.POSITION_TYPE, 'int24', 'int24', 'int24', 'bool', 'uint16', 'uint32'],
                [parent, lower, upper, spacing, False, 1000, 5000])
            try:
                self.fork.request('eth_call', [{'to': self.routing, 'data': data, 'gas': hex(2_000_000)}, 'latest'])
                return lower, upper
            except DataError:
                upper += spacing
        raise DataError('fork_no_successor_geometry')

    def owner_exit(self, what, data, sender=OWNER):
        receipt = self.send(sender, self.vault, data)
        step = {'step': what, 'outcome': 'executed' if receipt['status'] == '0x1' else 'refused',
            'gasUsed': int(receipt['gasUsed'], 16)}
        if receipt['status'] != '0x1':
            step['reason'] = self.revert_reason(sender, self.vault, data)
        return step

    def lifecycle(self):
        """A successor minted through the real engine once the root is near its
        ceiling, then every owner exit, all against the real position manager."""
        checkpoint = self.fork.request('evm_snapshot')
        out = {'steps': []}
        try:
            return self._lifecycle(out)
        except Exception as error:  # noqa: BLE001 - keep the steps that did run
            out['outcome'] = 'harness-error'
            out['reason'] = type(error).__name__ + ': ' + str(error)[:160]
            return out
        finally:
            self.restore(checkpoint)

    def _lifecycle(self, out):
        if True:
            parent = self.call(self.vault, 'position(uint256)', [g.POSITION_TYPE], ['uint256'], [self.token])[0]
            ceiling = sqrt_at_tick(self.upper)
            target = int(ceiling * math.sqrt(0.97))
            if self.spot()[0] < target:
                # The lift is paid in currency1, funded before any probe and
                # capped at a tenth of what the pool manager holds; every unit
                # sold comes straight back to the pool.
                budget = self.balance(self.currencies[1], POOL_MANAGER) // 10 if self.currencies[1] != ZERO else 10**24
                self.fund_driver(0, budget)
                bought = self.amount_for_rise(target, budget)
                self.swap(False, bought)
                out['currency1SoldToLift'] = str(bought)
            out['sqrtPriceNearCeiling'] = str(self.spot()[0])
            lower, upper = self.successor_range(parent)
            out['successorTicks'] = [lower, upper]
            range_prices = (sqrt_at_tick(lower), sqrt_at_tick(upper))
            increase, fees = self.feasible_increase(range_prices)
            out['accruedFees'] = [str(f) for f in fees]
            out['successorLiquidity'] = str(increase)
            child = self.call(POSITION_MANAGER, 'nextTokenId()', ['uint256'])[0]
            plan, _ = self.plan(increase, (2**127 - 1, 2**127 - 1), action=3, ticks=(lower, upper), range_prices=range_prices)
            step = self.owner_exit('mint successor (execute, MINT)', plan.calldata(), OPERATOR)
            out['steps'].append(step)
            if step['outcome'] == 'executed':
                member = self.call(self.vault, 'position(uint256)', [g.POSITION_TYPE], ['uint256'], [child])[0]
                out['child'] = {'tokenId': child, 'active': member[1], 'liquidity':
                    str(self.call(POSITION_MANAGER, 'getPositionLiquidity(uint256)', ['uint128'], ['uint256'], [child])[0]),
                    'ownedByVault': self.call(POSITION_MANAGER, 'ownerOf(uint256)', ['address'], ['uint256'], [child])[0] == self.vault}
                out['steps'].append(self.owner_exit('withdrawChildPosition', calldata('withdrawChildPosition(uint256)', ['uint256'], [child])))
                out['childOwnedByOwnerAfterExit'] = self.call(POSITION_MANAGER, 'ownerOf(uint256)', ['address'], ['uint256'], [child])[0] == OWNER
            # Fee reserves left by the compound, both currencies, exact and to the owner.
            for i, currency in enumerate(self.currencies):
                source = parent[9 + i]
                balance = self.call(self.vault, 'feeBalance(bytes32,address)', ['(uint128,uint128)'], ['bytes32', 'address'], [source, currency])[0]
                if balance[0] or balance[1]:
                    before = self.balance(currency, OWNER)
                    step = self.owner_exit(f'withdrawFeeReserves currency{i}', calldata('withdrawFeeReserves(bytes32,address,uint128,uint128)',
                        ['bytes32', 'address', 'uint128', 'uint128'], [source, currency, balance[0], balance[1]]))
                    step['paidRaw'] = str(self.balance(currency, OWNER) - before); step['reserveRaw'] = [str(balance[0]), str(balance[1])]
                    out['steps'].append(step)
            # A donation, then its recovery: the ledger never sees it, the owner gets it back.
            donation = 10**15
            if self.currencies[0] == ZERO:
                self.fund_native(self.vault, self.balance(ZERO, self.vault) + donation)
            else:
                self.fund(self.currencies[0], ATTACKER, donation)
                self.must(ATTACKER, self.currencies[0], calldata('transfer(address,uint256)', ['address', 'uint256'],
                    [self.vault, donation]), what='donate')
            before = self.balance(self.currencies[0], OWNER)
            step = self.owner_exit('recoverUntrackedCurrency currency0', calldata('recoverUntrackedCurrency(address,uint256)', ['address', 'uint256'], [self.currencies[0], donation]))
            step['recoveredRaw'] = str(self.balance(self.currencies[0], OWNER) - before)
            out['steps'].append(step)
            out['accountedAfter'] = [str(self.call(self.vault, 'accountedCurrency(address)', ['uint256'], ['address'], [c])[0]) for c in self.currencies]
            out['outcome'] = 'completed'
            return out

    # --------------------------------------------------------- compounds
    def accrued(self):
        point = self.call(self.helper, 'readCheckpoint(bytes32,bytes32,uint256,int24,int24)', [g.CHECKPOINT_TYPE],
            ['bytes32', 'bytes32', 'uint256', 'int24', 'int24'],
            [bytes.fromhex(self.pool_id[2:]), self.sequence, self.token, self.lower, self.upper])[0]
        return self.call(self.helper, 'accrued(' + g.CHECKPOINT_TYPE + ')', ['uint128', 'uint128'],
            [g.CHECKPOINT_TYPE], [point])

    def publish(self, authority):
        price = self.spot()[0]
        point = (bytes.fromhex(self.pool_id[2:]), int(authority.observedAtBlock),
            bytes.fromhex(authority.observedBlockHash[2:]), int(authority.observedAtTimestamp),
            int(authority.deadline), price)
        receipt = self.must(PUBLISHER, self.guard, calldata('publish(' + OBSERVATION_TYPE + ')',
            [OBSERVATION_TYPE], [point]), what='publish')
        return receipt['logs'][0]['topics'][1], price

    def plan(self, liquidity_increase, max_added, swap_in=0, action=0, ticks=(0, 0), range_prices=None):
        lower_price, upper_price = range_prices or (self.lower_price, self.upper_price)
        self.fork.mine()
        source = self.fork.request('eth_getBlockByNumber', ['latest', False])
        member = self.call(self.vault, 'position(uint256)', [g.POSITION_TYPE], ['uint256'], [self.token])[0]
        checkpoint = self.call(self.vault, 'checkpoint(uint256)', [g.CHECKPOINT_TYPE], ['uint256'], [self.token])[0]
        timestamp = int(source['timestamp'], 16)
        spot = self.spot()[0]
        authority = g.CompoundPlan(intentId='0x' + keccak(encode(['address', 'uint256', 'uint64'],
            [self.vault, int(source['number'], 16), int(time.time_ns() % 2**64)])).hex(),
            tokenId=str(self.token), positionIdentity='0x' + member[8].hex(), checkpointId='0x' + checkpoint[6].hex(),
            policyVersion='1', limitsVersion='1',
            stateNonce=str(self.call(self.vault, 'stateNonce()', ['uint64'])[0]),
            authorityGeneration=str(self.call(self.vault, 'authorityGeneration()', ['uint64'])[0]),
            observedAtBlock=str(int(source['number'], 16)), observedBlockHash=source['hash'],
            observedAtTimestamp=str(timestamp), deadline=str(timestamp + 100), liquidityIncrease=str(liquidity_increase),
            # The wire refuses both floors at zero, not one: a move that leaves
            # the range makes the add single-sided, and an operator can zero the
            # empty side's floor and compound anyway. That is the worst case, so
            # the floors follow where the spot sits against the range.
            maxOriginal0='0', maxOriginal1='0', maxCharged0='0', maxCharged1='0',
            minAdded0='0' if spot >= upper_price else '1', minAdded1='0' if spot <= lower_price else '1',
            minSqrtPriceX96=str(2**80), maxSqrtPriceX96=str(2**110))
        budgets = [v.FeeBudget(sourceId='0x' + member[9 + i].hex(), currency=self.currencies[i],
            maxOriginal=str(2**128 - 1), maxCharged='0', minOriginal='0', minCharged='0') for i in (0, 1)]
        if swap_in:
            # The swap's output is booked as the input source's charged balance
            # in the output currency, and the add may spend it from there.
            budgets.append(v.FeeBudget(sourceId='0x' + member[9].hex(), currency=self.currencies[1],
                maxOriginal='0', maxCharged=str(2**128 - 1), minOriginal='0', minCharged='0'))
        budgets = tuple(sorted(budgets, key=lambda b: (b.sourceId, b.currency)))
        observation, anchor = self.publish(authority)
        if swap_in:
            # The swap family: part of the currency0 fee is sold for currency1
            # at the anchor, with the minimum output the vault's own slippage
            # limit allows - the recipe of the executor's swap tests.
            minimum = self.call(self.routing, 'minimumOutput(uint128,uint160,bool,uint16)', ['uint256'],
                ['uint128', 'uint160', 'bool', 'uint16'], [swap_in, anchor, True, 100])[0]
            if minimum == 0:
                raise DataError('fork_swap_too_small_to_bound')
            swap = v.SwapPlan(sourceId='0x' + member[9].hex(), currencyIn=self.currencies[0], amountIn=str(swap_in),
                maxOriginal=str(2**128 - 1), maxCharged='0', minAmountOut=str(minimum),
                sqrtPriceLimitX96=authority.minSqrtPriceX96, priceObservationId=observation)
        else:
            swap = v.SwapPlan(sourceId=m.ZERO_HASH, currencyIn=ZERO, amountIn='0', maxOriginal='0', maxCharged='0',
                minAmountOut='0', sqrtPriceLimitX96='0', priceObservationId=observation)
        # GENERAL carries the swap; NET is the optimised path with none.
        plan = v.Plan(authority=authority, action=action, destinationTokenId='0' if action == 3 else str(self.token),
            tickLower=ticks[0], tickUpper=ticks[1],
            maxAdded0=str(max_added[0]), maxAdded1=str(max_added[1]),
            collect=(v.PositionRef(tokenId=str(self.token), positionIdentity=authority.positionIdentity,
                checkpointId=authority.checkpointId),), budgets=budgets, swap=swap)
        return plan, anchor

    def feasible_increase(self, range_prices=None):
        """The liquidity the accrued fees fund at the current spot, after the service fee."""
        lower_price, upper_price = range_prices or (self.lower_price, self.upper_price)
        fee0, fee1 = self.accrued()
        net0, net1 = fee0 * (10000 - SERVICE_FEE_BPS) // 10000, fee1 * (10000 - SERVICE_FEE_BPS) // 10000
        price = self.spot()[0]
        # The operator's slack: 90% of what the fees fund at the observed spot,
        # so a composition shift inside the impact band still fits.
        return liquidity_for_amounts(net0, net1, price, lower_price, upper_price) * 90 // 100, (fee0, fee1)

    def vault_state(self):
        liquidity = self.call(POSITION_MANAGER, 'getPositionLiquidity(uint256)', ['uint128'], ['uint256'], [self.token])[0]
        reserves = tuple(self.call(self.vault, 'accountedCurrency(address)', ['uint256'], ['address'], [c])[0]
            for c in self.currencies)
        return liquidity, reserves

    def vault_value(self, reference, liquidity, reserves):
        """Position at the reference price, plus reserves, plus fees still uncollected."""
        amount0, amount1 = amounts_for_liquidity(liquidity, reference, self.lower_price, self.upper_price)
        fee0, fee1 = self.accrued()
        return quote_value(amount0 + reserves[0] + fee0, amount1 + reserves[1] + fee1, reference)

    def run_scenario(self, name, move_bps, pre_observation, ceiling, reference, honest_added, swap=False):
        if move_bps in self.move_failures:
            raise DataError('fork_move_unavailable_cached:' + self.move_failures[move_bps])
        original = self.fork
        self.fork = ScenarioBudget(original, self.scenario_seconds)
        try:
            return self._run_scenario(name, move_bps, pre_observation, ceiling, reference, honest_added, swap)
        finally:
            self.fork = original

    def _run_scenario(self, name, move_bps, pre_observation, ceiling, reference, honest_added, swap=False):
        checkpoint = self.fork.request('evm_snapshot')
        try:
            result = {'scenario': name, 'moveBps': move_bps, 'preObservation': pre_observation, 'ceiling': ceiling,
                'swap': swap}
            attacker_before = self.driver_balances()
            attacker_gas_before = self.balance(ZERO, ATTACKER)
            liquidity_before, reserves_before = self.vault_state()
            value_before = self.vault_value(reference, liquidity_before, reserves_before)
            result['sqrtPriceBefore'] = str(self.spot()[0])
            if move_bps and pre_observation:
                sold = self.amount_for_move(move_bps)
                self.swap(True, sold)
                result['attackerSold0'] = str(sold)
            increase, fees = self.feasible_increase()
            result['accruedFees'] = [str(f) for f in fees]
            swap_in = 0
            if swap:
                # Half of the net currency0 fee is sold; the add is kept small so
                # it stays feasible whatever the swap returns.
                swap_in = fees[0] * (10000 - SERVICE_FEE_BPS) // 10000 // 2
                increase = increase // 4
                result['swapIn0'] = str(swap_in)
            result['liquidityIncrease'] = str(increase)
            max_added = (2**127 - 1, 2**127 - 1)
            if ceiling:
                max_added = tuple(a + a * 50 // 10000 + 1 for a in honest_added)
                result['maxAdded'] = [str(a) for a in max_added]
            plan, anchor = self.plan(increase, max_added, swap_in)
            result['anchorSqrtPrice'] = str(anchor)
            if move_bps and not pre_observation:
                sold = self.amount_for_move(move_bps)
                self.swap(True, sold)
                result['attackerSold0'] = str(sold)
            result['sqrtPriceAtCompound'] = str(self.spot()[0])
            receipt = self.send(OPERATOR, self.vault, plan.calldata())
            result['gasUsed'] = int(receipt['gasUsed'], 16)
            result['gasPayer'] = OPERATOR
            result['gasFunding'] = 'synthetic_native_balance_set_on_child; no_asset_sale'
            if receipt.get('effectiveGasPrice') is not None:
                result['effectiveGasPriceWei'] = str(int(receipt['effectiveGasPrice'], 16))
                result['receiptGasProductWei'] = str(result['gasUsed'] * int(result['effectiveGasPriceWei']))
            added = (0, 0)
            if receipt['status'] == '0x1':
                result['outcome'] = 'executed'
                added, conversions = receipt_metrics(receipt, self.engine, self.vault, plan.authority.intentId, self.currencies)
                if bool(conversions) != bool(swap_in):
                    raise DataError('fork_conversion_receipt_missing_or_unexpected')
                if conversions:
                    conversion = conversions[0]
                    if ((conversion['currencyIn'], conversion['currencyOut'], int(conversion['amountInRaw'])) != (*self.currencies, swap_in)
                            or conversion['sourceId'] != plan.swap.sourceId):
                        raise DataError('fork_conversion_route_mismatch')
                    result['swapExecution'] = conversion
            else:
                result['outcome'] = 'refused'
                result['reason'] = self.revert_reason(OPERATOR, self.vault, plan.calldata())
                if swap:
                    result['swapExecution'] = {'status': 'not_executed', 'reason': 'compound_reverted'}
            if move_bps:
                received = self.balance(self.key.currency1, self.driver) - attacker_before[1]
                if received > 0:
                    self.swap(False, received)
                result['sqrtPriceAfterRestore'] = str(self.spot()[0])
            liquidity_after, reserves_after = self.vault_state()
            result['liquidityAdded'] = str(liquidity_after - liquidity_before)
            result['reservesAfter'] = [str(r) for r in reserves_after]
            result['addedAmounts'] = [str(a) for a in added]
            result['addedAmountsBasis'] = 'BudgetApplied_receipt_events'
            value_after = self.vault_value(reference, liquidity_after, reserves_after)
            result['vaultValueBeforeQuote'] = str(value_before)
            result['vaultValueAfterQuote'] = str(value_after)
            attacker_after = self.driver_balances()
            result['attackerPnlQuote'] = str(quote_value(*attacker_after, reference) - quote_value(*attacker_before, reference))
            result['attackerBalanceDelta'] = [str(a - b) for a, b in zip(attacker_after, attacker_before)]
            result['attackerGasCostWei'] = str(attacker_gas_before - self.balance(ZERO, ATTACKER))
            result['attackerPnlBasis'] = 'driver_token_balances_at_reference_quote; excludes_attacker_gas'
            return result, added
        finally:
            self.restore(checkpoint)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    source_options = parser.add_mutually_exclusive_group()
    source_options.add_argument('--rpc-config', type=Path, help='explicit private providers.json')
    source_options.add_argument('--source-url', help='loopback JSON-RPC source, e.g. an SSH-forwarded node; replaces the gateway')
    source_options.add_argument('--public-rpc', action='store_true', help='official public endpoint only; does not load local/private configuration')
    parser.add_argument('--recompute', type=Path, help='derive corrected metrics from historical JSON offline; never fills absent receipt outputs')
    parser.add_argument('--pool', choices=sorted(POOLS), default='weth-usdg')
    parser.add_argument('--block', help='fork block number (hex or decimal); default: the head block')
    parser.add_argument('--band', type=int, default=GUARD_BAND_BPS, help='price guard band, bps of sqrt price')
    parser.add_argument('--moves', default='50,90,110,500,2000', help='attacker price moves to measure, bps')
    parser.add_argument('--scenario-seconds', type=int, default=180, help='per-scenario RPC budget, 1..600 seconds; in-flight RPC and rollback remain bounded separately')
    parser.add_argument('--rounds', type=int, default=40, help='fee-earning round trips before the compounds')
    parser.add_argument('--root0', default='2000000000000000000', help='root deposit of currency0, raw')
    parser.add_argument('--root1', default='8000000000', help='root deposit of currency1, raw')
    parser.add_argument('--width', type=int, default=200, help='root range half-width, ticks')
    parser.add_argument('--lifecycle', action='store_true', help='also mint a successor near the ceiling and run every owner exit')
    parser.add_argument('--hardfork', choices=('cancun', 'prague'), default='cancun',
                        help='child EVM rules; prague makes EIP-7702 designators execute, as on Nitro')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args(argv)
    if args.recompute:
        report = correct_historical_report(json.loads(args.recompute.read_text()))
        report['historicalCorrection']['sourceFile'] = args.recompute.name
        with open(args.output, 'x') as handle:
            json.dump(report, handle, indent=1)
        return 0
    moves = [int(x) for x in args.moves.split(',') if x]
    if not 1 <= args.scenario_seconds <= 600 or any(not 0 < move < 10000 for move in moves):
        parser.error('scenario seconds must be 1..600 and moves must be 1..9999 bps')
    report = {'tool': 'qualify_execution_fork', 'chainId': CHAIN_ID, 'pool': args.pool,
        'poolId': POOLS[args.pool][0], 'guardBandBps': args.band, 'maxPriceImpactBps': MAX_PRICE_IMPACT_BPS,
        'serviceFeeBps': SERVICE_FEE_BPS, 'planSlackPercent': 10, 'rootWidthTicks': args.width,
        'startedAt': int(time.time()), 'scenarios': [], 'evidenceVersion': 2,
        'requestedMovesBps': moves, 'scenarioBudgetSeconds': args.scenario_seconds,
        'valuation': 'formula estimates in currency1 units at pre-scenario price; position amounts from liquidity/range plus measured reserves and accrued fees',
        'economicScope': 'single-action point samples; no profitable-attack threshold or per-vault safety bound; exposure aggregates across a shared pool/window',
        'controls': 'synthetic accounts impersonated on the child; balances set locally; WETH wrapped; other tokens moved from the pool manager'}
    with ReportCheckpoint(args.output, report) as evidence:
        if args.source_url:
            source = Loopback(args.source_url)
            report['upstream'] = 'loopback source'
        elif args.public_rpc:
            source = ForkReadGateway(PUBLIC_RPC_URL, allowed_hosts=(PUBLIC_RPC_HOST,), max_requests=40_000,
                                     total_seconds=1800)
            report['upstream'] = urlsplit(PUBLIC_RPC_URL).hostname
        else:
            config = load_config(args.rpc_config) if args.rpc_config else load_config()
            history = configured_history_rpc_source(config)
            hosts = config.get('rpcAllowedHosts', DEFAULT_RPC_HOSTS)
            source = ForkReadGateway(history, allowed_hosts=hosts)
            report['upstream'] = urlsplit(history[0] if isinstance(history, tuple) else history).hostname
        with source as gateway:
            if gateway.request('eth_chainId') != hex(CHAIN_ID):
                raise DataError('fork_source_chain_mismatch')
            # A pruned Nitro node keeps state for roughly its block-age window, so
            # the fork starts at the head, as the deposit qualification does, and
            # the whole session has to finish inside that window.
            tag = 'latest' if args.block is None else hex(int(args.block, 0))
            block = gateway.request('eth_getBlockByNumber', [tag, False])
            report['source'] = {k: block[k] for k in ('number', 'hash', 'timestamp')}
            with DepositFork(gateway, block=block, total_seconds=1800, max_requests=40_000, hardfork=args.hardfork) as fork:
                report['anvilVersion'] = fork.version
                report['hardfork'] = args.hardfork
                x = Experiment(fork, args.pool, args.band, args.scenario_seconds)
                report['chainSemantics'] = x.emulate_arbsys()
                x.deploy_stack()
                if set(x.artifact_provenance['artifacts']) != set(FORK_ARTIFACTS):
                    raise DataError('fork_artifact_provenance_incomplete')
                report['artifactProvenance'] = x.artifact_provenance
                report['stack'] = {k: getattr(x, k) for k in ('factory', 'helper', 'routing', 'guard', 'engine',
                    'implementation', 'setup', 'driver')}
                report['root'] = x.open_root(int(args.root0), int(args.root1), args.width)
                x.create_vault()
                report['vault'] = x.vault
                print(json.dumps({'stage': 'vault', 'vault': x.vault, 'token': x.token}), flush=True)
                # The attacker's war chest, currency0 only: every unit of currency1
                # it holds afterwards came out of the pool. Funded before any swap,
                # including the sizing probes.
                x.fund_driver(10**24, 0)
                # Fee generation: legs sized to a small impact, so the price ends near where it began.
                probe = x.amount_for_move(20)
                price_start = x.spot()[0]
                x.earn_fees(args.rounds, probe)
                fees = x.accrued()
                report['fees'] = {'rounds': args.rounds, 'legCurrency0': str(probe), 'accrued': [str(f) for f in fees],
                    'sqrtPriceBefore': str(price_start), 'sqrtPriceAfter': str(x.spot()[0])}
                print(json.dumps({'stage': 'fees', **report['fees']}), flush=True)
                if fees[0] == 0 and fees[1] == 0:
                    raise DataError('fork_no_fees_accrued')
                reference = x.spot()[0]
                report['referenceSqrtPrice'] = str(reference)
                honest, honest_added = x.run_scenario('honest', 0, False, False, reference, (0, 0))
                report['scenarios'].append(honest)
                evidence.save()
                # Gas on the L2 is in every receipt; the L1 data component is what the
                # live node's NodeInterface estimates for this calldata, a point sample.
                try:
                    sample_plan, _ = x.plan(int(honest['liquidityIncrease']), (2**127 - 1, 2**127 - 1))
                    data = sample_plan.calldata()
                    estimate = gateway.request('eth_call', [{'to': '0x00000000000000000000000000000000000000c8', 'from': OPERATOR,
                        'data': calldata('gasEstimateL1Component(address,bool,bytes)', ['address', 'bool', 'bytes'],
                            [x.vault, False, bytes.fromhex(data[2:])])}, 'latest'])
                    l1_gas, base_fee, l1_base_fee = decode(['uint64', 'uint256', 'uint256'], bytes.fromhex(estimate[2:]))
                    report['gas'] = {'compoundCalldataBytes': len(data) // 2 - 1, 'l2GasUsedHonest': honest.get('gasUsed'),
                        'l1ComponentGas': int(l1_gas), 'l2BaseFeeWei': str(base_fee), 'l1BaseFeeEstimateWei': str(l1_base_fee),
                        'source': 'NodeInterface.gasEstimateL1Component on the live node'}
                except Exception as error:  # noqa: BLE001
                    report['gas'] = {'unavailable': type(error).__name__}
                print(json.dumps({'stage': 'scenario', **{k: honest[k] for k in ('scenario', 'outcome', 'liquidityAdded')}}), flush=True)
                compounded = quote_value(*honest_added, reference)
                report['honestCompoundedQuote'] = str(compounded)
                # The swap recipe's own control, before any manipulation.
                try:
                    control, _ = x.run_scenario('swap-honest', 0, False, False, reference, honest_added, True)
                except Exception as error:  # noqa: BLE001
                    control = {'scenario': 'swap-honest', 'moveBps': 0, 'swap': True, 'outcome': 'harness-error',
                        'reason': type(error).__name__ + ': ' + str(error)[:120]}
                report['scenarios'].append(control)
                controls = {'honest': honest, 'swap-honest': control}
                for row in (honest, control):
                    row.update(scenario_metrics(row, controls, reference))
                print(json.dumps({'stage': 'scenario', **{k: control.get(k) for k in ('scenario', 'outcome', 'reason', 'liquidityAdded')}}), flush=True)
                families = (('pre-observation', True, False, False), ('post-observation', False, False, False),
                    ('ceiling', False, True, False), ('swap-pre-observation', True, False, True),
                    ('swap-post-observation', False, False, True))
                evidence.save()
                for move in moves:
                    for name, pre, ceiling, swap in families:
                        if ceiling and move >= MAX_PRICE_IMPACT_BPS:
                            continue
                        try:
                            result, _ = x.run_scenario(name, move, pre, ceiling, reference, honest_added, swap)
                        except Exception as error:  # noqa: BLE001 - one scenario's failure is a result, not the run's
                            result = {'scenario': name, 'moveBps': move, 'swap': swap, 'outcome': 'harness-error',
                                'reason': type(error).__name__ + ': ' + str(error)[:120]}
                        result.update(scenario_metrics(result, controls, reference))
                        report['scenarios'].append(result)
                        evidence.save()
                        print(json.dumps({'stage': 'scenario', **{k: result.get(k) for k in
                            ('scenario', 'moveBps', 'outcome', 'reason', 'vaultValueDeltaVersusControlQuote', 'attackerPoolCostQuote',
                             'swapShortfallStatus', 'swapShortfallQuote')}}), flush=True)
                if args.lifecycle:
                    try:
                        report['lifecycle'] = x.lifecycle()
                    except Exception as error:  # noqa: BLE001
                        report['lifecycle'] = {'outcome': 'harness-error', 'reason': type(error).__name__ + ': ' + str(error)[:160]}
                    print(json.dumps({'stage': 'lifecycle', **{k: v for k, v in report['lifecycle'].items() if k != 'steps'},
                        'steps': [(s['step'], s['outcome'], s.get('reason')) for s in report['lifecycle'].get('steps', [])]}), flush=True)
                evidence.save()
    print(json.dumps({'stage': 'done', 'output': str(args.output), 'scenarios': len(report['scenarios'])}), flush=True)
    return 0 if report['runStatus'] == 'complete' else 1


if __name__ == '__main__':
    sys.exit(main())
