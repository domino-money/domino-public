"""Explicit local-fork experiment against deployed code; never production admission.

The synthetic in-memory admission assertions deliberately isolate protocol
mechanics from token qualification. They are test inputs, NOT verified claims
about these tokens. WETH/USDG are proxies and remain excluded by live policy.
No manifest is written, no production service is enabled, and all mutations
flow through a child node with an independently read-only upstream gateway.
"""
import argparse
from collections import Counter
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.parse import urlsplit

from eth_abi import decode
from eth_hash.auto import keccak

from deposit_fork import DepositFork
from deposit_models import DepositError
from deposit_prepare import DirectDepositPreparer, DEPLOYMENTS, PERMIT2, calldata
from deposit_receipt import ReceiptReconciler, receipt_summary, validate_issued_artifact
from lp_mint_inspection import inspect_mint
from discovery import CHAIN_ID, POOL_MANAGER, POSITION_MANAGER, STATE_VIEW, ZERO, PoolKey, DataError
from fork_read_gateway import ForkReadGateway, ForkReadError
from local_config import load_config
import uniswap_config
from reviewed_admission_config import load_candidate_with_digest
from uniswap_position import UniswapPosition

# Public experiment fixtures; not a production token or pool allowlist.
OWNER = '0x000000000000000000000000000000000000dead'
WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
POOLS = {
    'weth-usdg': ('0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6',
                  PoolKey(WETH, USDG, 200, 4, ZERO)),
    'eth-usdg': ('0x3b0cbf0603ecc67b5fc9bb4fbb6ac9e08d3b2f406b63d1662a36063a7fe5e866',
                 PoolKey(ZERO, USDG, 87, 1, ZERO)),
}
CASES = ('weth-input', 'usdg-input', 'native-input', 'native-only', 'usdg-only')
SAFE_CODES = frozenset({
    'fork_qualification_failed', 'fork_source_chain_mismatch', 'fork_source_changed',
    'fork_gateway_required', 'invalid_fork_configuration', 'fork_start_failed',
    'fork_chain_mismatch', 'fork_source_mismatch', 'fork_node_identity_mismatch',
    'fork_not_running', 'fork_request_budget', 'fork_response_budget', 'fork_rpc_rejected',
    'fork_receipt_unavailable', 'fork_method_rejected', 'fork_transport_identity',
    'fork_mine_budget', 'fork_redirect_rejected', 'fork_composition_budget',
    'fork_weth_bootstrap_failed', 'fork_usdg_bootstrap_failed', 'fork_seed_balance_unavailable',
    'fork_test_admission_only', 'fork_missing_admission_control_failed',
    'fork_deposit_budget_conservation', 'fork_receipt_balance_mismatch',
    'fork_checkpoint_restore_failed', 'fork_deadline_control_failed', 'fork_reorg_control_failed',
    'fork_step_not_confirmed', 'fork_step_limit', 'invalid_qualification_arguments',
})


def safe_error(error):
    if isinstance(error, (DepositError, ForkReadError)):
        return error.code
    return str(error) if isinstance(error, DataError) and str(error) in SAFE_CODES else 'fork_qualification_failed'


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise DataError('invalid_qualification_arguments')


def _call(fork, target, signature, inputs=(), values=(), outputs=()):
    data = fork.request('eth_call', [{'to': target, 'data': calldata(signature, inputs, values),
        'gas': hex(500_000)}, 'latest'])
    return decode(outputs, bytes.fromhex(data[2:]))


def balances(fork, key):
    return [int(fork.request('eth_getBalance', [OWNER, 'latest']), 16) if token == ZERO else
        _call(fork, token, 'balanceOf(address)', ['address'], [OWNER], ['uint256'])[0]
        for token in (key.currency0, key.currency1)]


def _bootstrap(fork):
    fork.request('anvil_setBalance', [OWNER, hex(100 * 10**18)])
    fork.request('anvil_impersonateAccount', [OWNER])
    fork.fresh_block()
    weth = fork.send({'from': OWNER, 'to': WETH, 'data': calldata('deposit()', [], []),
        'value': hex(10**17), 'gas': hex(500_000)})
    if weth['status'] != '0x1':
        raise DataError('fork_weth_bootstrap_failed')
    # Move existing forked USDG through its actual transfer implementation. Do
    # not edit token storage/code. The source is a public protocol address,
    # impersonated only on this child; this changes local reserve balances.
    available = _call(fork, USDG, 'balanceOf(address)', ['address'], [POOL_MANAGER], ['uint256'])[0]
    if available < 100 * 10**6:
        raise DataError('fork_seed_balance_unavailable')
    fork.request('anvil_setBalance', [POOL_MANAGER, hex(10**18)])
    fork.request('anvil_impersonateAccount', [POOL_MANAGER])
    usdg = fork.send({'from': POOL_MANAGER, 'to': USDG, 'gas': hex(500_000),
        'data': calldata('transfer(address,uint256)', ['address', 'uint256'], [OWNER, 100 * 10**6])})
    fork.request('anvil_stopImpersonatingAccount', [POOL_MANAGER])
    if usdg['status'] != '0x1':
        raise DataError('fork_usdg_bootstrap_failed')
    return {'syntheticNativeBalanceRaw': str(100 * 10**18),
        'wrappedLocallyRaw': str(10**17), 'usdgTransferredLocallyRaw': str(100 * 10**6),
        'seedSource': POOL_MANAGER, 'seedSourceNativeBalanceOverriddenRaw': str(10**18),
        'tokenCodeOrStorageOverridden': False}


def test_admission(fork, key):
    """Non-exportable fixture. All behavior flags below are synthetic assertions.

    This is analogous to mocked review input in unit tests. It must never be
    confused with a review record: neither proxy is nonupgradeable on mainnet.
    Only this experiment's locally overridden chain is allowed to consume it.
    """
    if not isinstance(fork, DepositFork) or not fork._verified:
        raise DataError('fork_test_admission_only')
    now = int(time.time())
    def code_hash(target):
        code = fork.request('eth_getCode', [target, 'latest'])
        return '0x' + keccak(bytes.fromhex(code[2:])).hex()
    manifest = {'schemaVersion': 1, 'policyVersion': 'direct_existing_pool_v1',
        'reviewedAt': now - 5, 'expiresAt': now + 1200, 'nativeEnabled': True,
        'reviewReference': 'SYNTHETIC FORK TEST ONLY - NO TOKEN QUALIFICATION',
        'deployments': {label: code_hash(target) for label, target in DEPLOYMENTS.items()},
        'tokens': [{'address': token, 'codeHash': code_hash(token),
                    'reviewReference': 'SYNTHETIC FLAGS; PROXY NOT ADMITTED IN PRODUCTION',
                    'standardTransfer': True, 'nonRebasing': True, 'nonUpgradeable': True,
                    'approvalReturn': 'bool'} for token in (key.currency0, key.currency1) if token != ZERO]}
    manifest['manifestId'] = hashlib.sha256(json.dumps(manifest, sort_keys=True,
        separators=(',', ':')).encode()).hexdigest()
    return manifest


def selection(fork, name):
    native = name.startswith('native')
    pool_id, key = POOLS['eth-usdg' if native else 'weth-usdg']
    PoolKey.checked(tuple(asdict(key).values()), pool_id)
    _, tick, _, _ = _call(fork, STATE_VIEW, 'getSlot0(bytes32)', ['bytes32'],
        [bytes.fromhex(pool_id[2:])], ['uint160', 'int24', 'uint24', 'uint24'])
    # This selects canonical experimental ticks, not a deposit/composition math
    # implementation. Uniswap still computes liquidity and dependent amounts.
    center = tick // key.tick_spacing * key.tick_spacing
    distance = (2000 // key.tick_spacing) * key.tick_spacing
    lower, upper = center-distance, center+distance
    if name == 'native-only':
        lower, upper = center+distance, center+2*distance
    if name == 'usdg-only':
        lower, upper = center-2*distance, center-distance
    independent = USDG if name.startswith('usdg') else key.currency0
    result = {'chainId': CHAIN_ID, 'poolId': pool_id, 'poolKey': asdict(key),
        'independentToken': independent, 'amountRaw': '2000000' if independent == USDG else str(10**15),
        'tickLower': lower, 'tickUpper': upper, 'slippageBps': 50,
        'budget0Raw': '0' if name == 'usdg-only' else str(5 * 10**15),
        'budget1Raw': '0' if name == 'native-only' else str(10 * 10**6),
        'nativeGasReserveRaw': str(10**16), 'maxGasLimitRaw': '3000000',
        'maxFeePerGasRaw': str(10**10), 'maxPriorityFeePerGasRaw': '0'}
    return result, key


def mint_controls(fork, selected, artifact, token_guard=None):
    """Exercise a real expired mint and then discard that alternate fork history."""
    checkpoint = fork.request('evm_snapshot')
    fork.request('evm_setNextBlockTimestamp', [artifact['preparedDeadline'] + 1])
    fork.mine()
    reverted = fork.send_artifact(artifact)
    fork.mine(2)
    observation = ReceiptReconciler(fork.deposit_rpc(), token_guard=token_guard).reconcile(OWNER, selected, artifact,
        known_hashes=[reverted['transactionHash']])
    if reverted['status'] != '0x0' or observation['state'] != 'reverted':
        raise DataError('fork_deadline_control_failed')
    if fork.request('evm_revert', [checkpoint]) is not True:
        raise DataError('fork_checkpoint_restore_failed')
    reorg = ReceiptReconciler(fork.deposit_rpc(), token_guard=token_guard).reconcile(OWNER, selected, artifact,
        known_hashes=[reverted['transactionHash']], previous_receipt=observation['receipt'])
    if reorg['state'] != 'reorged' or not reorg['reorgDetected']:
        raise DataError('fork_reorg_control_failed')
    return {'expiredMintRejectedOnChain': True, 'revertedReceiptVerified': True,
        'orphanedReceiptDetectedAfterLocalRestore': True,
        'alternateLocalHistoryDiscarded': True}


def run_case(fork, api_key, name, *, reviewed_manifest=None):
    fork.fresh_block()
    selected, key = selection(fork, name)
    provider_calls, composition_observations = Counter(), []
    from discovery import json_http
    def lp_transport(url, body, **options):
        provider_calls['lpCreate'] += 1
        if provider_calls['lpCreate'] > 16:
            raise DataError('fork_composition_budget')
        payload = json_http(url, body, **options)
        observation = {'calldataIdentityValidated': False}
        try:
            bounds = inspect_mint(payload['create'], owner=OWNER, pool_key=key,
                pool_id=selected['poolId'], tick_lower=selected['tickLower'],
                tick_upper=selected['tickUpper'], deadline=body['deadline'])
            nominal = [payload[f'token{i}']['amount'] for i in (0, 1)]
            if all(isinstance(v, str) and re.fullmatch(r'(0|[1-9][0-9]{0,77})', v) for v in nominal):
                observation = {'calldataIdentityValidated': True,
                    'providerNominalAmountsRaw': nominal, 'encodedBounds': bounds}
        except Exception:
            pass  # The production adapter still independently rejects it.
        composition_observations.append(observation)
        return payload
    position = UniswapPosition(api_key, transport=lp_transport)
    try:
        DirectDepositPreparer(position, fork.deposit_rpc).prepare(OWNER, selected)
    except DepositError as error:
        if error.code != 'deposit_admission_required':
            raise
    else:
        raise DataError('fork_missing_admission_control_failed')
    manifest = reviewed_manifest or test_admission(fork, key)
    preparer = DirectDepositPreparer(position, fork.deposit_rpc, admission=manifest)
    def synthetic_guard(**values):
        # Original protocol-only experiment, explicitly overriding semantic
        # admission. The reviewed-profile mode never uses this callback.
        return {'status': 'matched', 'reviewId': 'f'*64, 'upgradeable': False}
    token_guard = preparer.token_guard if reviewed_manifest else synthetic_guard
    steps, controls = [], None
    for _ in range(12):
        fork.fresh_block()
        try:
            artifact = preparer.prepare(OWNER, selected)
        except DepositError as error:
            return {'name': name, 'status': 'failed', 'reason': safe_error(error),
                'selection': selected, 'steps': steps, 'providerCalls': dict(provider_calls),
                'compositionObservations': composition_observations,
                'executionEligible': False, 'testAdmissionOverride': reviewed_manifest is None,
                'missingAdmissionDenied': True}
        validate_issued_artifact(OWNER, selected, artifact)
        preparer.revalidate(OWNER, selected, artifact)
        if artifact['kind'] == 'mint':
            controls = mint_controls(fork, selected, artifact, token_guard)
        before = balances(fork, key)
        native_before = int(fork.request('eth_getBalance', [OWNER, 'latest']), 16)
        receipt = fork.send_artifact(artifact)
        fork.mine(2)  # Artificial local finalization; not Nitro settlement time.
        result = ReceiptReconciler(fork.deposit_rpc(), token_guard=token_guard).reconcile(OWNER, selected, artifact,
            known_hashes=[receipt['transactionHash']])
        after = balances(fork, key)
        native_after = int(fork.request('eth_getBalance', [OWNER, 'latest']), 16)
        gas_fee = int(receipt['gasUsed'], 16) * int(receipt['effectiveGasPrice'], 16)
        amount_debits = [before[i] - after[i] - (gas_fee if token == ZERO else 0)
            for i, token in enumerate((key.currency0, key.currency1))]
        net_native = native_before-native_after-gas_fee
        row = {'kind': artifact['kind'], 'nonceRaw': artifact['transaction']['nonceRaw'],
            'gasEstimatedRaw': artifact['simulation']['estimatedGasRaw'],
            'gasLimitRaw': artifact['transaction']['gasLimitRaw'],
            'localReceipt': receipt_summary(result), 'reconciliationState': result['state'],
            'reconciliationReason': result['reason'],
            'localSingleTransactionDebitsRaw': list(map(str, amount_debits)),
            'localNativeNetDebitRaw': str(net_native),
            'localNativeRefundRaw': str(int(artifact['transaction']['valueRaw']) - net_native),
            'mintedBounds': artifact['mintedBounds']}
        steps.append(row)
        if receipt['status'] != '0x1' or result['state'] != 'confirmed':
            return {'name': name, 'status': 'failed', 'selection': selected, 'steps': steps,
                'providerCalls': dict(provider_calls), 'reason': 'fork_step_not_confirmed'}
        if artifact['kind'] == 'mint':
            limits = [int(artifact['mintedBounds'][f'amount{i}MaxRaw']) for i in (0, 1)]
            if any(not 0 <= debit <= cap for debit, cap in zip(amount_debits, limits)):
                raise DataError('fork_deposit_budget_conservation')
            position_receipt = row['localReceipt']['position']
            for i, token in enumerate((key.currency0, key.currency1)):
                actual = position_receipt[f'amount{i}Raw']
                if ((token == ZERO and actual is not None)
                        or (token != ZERO and actual != str(amount_debits[i]))):
                    raise DataError('fork_receipt_balance_mismatch')
            return {'name': name, 'status': 'protocol_path_passed', 'selection': selected,
                'steps': steps, 'providerCalls': dict(provider_calls),
                'compositionObservations': composition_observations,
                'controls': controls, 'receiptAmountsMatchControlledDeltas': True,
                'productionAdmission': 'reviewed_candidate_not_activated' if reviewed_manifest else 'blocked_proxy_tokens',
                'executionEligible': False, 'missingAdmissionDenied': True,
                'testAdmissionOverride': reviewed_manifest is None,
                'tokenReviewIds': artifact['admission'].get('tokenReviews')}
    return {'name': name, 'status': 'failed', 'selection': selected, 'steps': steps,
        'providerCalls': dict(provider_calls), 'reason': 'fork_step_limit'}


def main(argv=None):
    parser = _Parser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--rpc-config', required=True, type=Path)
    parser.add_argument('--uniswap-config', required=True, type=Path)
    parser.add_argument('--case', choices=CASES, action='append')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--reviewed-profiles', type=Path,
        help='Explicit reviewed candidate profiles; no synthetic token-admission override')
    try:
        args = parser.parse_args(argv)
    except DataError as error:
        print(json.dumps({'status': 'failed', 'reason': safe_error(error)}))
        return 2
    report = {'schemaVersion': 1, 'mode': 'local_fork_protocol_qualification',
        'chainId': CHAIN_ID, 'executionEligible': False, 'productionAdmissionChanged': False,
        'mainnetTransactionsSent': 0, 'owner': OWNER, 'cases': [],
        'testAdmissionOverride': 'synthetic in-memory flags; not token review',
        'gasModel': 'local Ethereum Cancun EVM; not Nitro fee qualification',
        'finalityModel': 'Anvil with one slot per epoch; not mainnet finality',
        'startedAt': int(time.time())}
    try:
        reviewed_manifest = None
        if args.reviewed_profiles:
            reviewed_manifest, profile_digest = load_candidate_with_digest(args.reviewed_profiles)
            report['testAdmissionOverride'] = False
            report['reviewedManifestId'] = reviewed_manifest['manifestId']
            report['reviewedProfilesSha256'] = profile_digest
        config = load_config(args.rpc_config)
        api_key = uniswap_config.load_config(args.uniswap_config)['apiKey']
        with ForkReadGateway(config['rpcUrl'], allowed_hosts=config.get('rpcAllowedHosts',
                ('rpc.mainnet.chain.robinhood.com', 'robinhood-mainnet.g.alchemy.com'))) as gateway:
            if gateway.request('eth_chainId') != hex(CHAIN_ID):
                raise DataError('fork_source_chain_mismatch')
            source = gateway.request('eth_getBlockByNumber', ['latest', False])
            report['source'] = {k: source[k] for k in ('number', 'hash', 'timestamp')}
            report['providerHost'] = urlsplit(config['rpcUrl']).hostname
            with DepositFork(gateway, block=source) as fork:
                report['anvilVersion'] = fork.version
                report['bootstrap'] = _bootstrap(fork)
                for name in args.case or CASES:
                    checkpoint = fork.request('evm_snapshot')
                    print(json.dumps({'case': name, 'status': 'started'}), flush=True)
                    try:
                        case = run_case(fork, api_key, name, reviewed_manifest=reviewed_manifest)
                    except (DataError, DepositError, ForkReadError) as error:
                        case = {'name': name, 'status': 'failed', 'reason': safe_error(error)}
                    report['cases'].append(case)
                    print(json.dumps({'case': name, 'status': case['status'],
                        'reason': case.get('reason')}), flush=True)
                    if fork.request('evm_revert', [checkpoint]) is not True:
                        raise DataError('fork_checkpoint_restore_failed')
                report['localMethodCounts'] = dict(fork.counts)
            if gateway.request('eth_getBlockByNumber', [source['number'], False]).get('hash') != source['hash']:
                raise DataError('fork_source_changed')
            report['sourceCanonicalAtEnd'] = True
        report['upstream'] = gateway.stats
        report['status'] = 'completed' if all(c['status'] == 'protocol_path_passed' for c in report['cases']) else 'findings'
    except Exception as error:
        report.update(status='failed', reason=safe_error(error))
    report['completedAt'] = int(time.time())
    try:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    except OSError:
        print(json.dumps({'status': 'failed', 'reason': 'qualification_output_unavailable'}))
        return 2
    print(json.dumps({'status': report['status'], 'cases': len(report['cases']),
        'reason': report.get('reason'), 'mainnetTransactionsSent': 0}), flush=True)
    return 0 if report['status'] == 'completed' else 2


if __name__ == '__main__':
    raise SystemExit(main())
