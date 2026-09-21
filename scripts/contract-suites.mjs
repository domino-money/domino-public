// Lightweight discovery: no launcher or gas-baseline imports, so either can use
// this module without creating a cycle. Vendored dependency tests are excluded.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const contracts = fileURLToPath(new URL('../contracts/', import.meta.url));

export function listContractSuites(directory = path.join(contracts, 'test'), relativeTo = contracts) {
  const found = [];
  const walk = folder => {
    for (const name of readdirSync(folder).sort()) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) {
        if (name !== 'official-v4') walk(full);
      } else if (name.endsWith('.t.sol')) found.push(path.relative(relativeTo, full));
    }
  };
  walk(directory);
  return found;
}
