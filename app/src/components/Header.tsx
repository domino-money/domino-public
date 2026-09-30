import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Page } from '../App'
import { deferred } from './Deferred'
import { Button } from './ui'
import { BrandMark } from './BrandMark'
import { WalletBoundary } from './wallet/WalletBoundary'
import { HeaderMenu, PRIMARY_NAV } from './HeaderMenu'

// The wallet session is one lazy chunk, reached only through this constant.
// Where it is false the bundler drops the import and no wallet code is
// emitted at all. The condition is the defined identifier itself rather than
// a re-export of it, so the bundler folds it for certain. 2026-09-28 (speed
// wave B, item 24): drawn as soon as its chunk is in (Deferred.tsx), not
// 300 ms after its fallback: it says who is connected, which Positions waits for.
const WalletSession = __DOMINO_WALLET_SESSION__ ? deferred(() => import('./wallet/WalletSessionIsland')) : null
const LocalWallet = __DOMINO_LOCAL_LIVE__ ? lazy(() => import('./wallet/LocalWalletIsland')) : null

/** Shown while the feature loads, or if it fails to. */
function DisabledConnect({ title }: { title: string }) {
  return (
    <Button disabled title={title}>
      Connect wallet
    </Button>
  )
}

/** The mark stands upright with nothing behind it, and never moves. */
function Wordmark() {
  return (
    <a href="#/" className="dm-wordmark" aria-label="Domino, home">
      <BrandMark width={16} height={28} />
      <span className="dm-wordmark-text">
        domino<span className="dm-wordmark-dot">.</span>
      </span>
    </a>
  )
}

/** Whether anything has scrolled under the header, for its hairline. */
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
 * The centred nav pill. One indicator sits behind the lit item and slides to
 * the next one on a route change; it fades out where nothing is lit. It is
 * placed from the items' own boxes, again whenever they resize (a web font
 * arriving changes their widths).
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
    <nav ref={nav} aria-label="Main" className="dm-nav">
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
    <header className="dm-header" data-scrolled={scrolled ? '' : undefined}>
      <div className="dm-header-row">
        <Wordmark />

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
