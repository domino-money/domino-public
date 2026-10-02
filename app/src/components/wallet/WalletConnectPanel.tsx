import { useEffect, useState, useSyncExternalStore } from 'react'
import { pairingLink, pairingQr, subscribePairing } from '../../wallet/walletConnect'
import { Button } from '../ui'
import { WALLETCONNECT } from './copy'

/**
 * WalletConnect's pairing, drawn by the page itself (2026-10-01, audit C3): no modal of WalletConnect's and no wallet
 * list fetched from anywhere. On a computer, a QR code the phone's wallet app scans; on a phone, a button that hands the
 * pairing link to the wallet app installed there. Both offer the link to copy, for a wallet that takes it pasted.
 * The link opens nothing by itself: the wallet shows the site and asks the person to approve the connection.
 */

/** One path over the dark modules, a 1 × 1 square each: crisp at any size, and no element per module. */
function qrPath(modules: boolean[][]): string {
  let path = ''
  modules.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) path += `M${x} ${y}h1v1h-1z`
  }))
  return path
}

export function WalletConnectPanel({ phone }: { phone: boolean }) {
  const link = useSyncExternalStore(subscribePairing, pairingLink, pairingLink)
  const [modules, setModules] = useState<{ link: string; path: string; size: number } | null>(null)
  // The link last copied: "Link copied" belongs to that link only, so a new pairing reads "Copy link" again.
  const [copiedLink, setCopiedLink] = useState<string | null>(null)
  useEffect(() => {
    if (!link) return
    let live = true
    void pairingQr(link).then((rows) => {
      if (live) setModules({ link, path: qrPath(rows), size: rows.length })
    })
    return () => {
      live = false
    }
  }, [link])

  if (!link) {
    return (
      <p className="text-[13px] leading-[18px] text-fg-muted" data-walletconnect="starting">
        {WALLETCONNECT.starting}
      </p>
    )
  }
  const qr = modules?.link === link ? modules : null
  const copied = copiedLink === link
  const copy = () => {
    void navigator.clipboard?.writeText(link).then(() => setCopiedLink(link), () => setCopiedLink(null))
  }
  return (
    <div className="dm-walletconnect" data-walletconnect="pairing">
      <p className="text-[13px] leading-[18px] text-fg-muted">{phone ? WALLETCONNECT.open : WALLETCONNECT.scan}</p>
      {phone && (
        <Button type="button" variant="primary" onClick={() => window.location.assign(link)} data-walletconnect-open="">
          Open wallet app
        </Button>
      )}
      {qr && (
        <svg
          className="dm-walletconnect-qr"
          viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`}
          role="img"
          aria-label="WalletConnect pairing code"
          data-walletconnect-qr={qr.size}
          shapeRendering="crispEdges"
        >
          <rect x="-2" y="-2" width={qr.size + 4} height={qr.size + 4} rx="1.5" fill="#fff" />
          <path d={qr.path} fill="#000" />
        </svg>
      )}
      <Button type="button" variant="ghost" size="sm" onClick={copy} data-walletconnect-copy="">
        {copied ? 'Link copied' : 'Copy link'}
      </Button>
    </div>
  )
}
