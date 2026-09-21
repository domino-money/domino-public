import assert from 'node:assert/strict';

// Retain every observed hash at a height: a reorg must not erase an earlier
// sample merely because a later sample observed the replacement block.
export function observedBlocks(samples) {
  const indexed = new Map();
  for (const sample of samples) {
    if (sample.blockNumber === undefined && sample.error) continue;
    assert(Number.isSafeInteger(sample.blockNumber) && sample.blockNumber >= 0);
    assert(/^0x[0-9a-f]{64}$/i.test(sample.blockHash));
    if (!indexed.has(sample.blockNumber)) indexed.set(sample.blockNumber, new Set());
    indexed.get(sample.blockNumber).add(sample.blockHash.toLowerCase());
  }
  return [...indexed].map(([number, hashes]) => ({ number, hashes: [...hashes] }));
}

export function differsFromCanonical(observed, canonical) {
  assert(canonical && BigInt(canonical.number) === BigInt(observed.number));
  assert(/^0x[0-9a-f]{64}$/i.test(canonical.hash));
  return observed.hashes.some(hash => hash !== canonical.hash.toLowerCase());
}
