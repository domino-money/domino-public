import type { Abi, Hex } from 'viem'
import { abi as autoExitAbi, errorSelectors as autoExitErrors } from '../../../../api-contracts/v2/implementations/DominoAutoExit.json'
import { abi as vaultFactoryAbi, errorSelectors as vaultFactoryErrors } from '../../../../api-contracts/v2/implementations/DominoV2VaultFactory.json'
import { abi as vaultV3Abi, errorSelectors as vaultV3Errors } from '../../../../api-contracts/v2/implementations/DominoV2VaultV3.json'
import { abi as vaultV4Abi, errorSelectors as vaultV4Errors } from '../../../../api-contracts/v2/implementations/DominoV2VaultV4.json'
import { abi as executorV3Abi, errorSelectors as executorV3Errors } from '../../../../api-contracts/v2/implementations/DominoV2VaultExecutorV3.json'
import { abi as executorV4Abi, errorSelectors as executorV4Errors } from '../../../../api-contracts/v2/implementations/DominoV2VaultExecutorV4.json'
import { abi as swapModuleAbi, errorSelectors as swapModuleErrors } from '../../../../api-contracts/v2/implementations/DominoV2VaultSwapModule.json'

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

// Only receipt ABIs and selector checks belong in the browser; source labels and precomputed topic maps do not.
const files = {
  autoExit: { abi: autoExitAbi, errorSelectors: autoExitErrors },
  vaultFactory: { abi: vaultFactoryAbi, errorSelectors: vaultFactoryErrors },
  vaultV3: { abi: vaultV3Abi, errorSelectors: vaultV3Errors },
  vaultV4: { abi: vaultV4Abi, errorSelectors: vaultV4Errors },
  executorV3: { abi: executorV3Abi, errorSelectors: executorV3Errors },
  executorV4: { abi: executorV4Abi, errorSelectors: executorV4Errors },
  swapModule: { abi: swapModuleAbi, errorSelectors: swapModuleErrors },
}

/** A vault's logs, v3 or v4 (the two vaults' events are the same signatures; both kept, each once). */
export const VAULT_EVENTS_ABI: Abi = union(files.vaultV3, files.vaultV4, files.executorV3, files.executorV4, files.swapModule)
/** The vault factory's logs (`VaultCreated`) and errors (`InvalidInit`, `UnexpectedNonce`). */
export const VAULT_FACTORY_EVENTS_ABI: Abi = union(files.vaultFactory)
/** The auto-exit module's logs and errors. */
export const AUTO_EXIT_EVENTS_ABI: Abi = union(files.autoExit)

/** An error's selector as the contract's own file states it; throws for a signature the contract does not declare. */
export function implementationErrorSelector(contract: keyof typeof files, signature: string): Hex {
  const file: ImplementationFile = files[contract]
  const selector = file.errorSelectors[signature]
  if (typeof selector !== 'string' || !/^0x[0-9a-f]{8}$/.test(selector)) throw new Error(`implementation_error_unknown:${contract}:${signature}`)
  return selector as Hex
}
