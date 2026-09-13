/**
 * deposit-v1's fixtures, for the lab: imported in place from api-contracts/
 * as raw text, so each reaches the fixture transport byte for byte as the
 * package ships it. Only the lab screen (consumer-test build) imports this.
 */
import type { FixtureSource } from './derive'

const RAW = import.meta.glob<string>('../../../../api-contracts/deposit-v1/fixtures/**/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
})

// Keyed relative to fixtures/, e.g. `variants/mint.json`.
const BY_PATH = new Map(Object.entries(RAW).map(([key, text]) => [key.slice(key.indexOf('fixtures/') + 'fixtures/'.length), text]))

export const LAB_FIXTURES: FixtureSource = {
  text(path) {
    const text = BY_PATH.get(path)
    if (text === undefined) throw new Error(`${path} is not a deposit-v1 fixture`)
    return text
  },
}
