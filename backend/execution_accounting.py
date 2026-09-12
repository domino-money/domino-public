"""E1 internal fee accounting only: no custody, authority, persistence or execution.

The caller must bind opaque source IDs to owner/sequence/manager/NFT-generation
identity and prove each lot's realized earned-fee provenance. ``converted_charged``
is a reconciliation assertion, never a browser-selectable spending permission.
It means the original fee basis was evaluated once, even if floor rounding made
the charge zero. Block observations, canonical receipts and charge history must
be established outside this pure module.

Floor the charge once per action/source/currency over selected original lots.
Never floor separately per credit or swap leg. Repeated distinct actions retain
the existing FeeAccounting policy; this module neither creates a cumulative fee
debt nor proves the economic eligibility of repeated tiny actions.
"""
from collections import defaultdict
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, TypeAdapter, model_validator


UINT128_MAX = 2**128 - 1
MAX_ITEMS = 4096  # Offline input bound, not a selected deployment/position limit.
Bytes32 = Annotated[str, Field(pattern=r'^0x[0-9a-f]{64}$')]
Address = Annotated[str, Field(pattern=r'^0x[0-9a-f]{40}$')]


def _uint128(value):
    if int(value) > UINT128_MAX:
        raise ValueError('uint128_overflow')
    return value


def _positive(value):
    if int(value) == 0:
        raise ValueError('positive_amount_required')
    return value


UInt128 = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,38})$'), AfterValidator(_uint128)]
PositiveUInt128 = Annotated[UInt128, AfterValidator(_positive)]
_POSITIVE_AMOUNT = TypeAdapter(PositiveUInt128)


class AccountingModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class FeeLot(AccountingModel):
    lotId: Bytes32
    sourceId: Bytes32
    currency: Address
    chargeStatus: Literal['original_uncharged', 'converted_charged']
    amountRaw: UInt128
    reservedRaw: UInt128

    @model_validator(mode='after')
    def reserve_within_lot(self):
        if int(self.reservedRaw) > int(self.amountRaw):
            raise ValueError('reserve_exceeds_lot')
        return self


class Allocation(AccountingModel):
    lotId: Bytes32
    amountRaw: PositiveUInt128


class SwapInput(AccountingModel):
    sourceId: Bytes32
    amountInRaw: PositiveUInt128


class SwapReceipt(AccountingModel):
    swapId: Bytes32
    currencyIn: Address
    currencyOut: Address
    amountOutRaw: PositiveUInt128
    inputs: Annotated[list[SwapInput], Field(min_length=1, max_length=MAX_ITEMS)]

    @model_validator(mode='after')
    def distinct_currencies(self):
        if self.currencyIn == self.currencyOut:
            raise ValueError('swap_currencies_equal')
        return self


class Disposition(AccountingModel):
    sourceId: Bytes32
    currency: Address
    liquidityFromInputRaw: UInt128
    liquidityFromSwapRaw: UInt128


def _models(kind, values):
    if type(values) is not list or len(values) > MAX_ITEMS:
        raise ValueError('invalid_accounting_vector')
    return [kind.model_validate(value.model_dump() if isinstance(value, kind) else value)
            for value in values]


def _bounded_sum(total, value):
    total += value
    if total > UINT128_MAX:
        raise ValueError('aggregate_uint128_overflow')
    return total


def _lot_totals(lots):
    totals, identities = defaultdict(lambda: [0, 0]), set()
    for lot in lots:
        if lot.lotId in identities:
            raise ValueError('duplicate_lot')
        identities.add(lot.lotId)
        row = totals[(lot.sourceId, lot.currency)]
        index = 0 if lot.chargeStatus == 'original_uncharged' else 1
        row[index] += int(lot.amountRaw)
        _bounded_sum(row[0], row[1])
    return totals


def consume_allocations(lots, allocations, *, service_fee_bps):
    """Split selected unreserved fee lots and return new values without mutation.

    Reservations are held for other unresolved work and remain untouched. A later
    durable caller must reconcile its own reservation before using this preview;
    this function is not a reservation/intent state transition. Empty allocations
    preserve every lot and permit a wait preview, never a signable wait action.
    """
    if type(service_fee_bps) is not int or not 0 <= service_fee_bps <= 200:
        raise ValueError('invalid_service_fee_bps')
    lots, allocations = _models(FeeLot, lots), _models(Allocation, allocations)
    _lot_totals(lots)
    by_id = {lot.lotId: lot for lot in lots}
    selected, grouped = {}, defaultdict(lambda: [0, 0])
    for allocation in allocations:
        if allocation.lotId in selected:
            raise ValueError('duplicate_allocation')
        if allocation.lotId not in by_id:
            raise ValueError('unknown_lot')
        lot, used = by_id[allocation.lotId], int(allocation.amountRaw)
        if used > int(lot.amountRaw) - int(lot.reservedRaw):
            raise ValueError('allocation_exceeds_available')
        selected[lot.lotId] = used
        grouped[(lot.sourceId, lot.currency)][0 if lot.chargeStatus == 'original_uncharged' else 1] += used
    groups = []
    for (source, currency), (original, charged) in sorted(grouped.items()):
        _bounded_sum(original, charged)
        fee = original * service_fee_bps // 10000
        groups.append({'sourceId': source, 'currency': currency,
                       'grossOriginalRaw': str(original), 'chargedInputRaw': str(charged),
                       'serviceFeeRaw': str(fee), 'netAvailableRaw': str(original + charged - fee)})
    remaining = [{**lot.model_dump(), 'amountRaw': str(int(lot.amountRaw) - selected.get(lot.lotId, 0))}
                 for lot in sorted(lots, key=lambda item: item.lotId)]
    return {'serviceFeeBps': service_fee_bps, 'groups': groups, 'remainingLots': remaining}


def split_swap_output(inputs, amountOutRaw):
    """Allocate actual positive output by canonical source-prefix floor deltas.

    All inputs belong to one currency/one swap. The caller binds both currencies;
    raw quantities from different input currencies must never share this vector.
    Zero-sized individual output shares are retained, and their sum is exact.
    """
    inputs = _models(SwapInput, inputs)
    output = int(_POSITIVE_AMOUNT.validate_python(amountOutRaw, strict=True))
    if not inputs:
        raise ValueError('swap_inputs_missing')
    if len({item.sourceId for item in inputs}) != len(inputs):
        raise ValueError('duplicate_swap_source')
    total = 0
    for item in inputs:
        total = _bounded_sum(total, int(item.amountInRaw))
    result, cumulative, allocated = [], 0, 0
    for item in sorted(inputs, key=lambda item: item.sourceId):
        cumulative += int(item.amountInRaw)
        through_source = output * cumulative // total
        result.append({'sourceId': item.sourceId, 'amountOutRaw': str(through_source - allocated),
                       'chargeStatus': 'converted_charged'})
        allocated = through_source
    return result


def reconcile_consumption(lots, allocations, dispositions, *, service_fee_bps, swaps=None):
    """Project per-source/per-currency dispositions from selected fee budgets.

    Every net input unit must go to direct liquidity or a declared swap; otherwise
    its original gross was not consumed and must remain uncharged. Swap output
    may go to liquidity or remain as charged residual. This initial helper permits
    independent exact-input swaps, not recycling their output into another leg in
    the same action. A route's internal hops are one terminal in/out observation.

    The conservation expression below is a derived arithmetic invariant, not
    an independent before/after observation. The operative guards are exact net
    input disposition and output overspending. A swap-only/all-residual result
    can be useful arithmetic but is NOT successful reinvestment evidence; use
    execution_receipts.reconcile_plan_effects for the plan/effect checks.

    This does not prove on-chain receipts, prices, route admission, profitability,
    intent uniqueness or execution. A reverted/ambiguous attempt supplies no
    successful consumption receipt and must not be applied by a durable caller.
    """
    lots = _models(FeeLot, lots)
    consumed = consume_allocations(lots, allocations, service_fee_bps=service_fee_bps)
    before = _lot_totals(lots)
    selected = {(row['sourceId'], row['currency']): row for row in consumed['groups']}
    remaining = _lot_totals(_models(FeeLot, consumed['remainingLots']))
    dispositions = _models(Disposition, dispositions)
    swaps = _models(SwapReceipt, [] if swaps is None else swaps)
    if len({swap.swapId for swap in swaps}) != len(swaps):
        raise ValueError('duplicate_swap_receipt')
    swap_in, swap_out, swap_records = defaultdict(int), defaultdict(int), []
    for swap in sorted(swaps, key=lambda item: item.swapId):
        outputs = split_swap_output(swap.inputs, swap.amountOutRaw)
        for item in swap.inputs:
            key = (item.sourceId, swap.currencyIn)
            swap_in[key] = _bounded_sum(swap_in[key], int(item.amountInRaw))
        for item in outputs:
            key = (item['sourceId'], swap.currencyOut)
            swap_out[key] = _bounded_sum(swap_out[key], int(item['amountOutRaw']))
        swap_records.append({**swap.model_dump(),
                             'inputs': [item.model_dump() for item in sorted(swap.inputs, key=lambda item: item.sourceId)],
                             'outputs': outputs})
    by_key = {}
    for disposition in dispositions:
        key = (disposition.sourceId, disposition.currency)
        if key in by_key:
            raise ValueError('duplicate_disposition')
        by_key[key] = disposition
    if set(by_key) != set(selected) | set(swap_in) | set(swap_out):
        raise ValueError('disposition_identity_set_mismatch')
    balances, residuals = [], []
    for source, currency in sorted(set(before) | set(by_key)):
        key = (source, currency)
        row = selected.get(key, {})
        original = int(row.get('grossOriginalRaw', 0))
        charged = int(row.get('chargedInputRaw', 0))
        fee = int(row.get('serviceFeeRaw', 0))
        net = int(row.get('netAvailableRaw', 0))
        disposition = by_key.get(key)
        direct = int(disposition.liquidityFromInputRaw) if disposition else 0
        from_swap = int(disposition.liquidityFromSwapRaw) if disposition else 0
        if direct + swap_in[key] != net:
            raise ValueError('net_input_disposition_mismatch')
        if from_swap > swap_out[key]:
            raise ValueError('swap_output_overspent')
        residual = swap_out[key] - from_swap
        liquidity_added = _bounded_sum(direct, from_swap)
        original_after, charged_after = remaining.get(key, [0, 0])
        charged_after = _bounded_sum(charged_after, residual)
        _bounded_sum(original_after, charged_after)
        original_before, charged_before = before.get(key, [0, 0])
        if (original_before + charged_before + swap_out[key] !=
                fee + direct + from_swap + swap_in[key] + original_after + charged_after):
            raise ValueError('source_currency_conservation_failure')
        balances.append({'sourceId': source, 'currency': currency,
                         'originalBeforeRaw': str(original_before), 'chargedBeforeRaw': str(charged_before),
                         'grossOriginalRaw': str(original), 'chargedInputRaw': str(charged),
                         'serviceFeeRaw': str(fee), 'liquidityAddedRaw': str(liquidity_added),
                         'swapInRaw': str(swap_in[key]), 'swapOutRaw': str(swap_out[key]),
                         'originalAfterRaw': str(original_after), 'chargedAfterRaw': str(charged_after)})
        if residual:
            residuals.append({'sourceId': source, 'currency': currency, 'amountRaw': str(residual),
                              'chargeStatus': 'converted_charged'})
    return {**consumed, 'balances': balances, 'swaps': swap_records, 'convertedResiduals': residuals}
