"""One explicitly admitted, independently simulated wallet step; never broadcast.

The LP adapter supplies the liquidity composition. This module checks identities,
spending caps and state; it contains no liquidity or dependent-amount formula.
Review evidence is trusted operator input, not inferred from token metadata or a
successful simulation. Code hashes alone do not prove ERC20 semantics.
The #42 deployment review found canonical WETH and USDG are upgradeable proxies;
neither meets this policy's nonUpgradeable claim. Local-fork test admission is
not a production review or authorization to populate a manifest.

Primary interface references (deployment evidence must still be reviewed):
https://developers.uniswap.org/docs/protocols/v4/deployments
https://github.com/Uniswap/permit2/blob/main/src/interfaces/IAllowanceTransfer.sol
https://github.com/Uniswap/v4-periphery/blob/main/src/PositionManager.sol
https://eips.ethereum.org/EIPS/eip-20
"""
from dataclasses import asdict
import hashlib
import json
import math
import re
import time

from eth_abi import decode, encode
from eth_hash.auto import keccak

from deposit_models import DepositError, DepositSelection, PreparedArtifact
from discovery import (CHAIN_ID, ZERO, POOL_MANAGER, POSITION_MANAGER, STATE_VIEW,
    KEY_TYPES, DataError, PoolKey, address, bytes32, parse_block, quantity)
from lp_mint_inspection import inspect_mint, MSG_SENDER, ADDRESS_THIS
from read_deadline import check_read_deadline, read_deadline

PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
POLICY_VERSION = 'direct_existing_pool_v1'
DEPLOYMENTS = {'poolManager': POOL_MANAGER, 'positionManager': POSITION_MANAGER,
               'stateView': STATE_VIEW, 'permit2': PERMIT2}
MANIFEST_LIFETIME = 30 * 86400
MAX_ARTIFACT_BYTES = 96 * 1024
PERMIT2_LIFETIME_SECONDS = 3600
PREPARATION_ERRORS = {
    'read_deadline_exceeded': 'request_timeout',
    'deposit_pending_nonce': 'deposit_wallet_pending',
    'deposit_budget_or_balance': 'deposit_funding_insufficient',
    'deposit_fee_cap': 'deposit_fee_cap_too_low',
    'deposit_gas_cap': 'deposit_gas_limit_exceeded',
    'deposit_native_headroom': 'deposit_gas_balance_insufficient',
    'deposit_snapshot_changed': 'deposit_state_changed',
    'deposit_composition_expired': 'deposit_state_changed',
    'deposit_artifact_expired': 'deposit_state_changed',
    'deposit_snapshot_expired': 'deposit_state_changed',
}


def _now(clock):
    value = clock()
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value < 2**53:
        raise DataError('invalid_deposit_clock')
    return value


def _reference(value):
    return isinstance(value, str) and 1 <= len(value) <= 256 and all(32 <= ord(c) <= 126 for c in value)


def validate_admission_manifest(manifest, *, now):
    """Return a detached, closed, bounded review record or deny admission.

    The caller must load operator-owned configuration securely. This validator
    cannot authenticate the reviewer or independently establish review claims.
    """
    try:
        if not isinstance(manifest, dict) or set(manifest) != {
                'schemaVersion', 'policyVersion', 'manifestId', 'reviewedAt', 'expiresAt',
                'reviewReference', 'nativeEnabled', 'deployments', 'tokens'}:
            raise ValueError
        m = json.loads(json.dumps(manifest, allow_nan=False))
        if (type(m['schemaVersion']) is not int or m['schemaVersion'] != 1
                or m['policyVersion'] != POLICY_VERSION or type(m['nativeEnabled']) is not bool
                or not _reference(m['reviewReference'])
                or type(m['reviewedAt']) is not int or type(m['expiresAt']) is not int
                or not 0 <= m['reviewedAt'] <= now < m['expiresAt'] <= m['reviewedAt'] + MANIFEST_LIFETIME
                or not isinstance(m['manifestId'], str)
                or not re.fullmatch('[0-9a-f]{64}', m['manifestId'])
                or not isinstance(m['deployments'], dict) or set(m['deployments']) != set(DEPLOYMENTS)
                or not isinstance(m['tokens'], list) or len(m['tokens']) > 32):
            raise ValueError
        for value in m['deployments'].values():
            if bytes32(value) != value:
                raise ValueError
        seen = set()
        for token in m['tokens']:
            if not isinstance(token, dict) or set(token) != {'address', 'codeHash', 'reviewReference',
                    'standardTransfer', 'nonRebasing', 'nonUpgradeable', 'approvalReturn'}:
                raise ValueError
            if (address(token['address']) != token['address'] or token['address'] == ZERO
                    or token['address'] in seen or bytes32(token['codeHash']) != token['codeHash']
                    or not _reference(token['reviewReference'])
                    or any(token[flag] is not True for flag in ('standardTransfer', 'nonRebasing', 'nonUpgradeable'))
                    or token['approvalReturn'] not in ('bool', 'empty')):
                raise ValueError
            seen.add(token['address'])
        digest = hashlib.sha256(json.dumps({k: v for k, v in m.items() if k != 'manifestId'},
            sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        if digest != m['manifestId']:
            raise ValueError
        return m
    except Exception:
        raise DepositError('deposit_admission_required') from None


def calldata(signature, types=(), values=()):
    return '0x' + (keccak(signature.encode())[:4] + encode(types, values)).hex()


def decode_exact(types, raw):
    if not isinstance(raw, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', raw) or len(raw) > 16386:
        raise DataError('invalid_deposit_abi')
    try:
        blob = bytes.fromhex(raw[2:])
        result = decode(types, blob)
        if encode(types, result) != blob:
            raise ValueError
        return result
    except Exception:
        raise DataError('invalid_deposit_abi') from None


def _code_hash(raw):
    if not isinstance(raw, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+', raw) or len(raw) > 98306:
        raise DataError('invalid_deposit_code')
    return '0x' + keccak(bytes.fromhex(raw[2:])).hex()


def _nonce(raw):
    value = quantity(raw)
    if value >= 2**64:
        raise DataError('invalid_deposit_nonce')
    return value


class DirectDepositPreparer:
    def __init__(self, position, rpc_factory, *, admission=None, clock=time.time):
        self.position, self.rpc_factory, self.clock = position, rpc_factory, clock
        # Detach trusted input, but revalidate time and its hash on every request.
        self.admission = (validate_admission_manifest(admission, now=_now(clock))
                          if admission is not None else None)

    def prepare(self, owner, selection):
        try:
            owner = address(owner)
            if owner in (ZERO, MSG_SENDER, ADDRESS_THIS):
                raise ValueError
            selected = DepositSelection.model_validate(selection).model_dump()
        except Exception:
            raise DepositError('deposit_invalid_request') from None
        try:
            with read_deadline(20):
                return self._prepare(owner, selected)
        except DepositError:
            raise
        except Exception as error:
            code = PREPARATION_ERRORS.get(str(error)) if isinstance(error, DataError) else None
            raise DepositError(code or 'deposit_preparation_unavailable') from None

    def _prepare(self, owner, selected):
        started = _now(self.clock)
        manifest = validate_admission_manifest(self.admission, now=started)
        key = PoolKey.checked(tuple(selected['poolKey'][k] for k in
            ('currency0', 'currency1', 'fee_pips', 'tick_spacing', 'hooks')), selected['poolId'])
        tokens = {row['address']: row for row in manifest['tokens']}
        currencies = (key.currency0, key.currency1)
        if key.hooks != ZERO or key.fee_pips > 1_000_000 or any(
                not manifest['nativeEnabled'] if c == ZERO else c not in tokens for c in currencies):
            raise DepositError('deposit_admission_required')
        check_read_deadline()
        rpc = self.rpc_factory()

        def request(method, params=()):
            check_read_deadline()
            result = rpc.request(method, params)
            check_read_deadline()
            return result

        if quantity(request('eth_chainId')) != CHAIN_ID:
            raise DataError('deposit_chain_mismatch')
        raw_block = request('eth_getBlockByNumber', ['latest', False])
        block = parse_block(raw_block)
        self._fresh(block, started)
        base_fee = quantity(raw_block.get('baseFeePerGas'))
        block_gas_limit = quantity(raw_block.get('gasLimit'))
        pinned = {'blockHash': block.hash, 'requireCanonical': True}

        def call(to, signature, inputs=(), values=(), outputs=()):
            return decode_exact(outputs, request('eth_call', [{'to': to,
                'data': calldata(signature, inputs, values), 'gas': hex(500_000)}, pinned]))

        for label, target in DEPLOYMENTS.items():
            if _code_hash(request('eth_getCode', [target, pinned])) != manifest['deployments'][label]:
                raise DepositError('deposit_admission_required')
        if request('eth_getCode', [owner, pinned]) != '0x':
            raise DepositError('deposit_admission_required')
        for token in currencies:
            if token != ZERO and _code_hash(request('eth_getCode', [token, pinned])) != tokens[token]['codeHash']:
                raise DepositError('deposit_admission_required')
        for target, signature, expected in ((POSITION_MANAGER, 'poolManager()', POOL_MANAGER),
                (STATE_VIEW, 'poolManager()', POOL_MANAGER), (POSITION_MANAGER, 'permit2()', PERMIT2)):
            if call(target, signature, outputs=['address'])[0] != expected:
                raise DataError('deposit_manager_mismatch')
        observed_key = call(POSITION_MANAGER, 'poolKeys(bytes25)', ['bytes25'],
            [bytes.fromhex(selected['poolId'][2:52])], KEY_TYPES)
        if PoolKey.checked(observed_key, selected['poolId']) != key:
            raise DataError('deposit_pool_mismatch')
        sqrt, tick, _, lp_fee = call(STATE_VIEW, 'getSlot0(bytes32)', ['bytes32'],
            [bytes.fromhex(selected['poolId'][2:])], ['uint160', 'int24', 'uint24', 'uint24'])
        if not sqrt or not -887272 <= tick <= 887272 or lp_fee != key.fee_pips:
            raise DataError('deposit_pool_unavailable')
        native = quantity(request('eth_getBalance', [owner, pinned]))
        balances = [native if token == ZERO else call(token, 'balanceOf(address)', ['address'],
            [owner], ['uint256'])[0] for token in currencies]
        nonce = _nonce(request('eth_getTransactionCount', [owner, pinned]))
        pending_nonce = _nonce(request('eth_getTransactionCount', [owner, 'pending']))
        if pending_nonce != nonce:
            raise DataError('deposit_pending_nonce')
        check_read_deadline()
        composed = self.position.prepare_mint(owner=owner, pool_id=selected['poolId'], pool_key=key,
            independent_token=selected['independentToken'], amount_raw=selected['amountRaw'],
            tick_lower=selected['tickLower'], tick_upper=selected['tickUpper'],
            slippage_bps=selected['slippageBps'], budget0_raw=selected['budget0Raw'],
            budget1_raw=selected['budget1Raw'], native_balance_raw=str(native),
            native_gas_reserve_raw=selected['nativeGasReserveRaw'], chain_id=CHAIN_ID)
        check_read_deadline()
        preview, mint_tx = composed['preview'], composed['transaction']
        deadline = preview['preparedDeadline']
        now = _now(self.clock)
        if (type(deadline) is not int or deadline != preview['requestedAt'] + 120
                or not int(started) <= preview['requestedAt'] <= preview['retrievedAt'] <= now + 5
                or not now < preview['expiresAt'] <= preview['requestedAt'] + 30):
            raise DataError('deposit_composition_expired')
        if set(mint_tx) != {'chainId', 'from', 'to', 'data', 'valueRaw'}:
            raise DataError('deposit_composition_invalid')
        bounds = inspect_mint({k: v for k, v in mint_tx.items() if k != 'valueRaw'} |
            {'value': mint_tx['valueRaw']}, owner=owner, pool_key=key, pool_id=selected['poolId'],
            tick_lower=selected['tickLower'], tick_upper=selected['tickUpper'], deadline=deadline)
        caps = [int(bounds[f'amount{i}MaxRaw']) for i in (0, 1)]
        if any(cap > int(selected[f'budget{i}Raw']) or cap > balances[i] for i, cap in enumerate(caps)):
            raise DataError('deposit_budget_or_balance')
        kind, tx, approval_return = 'mint', dict(mint_tx), None
        for token, cap in zip(currencies, caps):
            if token == ZERO or not cap:
                continue
            allowance, = call(token, 'allowance(address,address)', ['address', 'address'],
                [owner, PERMIT2], ['uint256'])
            if allowance < cap:
                amount = 0 if allowance else cap
                kind = 'erc20_reset' if allowance else 'erc20_approval'
                tx = {'chainId': CHAIN_ID, 'from': owner, 'to': token, 'valueRaw': '0',
                    'data': calldata('approve(address,uint256)', ['address', 'uint256'], [PERMIT2, amount])}
                approval_return = tokens[token]['approvalReturn']
                break
            amount, expiration, _ = call(PERMIT2, 'allowance(address,address,address)',
                ['address', 'address', 'address'], [owner, token, POSITION_MANAGER],
                ['uint160', 'uint48', 'uint48'])
            if amount < cap or expiration < deadline:
                kind = 'permit2_approval'
                # Approval must survive separate wallet submissions and finalized
                # receipts. Reusing the rolling 120s mint deadline here would
                # cause renewal after every clock advance. A bounded hour is
                # not a finality promise; delayed/expired approval is reread.
                deadline = preview['requestedAt'] + PERMIT2_LIFETIME_SECONDS
                tx = {'chainId': CHAIN_ID, 'from': owner, 'to': PERMIT2, 'valueRaw': '0',
                    'data': calldata('approve(address,address,uint160,uint48)',
                        ['address', 'address', 'uint160', 'uint48'], [token, POSITION_MANAGER, cap, deadline])}
                break
        # Sign only selected fee ceilings. On qualified Robinhood Nitro,
        # eth_estimateGas bundles execution and charged L1/poster gas. Do not
        # add a second poster estimate; see DEPOSIT_RPC_QUALIFICATION.md.
        max_fee, priority = int(selected['maxFeePerGasRaw']), int(selected['maxPriorityFeePerGasRaw'])
        if max_fee < base_fee + priority:
            raise DataError('deposit_fee_cap')
        max_gas = min(int(selected['maxGasLimitRaw']), block_gas_limit)
        tx.update(nonceRaw=str(nonce), maxFeePerGasRaw=str(max_fee), maxPriorityFeePerGasRaw=str(priority))
        rpc_tx = {'from': owner, 'to': tx['to'], 'data': tx['data'], 'value': hex(int(tx['valueRaw'])),
            'nonce': hex(nonce), 'maxFeePerGas': hex(max_fee), 'maxPriorityFeePerGas': hex(priority),
            'gas': hex(max_gas)}
        estimate = quantity(request('eth_estimateGas', [rpc_tx, pinned]))
        if estimate < 21000:
            raise DataError('invalid_deposit_gas_estimate')
        gas_limit = (estimate * 120 + 99) // 100
        if not estimate <= gas_limit <= max_gas:
            raise DataError('deposit_gas_cap')
        # Reserve this step's bundled gross gas ceiling, not a claimed net fee.
        # Additional ArbOS refunds remain unqualified; receipt totalFeeRaw stays
        # null even when grossGasFeeRaw and an included l1FeeRaw are available.
        if native < int(bounds['nativeValueRaw']) + int(selected['nativeGasReserveRaw']) + gas_limit * max_fee:
            raise DataError('deposit_native_headroom')
        tx['gasLimitRaw'] = str(gas_limit)
        rpc_tx['gas'] = hex(gas_limit)
        simulated = request('eth_call', [rpc_tx, pinned])
        if approval_return == 'bool':
            if decode_exact(['bool'], simulated) != (True,):
                raise DataError('deposit_approval_failed')
        elif simulated != '0x':
            raise DataError('deposit_simulation_invalid')
        if (quantity(request('eth_chainId')) != CHAIN_ID
                or parse_block(request('eth_getBlockByNumber', [block.tag, False])) != block
                or _nonce(request('eth_getTransactionCount', [owner, 'latest'])) != nonce
                or _nonce(request('eth_getTransactionCount', [owner, 'pending'])) != nonce):
            raise DataError('deposit_snapshot_changed')
        completed = _now(self.clock)
        self._fresh(block, completed)
        validate_admission_manifest(manifest, now=completed)
        expires = min(int(started) + 30, preview['expiresAt'])
        if completed < started or completed >= expires:
            raise DataError('deposit_artifact_expired')
        artifact = {'kind': kind, 'transaction': tx, 'sourceBlock': asdict(block),
            'expiresAt': expires, 'preparedDeadline': deadline, 'mintedBounds': bounds,
            'balances': {'nativeRaw': str(native), 'token0Raw': str(balances[0]), 'token1Raw': str(balances[1])},
            'admission': {'manifestId': manifest['manifestId'], 'policyVersion': POLICY_VERSION},
            'simulation': {'status': 'passed', 'estimatedGasRaw': str(estimate),
                'blockNumber': block.number, 'blockHash': block.hash}}
        checked = PreparedArtifact.model_validate(artifact).model_dump(by_alias=True)
        if len(json.dumps(checked, separators=(',', ':')).encode()) > MAX_ARTIFACT_BYTES:
            raise DataError('deposit_artifact_too_large')
        check_read_deadline()
        return checked

    @staticmethod
    def _fresh(block, now):
        if block.number >= 2**53:
            raise DataError('invalid_deposit_block')
        if not now - 30 <= block.timestamp <= now + 5:
            raise DataError('deposit_snapshot_expired')
