"""Every vault the deployment's factory creates, admitted without a restart.

The factory keeps no list of its vaults, only `isVault`; each creation emits
VaultCreated(owner, sequenceId, vault, ownerNonce, implementation). The serve
loop reads those events from the configured first block to a few blocks below
the head, a bounded span per read, and admits each vault beside the
configuration's own sequences, in the order the chain created them, up to a
ceiling. The owner's decision of 26 September 2026: automation for every
sequence created on the site.

An event only proposes a vault. Every evaluation derives the vault's admission
on chain at the block it reads (derive_admission checks its code, factory,
owner and implementation), so a vault whose event a reorganization removed is
refused there and nothing is signed for it. The node answers the whole range
since the release in one bloom-indexed read, so a restart simply reads it again.
"""
from eth_hash.auto import keccak

import general_compound_receipts as g
from automation_config import SequenceAdmission
from automation_observer import ObservationError

TOPIC = '0x' + keccak(b'VaultCreated(address,bytes32,address,uint256,address)').hex()


def _address(word):
    """An address ABI-encoded in one 32-byte word of 64 hex digits, as a topic or a data word carries it."""
    if word[:24] != '0' * 24:
        raise ObservationError('discovery_log_invalid')
    return '0x' + word[24:].lower()


class FactoryDiscovery:
    def __init__(self, config):
        self.config, self.policy = config, config.discovery
        self.cursor = self.policy.fromBlock - 1 if self.policy else None
        self.found = []

    def admitted(self):
        """The configuration's sequences, then the discovered ones, which scan never repeats."""
        return [*self.config.sequences, *self.found]

    def scan(self, reader, *, max_logs):
        """Read VaultCreated up to `confirmations` below the head. The cursor moves
        only past a span read whole, so a failed read is read again next time."""
        result = {'admitted': [], 'leftOut': 0}
        if self.policy is None:
            return result
        target = reader.head()['number'] - self.policy.confirmations
        while self.cursor < target:
            start, end = self.cursor + 1, min(target, self.cursor + self.policy.maxBlocksPerScan)
            logs = reader.logs({'address': self.config.deployment.factory, 'topics': [TOPIC],
                                'fromBlock': hex(start), 'toBlock': hex(end)}, max_logs=max_logs)
            entries = [self._entry(log, start, end) for log in logs]
            for entry in entries:
                if entry is None or entry in self.found or any(
                        (entry.owner, entry.vault) == (s.owner, s.vault) for s in self.config.sequences):
                    continue
                if len(self.admitted()) >= self.policy.maxSequences:
                    result['leftOut'] += 1
                    continue
                self.found.append(entry)
                result['admitted'].append(entry)
            self.cursor = end
        return result

    def _entry(self, log, start, end):
        """The admission a VaultCreated log proposes; None for another implementation's vault."""
        deployment = self.config.deployment
        try:
            topics, data = log['topics'], log['data']
            if not (type(log['address']) is str and log['address'].lower() == deployment.factory
                    and log['removed'] is False and type(topics) is list and len(topics) == 4
                    and all(type(topic) is str and len(topic) == 66 and topic[:2] == '0x' for topic in topics)
                    and topics[0].lower() == TOPIC and start <= g._quantity(log['blockNumber']) <= end
                    and type(data) is str and len(data) == 2 + 128 and data[:2] == '0x'):
                raise ValueError('discovery_log_invalid')
            # A vault of another implementation is not this release's to automate.
            if _address(data[66:]) != deployment.implementation:
                return None
            return SequenceAdmission(owner=_address(topics[1][2:]), vault=_address(topics[3][2:]),
                                     expiresAt=self.policy.expiresAt, suspended=False)
        except (KeyError, TypeError, ValueError):
            raise ObservationError('discovery_log_invalid') from None
