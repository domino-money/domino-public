"""Canonical tariff-as-mode interpretation; the existing Policy ABI is unchanged.

A stored 200-bps policy is simple/root-only. A 400-bps policy is Domino for
all recipes. Mode changes never recharge converted lots. Pure accounting and
historical receipts may represent rates outside the two current policy tariffs.
"""
SIMPLE_SERVICE_FEE_BPS = 200
DOMINO_SERVICE_FEE_BPS = 400
MAX_SERVICE_FEE_BPS = DOMINO_SERVICE_FEE_BPS


def is_simple(service_fee_bps):
    return service_fee_bps == SIMPLE_SERVICE_FEE_BPS


def valid_tariff(service_fee_bps):
    return type(service_fee_bps) is int and service_fee_bps in (SIMPLE_SERVICE_FEE_BPS, DOMINO_SERVICE_FEE_BPS)


def valid_policy_tariff(service_fee_bps, max_positions):
    return valid_tariff(service_fee_bps) and (not is_simple(service_fee_bps) or max_positions == 1)
