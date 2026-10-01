#!/usr/bin/env node
// CI restores the Forge cache of an earlier source tree when no exact match
// exists (restore-keys in ci.yml). Forge recompiles a changed source when a
// build reaches it, but it never deletes the artifacts of a removed source or
// contract, and a per-suite build leaves stale sources outside its closure
// untouched. contracts/out would still serve those artifacts to the size
// check, the release manifest and the backend EVM tests.
//
// `prune` runs before the first build. It drops every cached source whose
// content differs from the checkout, every source that imports one, and their
// artifacts, so what remains is what a cold build would produce. `record` runs
// last in a successful job and stores the content each cached source was built
// from. A cache without a record is discarded whole.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CACHE_FILE = 'cache/solidity-files-cache.json';
export const RECORD_FILE = 'cache/domino-source-hashes.json';
const contractsRoot = fileURLToPath(new URL('../contracts/', import.meta.url));

const contentHash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

/** Store the content each cached source was built from; returns how many. */
export function recordSources(root = contractsRoot) {
  const { files } = readJson(path.join(root, CACHE_FILE));
  const hashes = {};
  for (const source of Object.keys(files).sort()) {
    const file = path.join(root, source);
    if (existsSync(file)) hashes[source] = contentHash(file);
  }
  writeFileSync(path.join(root, RECORD_FILE), JSON.stringify(hashes, null, 1) + '\n');
  return Object.keys(hashes).length;
}

/** Drop what the checkout invalidates; returns the dropped sources, or null for a cold start. */
export function pruneCache(root = contractsRoot) {
  const cacheFile = path.join(root, CACHE_FILE);
  const recordFile = path.join(root, RECORD_FILE);
  if (!existsSync(cacheFile) || !existsSync(recordFile)) {
    for (const directory of ['cache', 'out']) rmSync(path.join(root, directory), { recursive: true, force: true });
    return null;
  }
  const cache = readJson(cacheFile);
  const recorded = readJson(recordFile);
  const importers = new Map();
  for (const [source, entry] of Object.entries(cache.files))
    for (const imported of entry.imports ?? []) importers.set(imported, [...(importers.get(imported) ?? []), source]);
  const queue = Object.keys(cache.files).filter(source => {
    const file = path.join(root, source);
    return !existsSync(file) || recorded[source] !== contentHash(file);
  });
  const dropped = new Set(queue);
  while (queue.length > 0)
    for (const importer of importers.get(queue.pop()) ?? [])
      if (!dropped.has(importer)) { dropped.add(importer); queue.push(importer); }
  const out = path.join(root, cache.paths?.artifacts ?? 'out');
  for (const source of dropped) {
    for (const versions of Object.values(cache.files[source].artifacts ?? {}))
      for (const profiles of Object.values(versions))
        for (const { path: artifact } of Object.values(profiles)) {
          const file = path.join(out, artifact);
          rmSync(file, { force: true });
          const directory = path.dirname(file);
          if (existsSync(directory) && readdirSync(directory).length === 0) rmSync(directory, { recursive: true });
        }
    delete cache.files[source];
  }
  writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  // Until `record` runs again, this cache no longer proves what it was built from.
  rmSync(recordFile);
  return [...dropped].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  try {
    if (command === 'prune') {
      const dropped = pruneCache();
      console.log(dropped === null ? 'Forge cache: none restored or unrecorded; building cold.'
        : `Forge cache: dropped ${dropped.length} stale source(s)${dropped.length ? `:\n  ${dropped.join('\n  ')}` : '.'}`);
    } else if (command === 'record') {
      console.log(`Forge cache: recorded ${recordSources()} source(s).`);
    } else throw new Error('usage: forge-cache.mjs prune|record');
  } catch (error) { console.error(`Forge cache: ${error.message}`); process.exitCode = 1; }
}
