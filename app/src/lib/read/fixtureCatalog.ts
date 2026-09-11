/**
 * rugged97's read-v1 fixtures, as the fixture source needs them.
 *
 * Imported in place from api-contracts/ as raw text, so a fixture reaches the
 * pipeline byte for byte as the package ships it. Only the fixture build and
 * the read lab import this module.
 */
import index from 'api-contracts/read-v1/fixtures/index.json'
import type { FixtureCatalog } from './fixtureSource'

const RAW = import.meta.glob<string>('../../../../api-contracts/read-v1/fixtures/{gateway,error,invalid,requests}/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
})

// Keyed the way fixtures/index.json names files: `fixtures/<kind>/<name>.json`.
const BY_PATH = new Map(Object.entries(RAW).map(([key, text]) => [key.slice(key.indexOf('fixtures/')), text]))

export const FIXTURE_CATALOG: FixtureCatalog = {
  index,
  text(path) {
    const text = BY_PATH.get(path)
    if (text === undefined) throw new Error(`${path} is not a read-v1 fixture`)
    return text
  },
}
