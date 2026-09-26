"""Compose the automation's three private configuration files from a verified
release record and a committed, versioned parameter profile.

Example, from a checkout; it writes into a new private directory:

  python backend/configure_automation.py \
    --release docs/deployments/v1-robinhood-mainnet-2026-09-21 \
    --profile docs/deployments/v1-robinhood-mainnet-2026-09-21/automation-pilot-v1.json \
    --sequence 0x<owner>:0x<vault> --sequence-expires-at <unix seconds> \
    --out /private/automation-config

Every operational number comes from the profile; nothing is defaulted here and
nothing comes from test fixtures. The deployment admission is the release's
sequence profile, taken only after its SHA-256 matches the release record and
every address, role, tariff, expiry and runtime hash agrees with it. The host
layout is the one the installer creates: the financial database socket, the
VM-local loopback RPC, and the unit's read-only configuration mount. Keys are
never read or written; the configuration only names where the unit finds them,
and their owner places them there.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid

from pydantic import ValidationError

from automation_config import KIND, validate_config
from automation_cycle import READINESS_MAX_INTERVAL_SECONDS
from bridge_state import strict_json
from discovery import SNAPSHOT_LOOPBACK_RPC
from execution_signer import ExecutionRpc
from gas_budget_bridge import _service as reservation_service
from gas_settlement_cli import service as settlement_service

PROFILE_KIND = 'domino-automation-profile'
RELEASE_KIND = 'domino-public-mainnet-deployment'
CHAIN_ID = 4663
# The installer's layout: the unit binds /etc/domino/financial/automation read-only
# here, and every financial service reaches PostgreSQL through this socket.
CONFIG_MOUNT = '/run/domino-financial-automation-config'
DATABASE = {'host': '/run/postgresql-domino', 'port': 8877, 'dbname': 'domino_catalogue'}
KEY_FILES = {'operator': CONFIG_MOUNT + '/operator.key', 'publisher': CONFIG_MOUNT + '/publisher.key'}
PROFILE_SECTIONS = ('operatorPolicy', 'publisher', 'planner', 'pricing', 'swapCap', 'gas', 'destinations',
                    'history', 'plan', 'scheduling', 'finality', 'ledger', 'paused')
CONTRACTS = ('factory', 'readHelper', 'routing', 'priceGuard', 'engine', 'implementation')
DEPENDENCIES = ('poolManager', 'positionManager', 'stateView')
PEERS = (('gas-reservation', 'domino-gas-reservation'), ('gas-settlement', 'domino-gas-settlement'))
ADDRESS = re.compile(r'0x[0-9a-f]{40}')


class ConfigurationError(ValueError):
    pass


def refuse(code):
    raise ConfigurationError(code)


def read_json(path, maximum=1048576):
    raw = Path(path).read_bytes()
    if len(raw) > maximum:
        refuse('configuration_input_too_large')
    return raw, strict_json(raw)


def load_release(directory):
    """The sequence profile's deployment, bound to the release record that pins it."""
    directory = Path(directory)
    _, record = read_json(directory / 'deployment.json')
    if (type(record) is not dict or record.get('kind') != RELEASE_KIND
            or record.get('chain', {}).get('chainId') != CHAIN_ID or record.get('contractsDeployed') is not True):
        refuse('release_record_invalid')
    pin = record.get('profileFiles', {}).get('sequence', {})
    if pin.get('file') != 'sequence-release.json':
        refuse('release_record_invalid')
    raw, profile = read_json(directory / pin['file'])
    if hashlib.sha256(raw).hexdigest() != pin.get('sha256'):
        refuse('sequence_profile_digest_mismatch')
    if type(profile) is not dict or profile.get('chainId') != CHAIN_ID or profile.get('available') is not True:
        refuse('sequence_profile_invalid')
    deployment = profile.get('deployment')
    roles, policies = record.get('roles', {}), record.get('policies', {})
    expected = {**{k: record.get('contracts', {}).get(k) for k in CONTRACTS},
                **{k: record.get('dependencies', {}).get(k) for k in DEPENDENCIES},
                'serviceFeeRecipient': roles.get('feeRecipient'), 'operator': roles.get('operator'),
                'pricePublisher': roles.get('pricePublisher'),
                'serviceFeeBps': policies.get('simpleCompoundFeeBps'),
                'dominoServiceFeeBps': policies.get('dominoCompoundFeeBps'),
                'expiresAt': record.get('profileExpiresAt')}
    if type(deployment) is not dict or any(deployment.get(k) != v for k, v in expected.items()):
        refuse('sequence_profile_disagrees_with_release')
    hashes = record.get('runtimeCodeHashes', {})
    if (type(deployment.get('codeHashes')) is not dict
            or any(hashes.get(k) != v for k, v in deployment['codeHashes'].items())):
        refuse('sequence_profile_disagrees_with_release')
    if type(record.get('releaseTag')) is not str:
        refuse('release_record_invalid')
    return record['releaseTag'], deployment


def planner_version(planner):
    """The planner's version names its numbers: changing any of them is a new version."""
    numbers = {name: value for name, value in planner.items() if name != 'version'}
    return '0x' + hashlib.sha256(json.dumps(numbers, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def load_profile(path):
    _, profile = read_json(path)
    if (type(profile) is not dict
            or set(profile) != {'schemaVersion', 'kind', 'configVersion', 'releaseTag', *PROFILE_SECTIONS}
            or profile['schemaVersion'] != 1 or profile['kind'] != PROFILE_KIND):
        refuse('automation_profile_invalid')
    # The host fixes where the keys are and who the worker is; a profile never does.
    if (type(profile['publisher']) is not dict or 'keyFile' in profile['publisher']
            or type(profile['scheduling']) is not dict or 'workerId' in profile['scheduling']):
        refuse('automation_profile_invalid')
    if type(profile['planner']) is not dict or profile['planner'].get('version') != planner_version(profile['planner']):
        refuse('planner_version_mismatch')
    return profile


def parse_sequence(text):
    owner, separator, vault = text.lower().partition(':')
    if not separator or not ADDRESS.fullmatch(owner) or not ADDRESS.fullmatch(vault):
        refuse('sequence_invalid')
    return owner, vault


def check_operation(config):
    """Numbers each model accepts alone but that together would make the service
    wait forever without saying so, or pay for work it cannot finish."""
    scheduling, history, gas = config.scheduling, config.history, config.gas
    planner, operator, publisher = config.planner_settings(), config.operator.policy, config.publisher
    # The signers refuse a balance below the envelope after the publication is paid
    # (execution_gas_balance), so the gate before it must ask for the worst envelope.
    if (gas.operatorMinimumBalanceWei < min(operator.max_gas * operator.max_fee_per_gas, operator.max_total_cost,
                                            config.plan.maxGasCostWei)
            or gas.publisherMinimumBalanceWei < min(publisher.maxGas * publisher.maxFeePerGas, publisher.maxTotalCostWei)):
        refuse('minimum_balance_below_envelope')
    # Every swap quote is priced with the swap units, a successor's mint included.
    if gas.executeGasUnits.swap < gas.executeGasUnits.mint:
        refuse('swap_units_below_mint')
    # A waiting sequence is sampled only when a pass runs; a gap longer than the
    # admitted one opens a new epoch, and a series that always restarts never plans.
    spacing = (history.sampleIntervalSeconds + scheduling.maximumBackoffSeconds * (10000 + scheduling.jitterBps) // 10000
               + scheduling.cycleBudgetSeconds)
    if history.maximumSampleGapSeconds <= spacing:
        refuse('sample_gap_below_waiting_cadence')
    if (planner.minimumSamples > planner.maximumMeasurementSeconds // spacing + 1
            or planner.minimumSampleSeconds > planner.maximumMeasurementSeconds - spacing):
        refuse('measurement_window_too_short')
    # A pass samples before it plans, so the newest sample is at most an interval old.
    if planner.maximumSampleAgeSeconds <= history.sampleIntervalSeconds:
        refuse('sample_age_below_interval')


def compose(release, profile, sequences, *, expires_at, worker_id, rpc_endpoint=SNAPSHOT_LOOPBACK_RPC, now=None):
    """The automation configuration and both gas peers', each validated by its own loader."""
    tag, deployment = release
    now = int(time.time()) if now is None else now
    if profile['releaseTag'] != tag:
        refuse('automation_profile_for_another_release')
    if not sequences:
        refuse('sequence_required')
    # A sequence admitted past the release profile's expiry would outlive what admits it.
    if type(expires_at) is not int or not now < expires_at <= deployment['expiresAt']:
        refuse('sequence_expiry_invalid')
    if str(uuid.UUID(worker_id)) != worker_id:
        refuse('worker_id_invalid')
    ExecutionRpc(rpc_endpoint)
    config = {
        'schemaVersion': 1, 'kind': KIND, 'configVersion': profile['configVersion'],
        'database': dict(DATABASE), 'rpcEndpoint': rpc_endpoint, 'deployment': deployment,
        'sequences': [{'owner': owner, 'vault': vault, 'expiresAt': expires_at, 'suspended': False}
                      for owner, vault in sequences],
        'operator': {'keyFile': KEY_FILES['operator'], 'policy': profile['operatorPolicy']},
        'publisher': {'keyFile': KEY_FILES['publisher'], **profile['publisher']},
        **{name: profile[name] for name in ('planner', 'pricing', 'swapCap', 'gas', 'destinations',
                                            'history', 'plan', 'finality', 'ledger', 'paused')},
        'scheduling': {'workerId': worker_id, **profile['scheduling']},
    }
    parsed = validate_config(config)
    # The app offers activation only while the service's heartbeat is this fresh.
    if parsed.scheduling.evaluationIntervalSeconds > READINESS_MAX_INTERVAL_SECONDS:
        refuse('evaluation_interval_above_readiness')
    check_operation(parsed)
    peers = {}
    for directory, kind in PEERS:
        peers[directory] = {'schemaVersion': 1, 'kind': kind, 'database': dict(DATABASE), 'rpcEndpoint': rpc_endpoint}
    reservation_service(peers['gas-reservation'])
    settlement_service(peers['gas-settlement'])
    return {'automation': config, **peers}


def encode(value):
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n').encode()


def write(out, documents):
    """A new 0700 directory holding each peer's 0600 config.json; nothing is overwritten."""
    out = Path(out)
    out.mkdir(mode=0o700)
    os.chmod(out, 0o700)
    written = {}
    for directory, document in documents.items():
        folder = out / directory
        folder.mkdir(mode=0o700)
        os.chmod(folder, 0o700)
        path = folder / 'config.json'
        raw = encode(document)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(raw)
        written[str(path)] = hashlib.sha256(raw).hexdigest()
    return written


def main(argv=None):
    parser = argparse.ArgumentParser(description='Compose the automation and gas peers private configuration')
    parser.add_argument('--release', required=True, help='docs/deployments/<release> directory')
    parser.add_argument('--profile', required=True, help='the committed parameter profile')
    parser.add_argument('--sequence', action='append', default=[], help='owner:vault, repeatable')
    parser.add_argument('--sequence-expires-at', type=int, required=True, help='unix seconds, at most the release expiry')
    parser.add_argument('--worker-id', help='keep the host\'s existing worker id; a new one is made otherwise')
    parser.add_argument('--rpc-endpoint', default=SNAPSHOT_LOOPBACK_RPC)
    parser.add_argument('--out', required=True, help='a directory that does not exist yet')
    args = parser.parse_args(argv)
    try:
        sequences = [parse_sequence(text) for text in args.sequence]
        if len(set(sequences)) != len(sequences):
            refuse('sequence_duplicate')
        worker_id = args.worker_id or str(uuid.uuid4())
        documents = compose(load_release(args.release), load_profile(args.profile), sequences,
                            expires_at=args.sequence_expires_at, worker_id=worker_id,
                            rpc_endpoint=args.rpc_endpoint)
        written = write(args.out, documents)
    except ValidationError as error:
        # Field paths only: which number the profile is missing or has out of bounds.
        print(json.dumps({'error': 'automation_configuration_invalid',
                          'fields': sorted({'.'.join(map(str, e['loc'])) for e in error.errors()})}))
        return 1
    except FileExistsError:
        print(json.dumps({'error': 'output_exists'}))
        return 1
    except (OSError, ValueError) as error:
        code = getattr(error, 'code', None) or str(error)
        print(json.dumps({'error': code if re.fullmatch(r'[a-z0-9_]{3,64}', code) else 'automation_configuration_refused'}))
        return 1
    print(json.dumps({'configVersion': documents['automation']['configVersion'], 'workerId': worker_id,
                      'sequences': documents['automation']['sequences'], 'files': written},
                     indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
