import type { Abi, Hex } from 'viem'
import autoExit from '../../../../api-contracts/v2/implementations/DominoAutoExit.json'
import vaultFactory from '../../../../api-contracts/v2/implementations/DominoV2VaultFactory.json'
import vaultV3 from '../../../../api-contracts/v2/implementations/DominoV2VaultV3.json'
import vaultV4 from '../../../../api-contracts/v2/implementations/DominoV2VaultV4.json'
import executorV3 from '../../../../api-contracts/v2/implementations/DominoV2VaultExecutorV3.json'
import executorV4 from '../../../../api-contracts/v2/implementations/DominoV2VaultExecutorV4.json'
import swapModule from '../../../../api-contracts/v2/implementations/DominoV2VaultSwapModule.json'

/**
 * The events and errors of the deployable V2 contracts (api-contracts/v2/implementations, PR #308: D7 resolved), for
 * decoding receipts and reverts. The exported interfaces (./abi.ts) encode the calls; they do not carry every event a
 * contract emits (the vault's `Executed`, `FeeCharged`, `FeeDeferred`, `OwedFeesFlushed`, `SwapLegExecuted`; the auto-exit
 * module's `FeeCharged`, `FeeDeferred`, `SwapLegExecuted`…), so a receipt is decoded with what the contract itself
 * declares, per component as the package's index.json maps them:
 * `vault.v3` / `vault.v4` = the vault, its executor and its swap module (their logs carry the vault's address);
 * `vaultFactory.*` = DominoV2VaultFactory; `autoExit` = DominoAutoExit. Imported at build time, never redeclared.
 * Added on purpose (data) 2026-10-02 (Domino V2 rev2, item 5 of the automation screens' brief).
 */

type Item = { type: string; name?: string; inputs?: readonly { type: string }[] }
interface ImplementationFile { abi: readonly Item[]; errorSelectors: Readonly<Record<string, string>> }

/** The events and errors of several contracts, each signature once. */
function union(...files: readonly ImplementationFile[]): Abi {
  const seen = new Set<string>()
  const out: Item[] = []
  for (const file of files) {
    for (const item of file.abi) {
      if (item.type !== 'event' && item.type !== 'error') continue
      const key = `${item.type}:${item.name}(${(item.inputs ?? []).map((input) => input.type).join(',')})`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return Object.freeze(out) as unknown as Abi
}

const files = {
  autoExit: autoExit as unknown as ImplementationFile,
  vaultFactory: vaultFactory as unknown as ImplementationFile,
  vaultV3: vaultV3 as unknown as ImplementationFile,
  vaultV4: vaultV4 as unknown as ImplementationFile,
  executorV3: executorV3 as unknown as ImplementationFile,
  executorV4: executorV4 as unknown as ImplementationFile,
  swapModule: swapModule as unknown as ImplementationFile,
}

/** A vault's logs, v3 or v4 (the two vaults' events are the same signatures; both kept, each once). */
export const VAULT_EVENTS_ABI: Abi = union(files.vaultV3, files.vaultV4, files.executorV3, files.executorV4, files.swapModule)
/** The vault factory's logs (`VaultCreated`) and errors (`InvalidInit`, `UnexpectedNonce`). */
export const VAULT_FACTORY_EVENTS_ABI: Abi = union(files.vaultFactory)
/** The auto-exit module's logs and errors. */
export const AUTO_EXIT_EVENTS_ABI: Abi = union(files.autoExit)

/** An error's selector as the contract's own file states it; throws for a signature the contract does not declare. */
export function implementationErrorSelector(contract: keyof typeof files, signature: string): Hex {
  const selector = files[contract].errorSelectors[signature]
  if (typeof selector !== 'string' || !/^0x[0-9a-f]{8}$/.test(selector)) throw new Error(`implementation_error_unknown:${contract}:${signature}`)
  return selector as Hex
}
