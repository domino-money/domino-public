import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Page } from '../App'
import { deferred } from './Deferred'
import { recovering } from '../lib/staleRelease'
import { Button } from './ui'
import { BrandMark } from './BrandMark'
import { IconWalletLine } from './icons'
import { WalletBoundary } from './wallet/WalletBoundary'
import { HeaderMenu, PRIMARY_NAV } from './HeaderMenu'

// The wallet session is one lazy chunk, reached only through this constant.
// Where it is false the bundler drops the import and no wallet code is
// emitted at all. The condition is the defined identifier itself rather than
// a re-export of it, so the bundler folds it for certain. 2026-09-28 (speed
// wave B, item 24): drawn as soon as its chunk is in (Deferred.tsx), not
// 300 ms after its fallback: it says who is connected, which Positions waits for.
// 2026-10-01 (D1): when a release replaced its file, the tab reloads once into the new release (lib/staleRelease.ts);
// any other failure reaches WalletBoundary as before.
const WalletSession = __DOMINO_WALLET_SESSION__ ? deferred(recovering(() => import('./wallet/WalletSessionIsland'), (error: unknown): never => { throw error })) : null
const LocalWallet = __DOMINO_LOCAL_LIVE__ ? lazy(() => import('./wallet/LocalWalletIsland')) : null

/** Shown while the feature loads, or if it fails to. */
function DisabledConnect({ title }: { title: string }) {
  return (
    <Button disabled title={title}>
      <IconWalletLine className="dm-wallet-glyph" />
      Connect wallet
    </Button>
  )
}

/** The mark stands upright with nothing behind it; it tips toward the pointer only while hovered (V4). */
function Wordmark({ home }: { home: boolean }) {
  return (
    <a href="#/" className="dm-wordmark" aria-label="Domino, home" aria-current={home ? 'page' : undefined}>
      <BrandMark width={17} height={29} />
      <span className="dm-wordmark-text">
        domino<span className="dm-wordmark-dot">.</span>
      </span>
    </a>
  )
}

/** Whether anything has scrolled under the header, for its wash. */
function useScrolled() {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 4)
    update()
    window.addEventListener('scroll', update, { passive: true })
    return () => window.removeEventListener('scroll', update)
  }, [])
  return scrolled
}

/**
 * The centred nav. One indicator spans the lit item and carries its Tangerine
 * dot (V4), travelling to the next one on a route change; it fades out where
 * nothing is lit. It is placed from the items' own boxes, again whenever they
 * resize (a web font arriving changes their widths).
 */
function NavPill({ page }: { page: Page }) {
  const nav = useRef<HTMLElement>(null)
  const indicator = useRef<HTMLSpanElement>(null)
  const lit = PRIMARY_NAV.findIndex((item) => item.pages.includes(page))

  useLayoutEffect(() => {
    const root = nav.current
    const mark = indicator.current
    if (!root || !mark) return
    const links = root.querySelectorAll<HTMLElement>('a')
    const place = () => {
      const link = lit === -1 ? null : links[lit]
      if (!link) {
        mark.style.opacity = '0'
        return
      }
      mark.style.width = `${link.offsetWidth}px`
      mark.style.translate = `${link.offsetLeft}px 0`
      mark.style.opacity = '1'
    }
    place()
    let alive = true
    let frame = 0
    if (!root.hasAttribute('data-ready')) frame = requestAnimationFrame(() => root.setAttribute('data-ready', ''))
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    links.forEach((link) => observer?.observe(link))
    void document.fonts?.ready.then(() => {
      if (alive) place()
    })
    return () => {
      alive = false
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [lit])

  return (
    <nav ref={nav} aria-label="Main" className="dm-nav" data-home={page === 'overview' ? '' : undefined}>
      <span ref={indicator} aria-hidden="true" className="dm-nav-indicator" />
      {PRIMARY_NAV.map(({ label, href, icon: Icon }, index) => (
        <a key={label} href={href} aria-current={index === lit ? 'page' : undefined} className="dm-nav-item">
          <Icon />
          {label}
        </a>
      ))}
    </nav>
  )
}

export function Header({ page }: { page: Page }) {
  const scrolled = useScrolled()
  return (
    // dm-k-top: the header fades in once, on the page's first load (V4 load moment, tokens.css), never on navigation.
    <header className="dm-header dm-k-top" data-scrolled={scrolled ? '' : undefined}>
      <div className="dm-header-row">
        <Wordmark home={page === 'overview'} />

        <NavPill page={page} />

        <div className="dm-header-actions">
          {/* One expression, so a build without the feature folds to exactly
              the disabled control the header had before it. */}
          {__DOMINO_LOCAL_LIVE__ && LocalWallet ? (
            <WalletBoundary fallback={<DisabledConnect title="Wallet connection could not load. Reload the page to try again." />}>
              <Suspense fallback={<DisabledConnect title="Loading wallet connection" />}><LocalWallet /></Suspense>
            </WalletBoundary>
          ) : __DOMINO_WALLET_SESSION__ && WalletSession ? (
            // Mounted on every route, so the session it holds and its status
            // announcements survive navigation. While its chunk loads on the
            // landing, the fallback is nothing rather than a disabled control.
            <WalletBoundary fallback={page === 'overview' ? null : <DisabledConnect title="Wallet sign-in could not load. Reload the page to try again." />}>
              <Suspense fallback={page === 'overview' ? null : <DisabledConnect title="Loading wallet sign-in" />}>
                <WalletSession fallback={page === 'overview' ? null : <DisabledConnect title="Loading wallet sign-in" />} />
              </Suspense>
            </WalletBoundary>
          ) : (
            <DisabledConnect title="Wallet connection isn’t available here" />
          )}
          <HeaderMenu page={page} />
        </div>
      </div>
    </header>
  )
}
