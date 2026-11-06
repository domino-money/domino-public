"""The S1 plan service: a SIWE session's wallet asks, the chain's planner answers, the closed contract checks.

Bound to a session like the onboarding previews and the cross-chain quotes:
the session's wallet is the owner, the recipient and the payer; no request
names any of them. Never a signer: the answer is unsigned data the wallet shows.
"""
import json
import math
import time

from pydantic import ValidationError

from discovery import DataError, RpcIntrinsicGas
from read_deadline import check_read_deadline
from v2_position_plan import PlanError
from v2_position_plan_models import (CONTRACT_VERSION, MAX_RESPONSE, PositionPlanError, validate_request,
                                     validate_response)

# Read-path failures that mean the chain or a provider is not answering now.
UNAVAILABLE = frozenset({'network_unavailable', 'v2_rpc_endpoints_cooling', 'request_budget_exhausted',
                         'rpc_error', 'invalid_rpc_envelope', 'missing_rpc_result', 'snapshot_reorganized',
                         'block_unavailable', 'stale_or_future_block', 'v2_deployment_code_mismatch'})


def plan_failure(error):
    """A planner or read-path failure as a contract error code."""
    if isinstance(error, PlanError):
        return PositionPlanError(error.code)
    code = str(error)
    if code == 'read_deadline_exceeded':
        return PositionPlanError('request_timeout')
    # A pool or position of a Uniswap version the chain lacks: the request is not one this chain can answer.
    if code == 'v2_dex_not_on_chain':
        return PositionPlanError('invalid_request')
    # A call that never ran for its intrinsic gas (an L1 price spike on Nitro) is a provider not answering now.
    if code.startswith('http_') or code in UNAVAILABLE or isinstance(error, RpcIntrinsicGas):
        return PositionPlanError('upstream_unavailable')
    return PositionPlanError('upstream_invalid_response')


class PositionPlanService:
    def __init__(self, auth, planners, *, clock=time.time, private_values=()):
        self.auth, self.planners, self.clock = auth, dict(planners), clock
        self.private_values = tuple(value for value in private_values if value)

    def _now(self):
        value = self.clock()
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value < 2**53:
            raise PositionPlanError('upstream_unavailable')
        return value

    def execute(self, route, body, *, client, session, csrf):
        try:
            request = validate_request(route, body).model_dump()
        except PositionPlanError:
            raise
        except (DataError, ValidationError, ValueError, TypeError):
            raise PositionPlanError('invalid_request') from None
        check_read_deadline()
        context = self.auth.begin(client, session, csrf)
        owner = context['owner']
        planner = self.planners.get(request['chainId'])
        if planner is None:
            raise PositionPlanError('position_plan_chain_unavailable')
        try:
            plan = planner.plan(request, owner)
        except (PlanError, DataError) as error:
            raise plan_failure(error) from None
        result = validate_response(route, {'contractVersion': CONTRACT_VERSION, 'plan': plan})
        encoded = json.dumps(result, allow_nan=False, separators=(',', ':'))
        if len(encoded.encode()) > MAX_RESPONSE or any(
                value in encoded for value in (*self.private_values, session, csrf) if value):
            raise PositionPlanError('upstream_invalid_response')
        # A logout or a CSRF rotation while the chain was read invalidates delivery.
        self.auth.finish(context)
        check_read_deadline()
        if result['plan']['expiresAt'] <= self._now():
            raise PositionPlanError('preview_expired')
        return result
