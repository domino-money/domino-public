/** Decorative local artwork only. The announced id is not proof of wallet
 * identity and never selects a provider: connection still uses connector.uid.
 * Never load the extension's icon or turn metadata into a URL. */
export function WalletLogo({ id }: { id: string }) {
  const props = { width: 24, height: 24, className: 'size-6 shrink-0 object-contain', 'aria-hidden': true as const }
  switch (id) {
    case 'io.rabby': return <img {...props} alt="" src="/wallets/rabby.svg" />
    case 'app.phantom': return <img {...props} alt="" src="/wallets/phantom.svg" />
    case 'com.roninchain.wallet': return <img {...props} alt="" src="/wallets/ronin.svg" />
    case 'io.metamask': return <img {...props} alt="" src="/wallets/metamask.svg" />
    case 'io.magiceden.wallet': return <img {...props} alt="" src="/wallets/magic-eden.svg" />
    case 'com.brave.wallet': return <img {...props} alt="" src="/wallets/brave.svg" />
    default: return (
      <svg width="24" height="24" viewBox="0 0 24 24" className="shrink-0 text-fg-muted" aria-hidden="true">
        <rect x="3" y="5" width="18" height="15" rx="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3 9h18" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="17" cy="14.5" r="1.5" fill="currentColor" />
      </svg>
    )
  }
}
