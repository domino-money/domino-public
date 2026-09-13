"""Checks the app's derived onboarding-v1 and deposit-v1 fixtures against the Python producer model.

Read-only. Imports backend/onboarding_models.py and backend/deposit_models.py
in place and runs each body through its response model and validate_response,
which the services run on every answer before sending it. The models leave a
few rules to the services and the reconciler; those are checked here too,
each citing where the producer enforces it. The same rules are held in node by
app/tests/consumer.fixtures.test.mjs (support/derived-corpus.mjs).

Input: the JSON that app/scripts/check-producer-fixtures.mjs writes to stdin.
Needs backend/requirements-readonly.txt (pydantic, eth-abi, eth-hash).
"""
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))

import deposit_models  # noqa: E402
import onboarding_models  # noqa: E402
from pydantic import ValidationError  # noqa: E402


def fingerprint(request):
    """backend/uniswap_quote.py and uniswap_position.py: SHA-256 of the request identity, compact JSON, sorted keys."""
    return hashlib.sha256(json.dumps(request, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def reasons(error):
    if isinstance(error, ValidationError):
        return '; '.join(item['msg'] for item in error.errors())
    return f'{type(error).__name__}: {error}'


def modelled(models, route, body):
    """The model's own reason first (validate_response hides it), then validate_response as the service calls it."""
    try:
        models.RESPONSE_MODELS[route].model_validate(body)
    except Exception as error:  # noqa: BLE001 - reported, never swallowed
        return reasons(error)
    try:
        models.validate_response(route, body)
    except Exception as error:  # noqa: BLE001
        return reasons(error)
    return None


def deposit_rules(route, body):
    """What the deposit producer never answers beyond deposit_models.

    backend/deposit_receipt.py (ReceiptReconciler.reconcile): a reorged outcome
      has receipt None; confirmed and reverted come only from a finalized
      receipt with that status (finality other than finalized is pending).
    backend/deposit_service.py (_operation): the wire receipt is the latest
      observation's, so a reorged step shows none.
    backend/deposit_store.py (cancel, reconcile): cancel_requested only from an
      operation with an issued step; attention or cancel_requested with
      outstanding false only beside another outstanding operation (the newer
      reservation); confirmed only after a mint step; reverted only after a
      reverted one.
    """
    if route == 'list':
        operations = [dict(item, history=[item['lastStep']] if item['lastStep'] else []) for item in body['operations']]
    else:
        operations = [body['operation']]
    problems = []
    for op in operations:
        for step in op['history']:
            at = f"{op['id']} step {step['step']}"
            receipt, state = step['receipt'], step['reconciliationState']
            if state == 'reorged' and receipt is not None:
                problems.append(f'{at}: a reorged observation carries no receipt')
            if state == 'confirmed' and not (receipt and receipt['finality'] == 'finalized' and receipt['outcome'] == 'success'):
                problems.append(f'{at}: confirmed only on a finalized, successful receipt')
            if state == 'reverted' and not (receipt and receipt['finality'] == 'finalized' and receipt['outcome'] == 'reverted'):
                problems.append(f'{at}: reverted only on a finalized, reverted receipt')
        last = op['history'][-1] if op['history'] else None
        if op['state'] == 'confirmed' and not (last and last['kind'] == 'mint' and last['reconciliationState'] == 'confirmed'):
            problems.append(f"{op['id']}: confirmed only after a confirmed mint step")
        if op['state'] == 'reverted' and not (last and last['reconciliationState'] == 'reverted'):
            problems.append(f"{op['id']}: reverted only after a reverted step")
        if op['state'] == 'cancel_requested' and not op['history']:
            problems.append(f"{op['id']}: only an operation with an issued step is cancel_requested")
        if (op['state'] in ('attention', 'cancel_requested') and not op['outstanding']
                and not any(other is not op and other['outstanding'] for other in operations)):
            problems.append(f"{op['id']}: {op['state']} with outstanding false needs the newer reservation beside it")
    return problems


def main():
    payload = json.load(sys.stdin)
    failures = []
    for entry in payload['onboardingPackage']:
        preview = entry['body']['preview']
        if fingerprint(preview['request']) != preview['requestFingerprint']:
            failures.append(f"{entry['id']}: the fingerprint formula does not reproduce this package fixture")
    for entry in payload['onboarding']:
        problem = modelled(onboarding_models, entry['route'], entry['body'])
        if problem:
            failures.append(f"{entry['id']}: onboarding_models refuses it: {problem}")
            continue
        preview = entry['body']['preview']
        if fingerprint(preview['request']) != preview['requestFingerprint']:
            failures.append(f"{entry['id']}: requestFingerprint is not the producer's hash of its request")
    for entry in payload['deposit']:
        problem = modelled(deposit_models, entry['route'], entry['body'])
        if problem:
            failures.append(f"{entry['id']}: deposit_models refuses it: {problem}")
            continue
        failures.extend(f"{entry['id']}: {problem}" for problem in deposit_rules(entry['route'], entry['body']))
    for failure in failures:
        print(f'FAIL {failure}')
    print(f"Python producer model: {len(payload['onboarding'])} derived onboarding previews, "
          f"{len(payload['deposit'])} deposit bodies, {len(payload['onboardingPackage'])} package previews "
          f"anchoring the fingerprint formula; skipped (owner-binding controls): {', '.join(payload['skipped'])}. "
          f"{len(failures)} problem(s).")
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
