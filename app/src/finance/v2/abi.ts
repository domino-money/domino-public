import type { Abi } from 'viem'
import positionActions from '../../../../api-contracts/v2/abi/IDominoPositionActions.json'
import zap from '../../../../api-contracts/v2/abi/IDominoZap.json'
import vault from '../../../../api-contracts/v2/abi/IDominoVault.json'
import vaultLedger from '../../../../api-contracts/v2/abi/IDominoVaultLedger.json'
import vaultFactory from '../../../../api-contracts/v2/abi/IDominoVaultFactory.json'
import autoExit from '../../../../api-contracts/v2/abi/IDominoAutoExit.json'
import autoExitExtension from '../../../../api-contracts/v2/abi/IDominoAutoExitExtension.json'
import registry from '../../../../api-contracts/v2/abi/IDominoRegistry.json'
import permit2 from '../../../../api-contracts/v2/abi/IPermit2Signature.json'
import v4PositionManager from '../../../../api-contracts/v2/abi/IV4PositionManagerMinimal.json'
import v3PositionManager from '../../../../api-contracts/v2/abi/IUniswapV3PositionManagerMinimal.json'

/**
 * The ABIs the V2 money clients encode their calls with: Domino's exported interfaces (api-contracts/v2/abi, imported
 * at build time, never redeclared), plus the few standard items those exports do not carry (D7): ERC-20's allowance
 * and approve, ERC-721's individual approve, and Permit2's invalidateUnorderedNonces. tests/v2/abi.test.mjs checks
 * every selector the spec names against these.
 *
 * Approvals are exact, always: an ERC-20 approval names the amount a step pulls, an NFT approval names one tokenId
 * (never setApprovalForAll), and a revoke is approve(address(0), tokenId).
 */

/** The zap (`zap.v3` and `zap.v4` share it): the four actions in their three consents, nonces, and its checks. */
export const ZAP_ABI = [...positionActions.abi, ...zap.abi] as unknown as Abi
/**
 * Changed on purpose (data) 2026-10-02 (Domino V2 integration, spec rev4 §5.6, #311 d1ad6c41): IDominoVaultLedger's
 * `returnReserves() returns (uint256 amount0, uint256 amount1)`, 0x8192ff3b. The ledger's export in this tree predates
 * #311; this is the exact item of #311's export, added only while the export lacks it, so the merge of main's export
 * (which carries it) leaves one item, never two. tests/v2/abi.test.mjs checks the selector.
 */
const RETURN_RESERVES = { type: 'function', name: 'returnReserves', stateMutability: 'nonpayable', inputs: [], outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }] } as const
const ledgerItems = vaultLedger.abi as readonly { type: string; name?: string }[]
export const VAULT_ABI = [...vault.abi, ...vaultLedger.abi, ...(ledgerItems.some((item) => item.type === 'function' && item.name === 'returnReserves') ? [] : [RETURN_RESERVES])] as unknown as Abi
export const VAULT_FACTORY_ABI = vaultFactory.abi as unknown as Abi
export const AUTO_EXIT_ABI = [...autoExit.abi, ...autoExitExtension.abi] as unknown as Abi
export const REGISTRY_ABI = registry.abi as unknown as Abi

/** Permit2's SignatureTransfer as the app uses it: the nonce bitmap, and cancelling unused nonces. */
export const PERMIT2_ABI = [
  ...permit2.abi,
  { name: 'invalidateUnorderedNonces', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'wordPos', type: 'uint256' }, { name: 'mask', type: 'uint256' }], outputs: [] },
] as unknown as Abi

/** An ERC-20 as the clients touch it: the allowance read, the exact approve, the balance. */
export const ERC20_ABI = [
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

/** Uniswap's position managers (v4 PositionManager, v3 NonfungiblePositionManager), with ERC-721's individual approve. */
const approveOne = { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [] } as const
export const V4_POSITION_MANAGER_ABI = [...v4PositionManager.abi, approveOne] as unknown as Abi
export const V3_POSITION_MANAGER_ABI = [...v3PositionManager.abi, approveOne] as unknown as Abi
