import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from '../../components/icons'
import { Button, KeyValue } from '../../components/ui'
import { useWalletIdentity } from '../../lib/walletIdentity'
import type { WalletPosition } from '../../lib/walletPositions'
import type { V2Gate } from '../../v2/gate'
import { useHealingGate } from '../automate/gate'
import { ApprovalFact, useZapApproval } from './Approval'
import { HOOKED_COPY } from './constants'
import { COPY } from './copy'
import { hookedPool } from './model'
import { autoExitRootOf, findPosition, fromWalletPosition, heldInPoolOrder, positionVault, tokensOfWalletPosition, vaultReservesOf, type ActionPosition, type VaultReserves } from './model'
import { MoreActions, positionMenuItems, type MoreAction } from './MoreActions'
import { PositionDialog, type PositionMode } from './PositionDialog'
import { portfolioFor } from './source'
import { tokenBook } from './tokens'
import type { OpenGate } from './wallet'

/** What V1's position page hands its one Domino V2 mount (screens/PositionDetail.tsx states the same shape). */
export interface PositionV2ActionsProps {
  /** The page's own chain read of the NFT (Robinhood Chain, v4). */
  position: WalletPosition
  /** The NFT's owner at that read, lowercase (the page mounts this only for the connected owner). */
  owner: string
  /** The page reads again after an action, with the block it was included in when known (V1's onChanged). */
  onChanged: (block?: bigint) => void
  /**
   * (QA round 2, N49) Whether read-v6 lists this position as the root of Auto-exit's own vault (../autoexit/standing.ts
   * exitVaultOf), for V1's Collect fees and Close position: false until known, and for any other position.
   */
  onAutoExitRoot?: (root: boolean) => void
  /**
   * Added 2026-11-09 (the core-flows fix): the connected wallet (lowercase), when it is not the NFT's holder: the page
   * then offers Close position only for a position Domino-compound holds for this wallet (its successor, held by the
   * wallet's own automation), withdrawn from the automation first; nothing else. Absent: the holder is the wallet.
   */
  wallet?: string
  /**
   * Added 2026-11-09 (the core-flows fix): V1's Close position hands its press here while the position is an automation's
   * main position (read-v6), so that close runs as the one guided flow (./CloseSteps.tsx: it turns the automation off,
   * then returns the fees it still holds); null otherwise, V1's own dialog then.
   */
  onCloseFlow?: (open: (() => void) | null) => void
}

/**
 * The gate for S1 on Robinhood Chain (null while it is asked). Changed on purpose 2026-11-09 (the core-flows fix, item a):
 * asked again by itself while it is not live (../automate/gate.tsx useHealingGate); it was asked once per page, and a
 * passing failure of its probe locked every action here until a reload.
 */
const useS1Gate = (chainId: number): V2Gate | null => useHealingGate('s1', chainId)

/**
 * Domino V2 on V1's position page (the owner, 2026-10-02: V2 is an integration into the screens that exist; 2026-10-03:
 * one row, few buttons): at the end of V1's own actions row, one "···" button (./MoreActions.tsx) with "Add liquidity",
 * "Change range" and "Withdraw" (all or part, in both tokens or in one), each in the page's own action dialog, and in
 * the page's Details "Domino can manage this position for you when you ask." with "Revoke" while Domino's zap holds the
 * NFT's approval. A position a vault holds (its successor) gets one sentence in the row instead of the button. Nothing
 * at all when the gate is `off` (production, development, any origin but the preview alias and the dev server): the
 * page is V1's, byte for byte in the builds without V2.
 *
 * Under `live`, read-v6 tells whether a Domino vault administers the position (decision #5: "Change range" is blocked on
 * an armed root, the other actions ask for the pause warning; the reserves an exit leaves behind are named); the money
 * clients read the chain again before any send in any case.
 */
export default function PositionV2Actions({ position, owner, onChanged, onAutoExitRoot, wallet, onCloseFlow }: PositionV2ActionsProps) {
  const gate = useS1Gate(4663)
  const open: OpenGate | null = gate && gate.mode !== 'off' ? gate : null
  const identity = useWalletIdentity()
  const walletOnChain = identity.kind === 'connected' && identity.chainId === 4663
  const base = useMemo(() => fromWalletPosition(position, owner), [position, owner])
  // (2026-11-09) Whose portfolio says what automation holds this position: the connected wallet's.
  const viewer = (wallet ?? owner).toLowerCase()
  const held = viewer !== owner.toLowerCase()
  const book = useMemo(() => tokenBook(4663, tokensOfWalletPosition(position)), [position])
  const [vaultInfo, setVaultInfo] = useState<{ vault: ActionPosition['vault']; reserves: VaultReserves | null; exitRoot: boolean } | null>(null)
  const [mode, setMode] = useState<PositionMode | null>(null)
  const action: ActionPosition | null = base ? { ...base, vault: vaultInfo?.vault ?? null } : null
  const approval = useZapApproval(open, held ? null : action, walletOnChain)

  // Under live only: whether a Domino vault administers this position, from read-v6 (before the deploy no vault exists).
  const tokenId = base?.tokenId ?? null
  // Whether the page's automation panel can turn Auto-exit on for it (../autoexit/entry.ts).
  useEffect(() => {
    if (!open || open.mode !== 'live' || tokenId === null) return
    let alive = true
    void portfolioFor(open, viewer).then((read) => {
      if (!alive || read.reply.kind !== 'ok') return
      const found = findPosition(read.reply.body, 4663, 4, tokenId)
      const vault = found?.vault ?? null
      setVaultInfo({
        vault: positionVault(read.reply.body, 4663, vault),
        reserves: vault ? vaultReservesOf(read.reply.body, 4663, vault.address) : null,
        exitRoot: autoExitRootOf(read.reply.body, 4663, vault),
      })
    }, () => undefined)
    return () => {
      alive = false
    }
  }, [open, viewer, tokenId])

  const exitRoot = vaultInfo?.exitRoot ?? false
  useEffect(() => {
    onAutoExitRoot?.(exitRoot)
  }, [exitRoot, onAutoExitRoot])
  // (2026-11-09) An automation's main position in the wallet: V1's Close position opens this page's guided close instead.
  const automationRoot = !held && open !== null && vaultInfo?.vault?.role === 'root'
  useEffect(() => {
    onCloseFlow?.(automationRoot ? () => setMode('close') : null)
    return () => onCloseFlow?.(null)
  }, [automationRoot, onCloseFlow])
  // (2026-11-09) A position Domino-compound holds for this wallet: the vault holding the NFT is the wallet's own.
  const successorOfMine = held && vaultInfo?.vault?.role === 'successor' && vaultInfo.vault.address === owner.toLowerCase()

  // The "···" button goes to the end of V1's own actions row, and the approval fact into the page's own Details list (one
  // mount point on the page: this component's), both found from this component's place once it is drawn.
  const [facts, setFacts] = useState<Element | null>(null)
  const [row, setRow] = useState<Element | null>(null)
  const anchor = useCallback((node: HTMLSpanElement | null) => {
    const detail = node?.closest('[data-position-detail]') ?? null
    setFacts(detail?.querySelector('[data-position-details] .dm-pos-facts') ?? null)
    setRow(detail?.querySelector('[data-position-action-tools]') ?? detail?.querySelector('[data-position-actions]') ?? null)
  }, [])

  if (!open || !action) return null
  if (held) {
    // Added 2026-11-09 (the core-flows fix): no row of V1's is drawn for a position the wallet does not hold; Close position
    // stands where that row would, alone, for a position the wallet's Domino-compound holds. It had no Close at all.
    if (!successorOfMine || action.liquidity === 0n) return null
    const hooked = hookedPool(action.pool)
    return (
      <>
        <div className="dm-pos-actions" data-position-actions="" data-position-v2-held="successor">
          <Button type="button" variant="danger" disabled={hooked} title={hooked ? HOOKED_COPY : undefined} aria-haspopup="dialog" aria-expanded={mode === 'close'} data-position-action="close" onClick={() => setMode('close')}>
            <IconClose size={18} /><span>{COPY.title.close}</span>
          </Button>
        </div>
        {mode === 'close' && (
          <PositionDialog gate={open} position={action} mode="close" book={book} reserves={vaultInfo?.reserves ?? null} onClose={() => setMode(null)} onDone={(block) => onChanged(block)} />
        )}
      </>
    )
  }
  // The entries (./MoreActions.tsx); a vault's successor has none: its sentence, and no button. Auto-exit opens the
  // automation panel's own dialog; the others, this page's action dialog.
  const items = positionMenuItems(action, false)
  const pick = (key: MoreAction['key']) => { if (key !== 'protect') setMode(key) }
  const available = heldInPoolOrder(position, action.pool.currency0)
  return (
    <>
      {/* Where this component sits (after V1's row): unseen; the button itself goes into V1's row. */}
      <span ref={anchor} hidden data-position-v2-mount={open.mode} />
      {row && items.length > 0 && createPortal(<MoreActions id={`position-v2-more-${action.tokenId}`} items={items} onPick={pick} data-position-v2-actions={open.mode} />, row)}
      {mode && (
        <PositionDialog
          gate={open}
          position={action}
          mode={mode}
          book={book}
          reserves={vaultInfo?.reserves ?? null}
          available={available}
          onClose={() => setMode(null)}
          onDone={(block) => onChanged(block)}
        />
      )}
      {facts && createPortal(
        <>
          {action.vault && (
            <KeyValue label={COPY.page.custody}>
              <span data-position-custody={action.vault.role}>{action.vault.role === 'root' ? COPY.custody.root : COPY.custody.successor}</span>
            </KeyValue>
          )}
          <ApprovalFact approval={approval} />
        </>,
        facts,
      )}
    </>
  )
}
