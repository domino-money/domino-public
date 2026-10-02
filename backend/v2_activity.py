"""What one transaction's Domino V2 events mean, per wallet: the activity items.

The indexer commits whole blocks, so every event of a transaction arrives in
the same range. Each transaction's events are cut into items, and each event
belongs to at most one item. An item is one receipt a wallet sees:

- s1_action: one zap action (F2). The zap emits its receipt lines (inputs,
  swap legs, the fee, position steps, refunds) and ends every action with
  PositionActionExecuted, so an action is the zap's events since the previous
  one. Wallets: the action's owner (the position steps name it) and the
  recipient.
- zap_event: a zap event outside an action (relayed-nonce invalidation).
- vault_created: VaultCreated and the new vault's initialization events,
  which come first in the same transaction. Wallet: the owner.
- vault_execution: one operator execution (F3), the vault's events up to its
  Executed: fees collected, the swap and its legs, the tariff, the compound.
- auto_exit: one mandate executed (F4): the module's events up to its
  MandateExecuted (the fee, the conversion legs, deferred deliveries) and the
  vault's exit events in the same window (ExitExecuted, the root disarmed or
  the successor retired, reserves returned). Wallet: the mandate's owner, the
  one recipient the module delivers to.
- auto_exit_event: a mandate registered or revoked, a nonce cancelled, a
  credit claimed.
- vault_event: the vault's other events in the transaction: owner actions
  (policy, limits, pause, resume, rearm, withdrawals, recovery, exit module,
  exitAll) and custody changes (a v4 notification, a failed custody check).
  Wallet: the vault's owner.

Events that move fees or positions (FeesCollected, Swapped, Compounded,
SuccessorCreated, the tariff, swap legs) only ever happen inside an execution,
an exit or an action. If one arrives outside, the model of the contracts is
wrong and the range is refused (v2_receipt_unanchored), never filed under a
guess. Flushes of owed fees concern the fee recipient, not a wallet: no item.

The same pass names the positions the events are about, for the snapshot
reader: vault roots and successors, and the positions S1 actions created or
changed.
"""
from dataclasses import dataclass, field

from discovery import DataError

EXECUTION_ONLY = frozenset({'FeesCollected', 'Swapped', 'SwapLegExecuted', 'Compounded', 'SuccessorCreated',
                            'FeeCharged', 'FeeDeferred'})
EXECUTION_PARTS = EXECUTION_ONLY | {'RootCheckpointed'}
ZAP_ACTION_PARTS = frozenset({'InputPulled', 'SwapLegExecuted', 'FeeCharged', 'FeeDeferred',
                              'PositionLiquidityChanged', 'Refunded'})
EXIT_PARTS = frozenset({'FeeCharged', 'FeeDeferred', 'SwapLegExecuted', 'DeliveryDeferred'})
MANDATE_EVENTS = frozenset({'MandateRegistered', 'MandateRevoked', 'NonceCancelled', 'Claimed'})
# Events that concern the vault's root without naming it.
ROOT_EVENTS = frozenset({'RootDisarmed', 'RootRearmed', 'RootCheckpointed', 'Initialized'})


@dataclass
class Item:
    kind: str
    anchor: object  # the DecodedLog the item ends with
    wallets: tuple
    address: str  # the emitter the item belongs to
    vault: str | None
    ref: str | None
    logs: list = field(default_factory=list)


@dataclass(frozen=True)
class PositionSeen:
    dex: int
    token_id: int
    source: str  # vault_root, vault_successor, s1
    vault: str | None
    wallet: str
    block_number: int


class Context:
    """What deriving needs beyond the transaction: vaults and mandates already
    indexed (or created in the same range), the module and the zaps."""
    def __init__(self, *, vault, mandate, auto_exit, zap_dex):
        self.vault = vault  # address -> (owner, dex, root token id) or None
        self.mandate = mandate  # hash -> (owner, vault) or None
        self.auto_exit = auto_exit
        self.zap_dex = zap_dex  # address -> dex


def _unanchored():
    return DataError('v2_receipt_unanchored')


def _owner_of_action(segment, anchor):
    for log in segment:
        if log.event == 'PositionLiquidityChanged':
            return log.args['owner']
    for log in segment:
        if log.event == 'InputPulled':
            return log.args['owner']
        if log.event == 'FeeCharged':
            return log.args['payer']
    return anchor.args['recipient']


def _wallets(*values):
    seen = []
    for value in values:
        if value is not None and value not in seen:
            seen.append(value)
    return tuple(seen)


def derive_transaction(logs, ctx):
    """Items for one transaction's logs (DecodedLog, all of one tx), in log order."""
    logs = sorted(logs, key=lambda log: log.log_index)
    if len({log.tx_hash for log in logs}) > 1:
        raise DataError('v2_mixed_transaction')
    items, claimed = [], set()

    def by(emitter):
        return [log for log in logs if log.emitter == emitter and log.log_index not in claimed]

    # S1 actions: each ends with PositionActionExecuted.
    for zap in sorted({log.address for log in by('zap')}):
        segment = []
        for log in [entry for entry in by('zap') if entry.address == zap]:
            if log.event == 'PositionActionExecuted':
                part = segment + [log]
                owner = _owner_of_action(segment, log)
                items.append(Item('s1_action', log, _wallets(owner, log.args['recipient']), zap, None,
                                  log.args['intentHash'], part))
                claimed.update(entry.log_index for entry in part)
                segment = []
            elif log.event == 'NoncesInvalidated':
                items.append(Item('zap_event', log, (log.args['owner'],), zap, None, None, [log]))
                claimed.add(log.log_index)
            elif log.event == 'OwedFeesFlushed':
                claimed.add(log.log_index)
            elif log.event in ZAP_ACTION_PARTS:
                segment.append(log)
            else:
                raise _unanchored()
        if segment:
            raise _unanchored()

    # Auto-exit: each execution ends with MandateExecuted; the vault's exit
    # events lie in the same window, before it.
    for module in sorted({log.address for log in by('auto_exit')}):
        segment, window_start = [], -1
        for log in [entry for entry in by('auto_exit') if entry.address == module]:
            if log.event == 'MandateExecuted':
                exits = [entry for entry in logs if entry.emitter == 'vault' and entry.event == 'ExitExecuted'
                         and entry.args['module'] == module and window_start < entry.log_index < log.log_index]
                if len(exits) != 1:
                    raise _unanchored()
                vault = exits[0].address
                vault_part = [entry for entry in logs if entry.address == vault and entry.log_index not in claimed
                              and window_start < entry.log_index <= exits[0].log_index]
                part = sorted(segment + vault_part + [log], key=lambda entry: entry.log_index)
                items.append(Item('auto_exit', log, (log.args['recipient'],), module, vault,
                                  log.args['mandateHash'], part))
                claimed.update(entry.log_index for entry in part)
                segment, window_start = [], log.log_index
            elif log.event in MANDATE_EVENTS:
                if log.event == 'MandateRevoked':
                    known = ctx.mandate(log.args['mandateHash'])
                    if known is None:
                        raise DataError('v2_mandate_unknown')
                    owner, vault = known
                else:
                    owner, vault = log.args['owner'], log.args.get('vault')
                items.append(Item('auto_exit_event', log, (owner,), module, vault,
                                  log.args.get('mandateHash'), [log]))
                claimed.add(log.log_index)
            elif log.event == 'OwedFeesFlushed':
                claimed.add(log.log_index)
            elif log.event in EXIT_PARTS:
                segment.append(log)
            else:
                raise _unanchored()
        if segment:
            raise _unanchored()

    # Vault creation: the factory's VaultCreated after the vault's initialization.
    for log in by('vault_factory'):
        vault = log.args['vault']
        init = [entry for entry in logs if entry.address == vault and entry.log_index < log.log_index
                and entry.log_index not in claimed]
        if not any(entry.event == 'Initialized' for entry in init):
            raise _unanchored()
        part = init + [log]
        items.append(Item('vault_created', log, (log.args['owner'],), log.address, vault, None, part))
        claimed.update(entry.log_index for entry in part)

    # Executions and the vault's other events.
    for vault in sorted({log.address for log in by('vault')}):
        known = ctx.vault(vault)
        if known is None:
            raise DataError('v2_vault_unknown')
        owner = known[0]
        pending = []
        for log in [entry for entry in by('vault') if entry.address == vault]:
            if log.event == 'Executed':
                part = [entry for entry in pending if entry.event in EXECUTION_PARTS] + [log]
                items.append(Item('vault_execution', log, (owner,), vault, vault, log.args['planHash'], part))
                claimed.update(entry.log_index for entry in part)
                pending = [entry for entry in pending if entry.event not in EXECUTION_PARTS]
            else:
                pending.append(log)
        rest = [entry for entry in pending if entry.event != 'OwedFeesFlushed']
        claimed.update(entry.log_index for entry in pending if entry.event == 'OwedFeesFlushed')
        if any(entry.event in EXECUTION_ONLY for entry in rest):
            raise _unanchored()
        if rest:
            items.append(Item('vault_event', rest[-1], (owner,), vault, vault, None, rest))
            claimed.update(entry.log_index for entry in rest)

    items.sort(key=lambda item: item.anchor.log_index)
    return items


def positions_seen(logs, ctx):
    """The positions a range's logs name, and the (dex, token id, block) of
    every position an event touched.

    A position is attributed once, by the strongest sighting in the range: a
    vault root, then a successor, then the recipient of the S1 action that
    created it (create, change of range), then the owner of an S1 step.
    """
    best, touched = {}, set()
    rank = {'vault_root': 0, 'vault_successor': 1, 's1_new': 2, 's1': 3}

    def add(dex, token_id, source, vault, wallet, block):
        if dex is None or not token_id:
            return
        touched.add((dex, token_id, block))
        key = (dex, token_id)
        if key not in best or rank[source] < rank[best[key][0]]:
            best[key] = (source, PositionSeen(dex, token_id, 's1' if source == 's1_new' else source, vault, wallet,
                                              best[key][1].block_number if key in best else block))

    for log in sorted(logs, key=lambda entry: (entry.block_number, entry.log_index)):
        a, block = log.args, log.block_number
        if log.emitter == 'vault_factory':
            add(a['dex'], a['rootTokenId'], 'vault_root', a['vault'], a['owner'], block)
        elif log.emitter == 'vault':
            known = ctx.vault(log.address)
            if known is None:
                raise DataError('v2_vault_unknown')
            owner, dex, root = known
            if log.event == 'SuccessorCreated':
                add(dex, a['tokenId'], 'vault_successor', log.address, owner, block)
                touched.add((dex, a['parentTokenId'], block))
            elif log.event in ROOT_EVENTS:
                touched.add((dex, root, block))
            for name in ('tokenId', 'source'):
                if name in a and type(a[name]) is int and a[name]:
                    touched.add((dex, a[name], block))
        elif log.emitter == 'zap':
            dex = ctx.zap_dex.get(log.address)
            if log.event == 'PositionActionExecuted':
                created = a['action'] in (1, 3)  # create, change of range: the NFT is the recipient's
                add(dex, a['tokenId'], 's1_new' if created else 's1', None, a['recipient'], block)
                if a['previousTokenId']:
                    touched.add((dex, a['previousTokenId'], block))
            elif log.event == 'PositionLiquidityChanged':
                add(dex, a['tokenId'], 's1', None, a['owner'], block)
    return [entry for _, entry in best.values()], touched
