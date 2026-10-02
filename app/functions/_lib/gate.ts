/**
 * Closed-beta access gate.
 *
 * Every request to the deployment passes through functions/_middleware.ts,
 * which uses these helpers. Nothing of the app — HTML, scripts, styles,
 * images or /api/* — is served until the browser holds a valid access cookie.
 * Because the gate is code in every deployment rather than a setting on one
 * hostname, it also covers the pages.dev and preview hostnames.
 *
 * The project owner chose a shared password over Cloudflare Access for this
 * beta. It proves an invitation, not wallet ownership: wallet admission is a
 * separate backend concern and nothing here grants any capability in the app.
 *
 * 2026-10-01 (platform workstream, D3, I5, I7):
 *   - The access lasts SESSION_SECONDS from the last visit, not from the
 *     login: a page served with a cookie more than RENEW_AFTER_SECONDS old
 *     carries a fresh one (functions/_middleware.ts), so an active tester is
 *     never cut off in the middle of a week. Rotating BETA_PASSWORD or
 *     BETA_COOKIE_KEY still signs everyone out at once: the signature covers
 *     both.
 *   - The link a visitor opened (its hash, which never reaches a server) is
 *     carried through the login by the access page's one inline script into
 *     a hidden field, checked against NEXT_HASH, and the login goes back to
 *     it instead of to Home.
 *   - The access page loads no Google Fonts: its two fonts are the site's own
 *     files, served without the cookie from GATE_FONTS.
 *   - Logins are limited per client address (createLoginLimiter).
 */

export interface BetaEnv {
  BETA_PASSWORD?: string
  BETA_COOKIE_KEY?: string
  /**
   * Not a secret and not part of the gate: "true" confines a deployment to
   * domino.money and www.domino.money (functions/_middleware.ts, rule 0).
   * Set for production only, in wrangler.toml.
   */
  CANONICAL_HOSTS_ONLY?: string
}

export interface BetaConfig {
  key: CryptoKey
  passwordDigest: Uint8Array<ArrayBuffer>
  passwordHex: string
}

export const COOKIE_NAME = '__Host-domino-beta'
export const SESSION_SECONDS = 7 * 24 * 60 * 60
/** A cookie older than this (less than six days left) is renewed by the next page the gate serves with it. */
export const RENEW_AFTER_SECONDS = 24 * 60 * 60
export const MIN_PASSWORD_LENGTH = 16
export const MIN_KEY_BYTES = 32
const MAX_SECRET_LENGTH = 512
const MAX_COOKIE_HEADER = 8192
const CONTEXT = 'domino/beta/v1'

const encoder = new TextEncoder()

async function sha256(text: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** Constant-time comparison. Both sides are fixed-length digests. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

let cached: { password: string; key: string; config: BetaConfig } | null = null

/**
 * The gate's configuration, or null when it is missing or too weak.
 *
 * Null means the middleware refuses every request, including the login form.
 * A misconfigured deployment is closed, never open.
 */
export async function readConfig(env: BetaEnv): Promise<BetaConfig | null> {
  const password = env.BETA_PASSWORD
  const key = env.BETA_COOKIE_KEY
  if (typeof password !== 'string' || typeof key !== 'string') return null
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_SECRET_LENGTH) return null
  const keyBytes = encoder.encode(key)
  if (keyBytes.length < MIN_KEY_BYTES || key.length > MAX_SECRET_LENGTH) return null
  // One secret must never double as the other.
  if (key === password) return null
  if (cached && cached.password === password && cached.key === key) return cached.config

  const passwordDigest = await sha256(password)
  const config: BetaConfig = {
    key: await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]),
    passwordDigest,
    passwordHex: toHex(passwordDigest),
  }
  cached = { password, key, config }
  return config
}

/** Whether a submitted password is the beta password, compared in constant time. */
export async function isPassword(config: BetaConfig, candidate: string): Promise<boolean> {
  if (candidate.length > MAX_SECRET_LENGTH) return false
  return sameBytes(await sha256(candidate), config.passwordDigest)
}

/**
 * The signed message behind a cookie. The password's digest is part of it, so
 * rotating the password invalidates every cookie issued under the old one.
 */
const signedPayload = (config: BetaConfig, expires: number) =>
  encoder.encode(`${CONTEXT}|${expires}|${config.passwordHex}`)

export async function issueCookie(config: BetaConfig, nowMs: number): Promise<string> {
  const expires = Math.floor(nowMs / 1000) + SESSION_SECONDS
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', config.key, signedPayload(config, expires)))
  return `${COOKIE_NAME}=v1.${expires}.${toBase64Url(signature)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`
}

export const clearCookie = () => `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`

/**
 * The expiry, in seconds since the epoch, of the one valid access cookie in `header`, or null when there is none: a
 * missing, malformed, duplicated, expired, foreign or tampered cookie is no cookie.
 */
export async function cookieExpiry(config: BetaConfig, header: string | null, nowMs: number): Promise<number | null> {
  if (!header || header.length > MAX_COOKIE_HEADER) return null
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE_NAME}=`))
    .map((part) => part.slice(COOKIE_NAME.length + 1))
  // Exactly one: a duplicate is either a mistake or an attempt to confuse parsing.
  if (values.length !== 1) return null
  const match = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(values[0])
  if (!match) return null
  const expires = Number(match[1])
  const now = Math.floor(nowMs / 1000)
  if (expires <= now || expires > now + SESSION_SECONDS + 60) return null
  const signature = fromBase64Url(match[2])
  if (!signature || signature.length !== 32) return null
  // subtle.verify compares in constant time.
  return (await crypto.subtle.verify('HMAC', config.key, signature, signedPayload(config, expires))) ? expires : null
}

export async function hasValidCookie(config: BetaConfig, header: string | null, nowMs: number): Promise<boolean> {
  return (await cookieExpiry(config, header, nowMs)) !== null
}

/** Whether a valid cookie expiring at `expires` is old enough to be renewed at `nowMs` (D3: a sliding week). */
export const renewable = (expires: number, nowMs: number) => expires - Math.floor(nowMs / 1000) < SESSION_SECONDS - RENEW_AFTER_SECONDS

/**
 * The link a visitor opened, as the login may go back to it: a hash route of the site's own shape (`#/positions/42`,
 * `#/markets/0x…`, `#/docs/wallet#sign-in`), nothing else. It is a location on this site only: the login answers
 * `Location: /` followed by it, never another host.
 */
const NEXT_PATTERN = '^#\\/[A-Za-z0-9\\/_.,-]{0,200}(?:#[A-Za-z0-9_-]{1,64})?$'
export const NEXT_HASH = new RegExp(NEXT_PATTERN)

/** `candidate` when it is such a link, else the empty string. */
export const nextHash = (candidate: string | null): string => (candidate !== null && NEXT_HASH.test(candidate) ? candidate : '')

/**
 * The access page's one script: it puts the opened link's hash into the form's hidden field, so the login can go back
 * to it. It reads location.hash and writes one input; it sends nothing. PAGE_CSP admits exactly this text by its hash
 * (tests/gate.test.mjs recomputes it).
 */
export const GATE_SCRIPT = `(function () {
  var next = document.getElementById('next')
  if (next && /${NEXT_PATTERN}/.test(location.hash)) next.value = location.hash
})()`
export const GATE_SCRIPT_HASH = "'sha256-9uz1XhExhnnq32y0mtDaXrAaUwxq8YxGJSM8oJfEAt4='"

/**
 * The two fonts the access page uses, the site's own files (public/__beta/fonts/, byte for byte src/fonts/'s), served
 * without the cookie: a visitor who has not signed in yet is reported to no one (I5; until 2026-10-01 the page linked
 * Google Fonts, which saw every invitee's address, browser and this site).
 */
export const GATE_FONTS = Object.freeze(['/__beta/fonts/geist-latin.woff2', '/__beta/fonts/instrument-serif-latin.woff2'])

/** Login attempts per client address (I7): after LOGIN_LIMIT.failures wrong passwords within its window, none for a while. */
export const LOGIN_LIMIT = Object.freeze({ failures: 5, windowMs: 10 * 60_000, lockMs: 60_000, clients: 5_000 })

/**
 * Best effort, per isolate: Cloudflare runs many isolates and recycles them, so this slows a guesser down without
 * promising a hard cap. The firm limit is a rate limiting rule on POST /__beta/login in the Cloudflare dashboard, the
 * owner's to add. Bounded memory: at most LOGIN_LIMIT.clients addresses, the oldest let go first.
 */
export function createLoginLimiter(limits: typeof LOGIN_LIMIT = LOGIN_LIMIT) {
  const clients = new Map<string, { failures: number[]; lockedUntil: number }>()
  const prune = (now: number) => {
    for (const [client, entry] of clients) {
      if (entry.lockedUntil <= now && entry.failures.every((at) => now - at >= limits.windowMs)) clients.delete(client)
    }
    while (clients.size >= limits.clients) clients.delete(clients.keys().next().value as string)
  }
  return {
    /** How long `client` must wait before its next attempt, in ms; 0 when it may try now. */
    waitMs(client: string, now: number): number {
      const entry = clients.get(client)
      return entry && entry.lockedUntil > now ? entry.lockedUntil - now : 0
    },
    /** A wrong password from `client`: the one that reaches the limit locks it for LOGIN_LIMIT.lockMs. */
    failed(client: string, now: number): void {
      if (!clients.has(client)) prune(now)
      const entry = clients.get(client) ?? { failures: [], lockedUntil: 0 }
      entry.failures = [...entry.failures.filter((at) => now - at < limits.windowMs), now]
      if (entry.failures.length >= limits.failures) {
        entry.lockedUntil = now + limits.lockMs
        entry.failures = []
      }
      clients.delete(client)
      clients.set(client, entry)
    },
    /** The right password: `client` starts again from nothing. */
    succeeded(client: string): void {
      clients.delete(client)
    },
    size: () => clients.size,
  }
}

/**
 * CSP for the access page itself: its one script by its hash, its own inline styles, and the site's own two fonts. No
 * other host: the page loads nothing from Google since 2026-10-01 (I5).
 */
export const PAGE_CSP = [
  "default-src 'none'",
  `script-src ${GATE_SCRIPT_HASH}`,
  "style-src 'unsafe-inline'",
  "font-src 'self'",
  'img-src data:',
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ')

export type PageState = 'ask' | 'wrong' | 'wait' | 'unavailable'

/** The app's own favicon (public/favicon.svg): the domino tile, tilted 24 degrees, with nothing behind it. */
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cg transform='rotate(-24 32 32)'%3E%3Crect x='15' y='5' width='34' height='54' rx='6' fill='%23f49a57'/%3E%3Crect x='17.5' y='30.5' width='29' height='3' rx='1.5' fill='%23faf5ea' opacity='.5'/%3E%3Ccircle cx='24.5' cy='14' r='6' fill='%23faf5ea'/%3E%3Ccircle cx='39.5' cy='24' r='6' fill='%23faf5ea'/%3E%3Ccircle cx='32' cy='46' r='6' fill='%23faf5ea'/%3E%3C/g%3E%3C/svg%3E"

/**
 * The access page. Self-contained: the app's upright tile mark and wordmark (src/components/Header.tsx), and its warm
 * palette (src/styles/tokens.css), inlined; its two fonts from GATE_FONTS. Dark only, like the app (owner, 2026-09-26:
 * dark only): the viewer's system setting is not consulted. Its one script, GATE_SCRIPT, carries the opened link
 * through the login; `next` is that link again on a page the login answers (a wrong password, a wait), checked here.
 */
export function accessPage(state: PageState, next = ''): string {
  const link = nextHash(next)
  const notice =
    state === 'wrong'
      ? '<p id="error" class="error" role="alert">That password didn’t work. Check it and try again.</p>'
      : state === 'wait'
        ? '<p id="error" class="error" role="alert">Too many tries in a row. Wait a minute, then try again.</p>'
        : ''
  const body =
    state === 'unavailable'
      ? `<h1>Access is paused.</h1>
        <p class="lede">Nothing is wrong on your side.</p>`
      : `<h1>You’re early.</h1>
        <p class="lede">Enter the access password from your invitation to continue.</p>
        <form method="post" action="/__beta/login" novalidate>
          <label for="password">Access password</label>
          <input id="password" name="password" type="password" autocomplete="current-password"
            required autofocus spellcheck="false" autocapitalize="off"${notice ? ' aria-invalid="true" aria-describedby="error"' : ''} />
          ${notice}
          <input id="next" name="next" type="hidden" value="${link}" />
          <button type="submit">Enter Domino</button>
        </form>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="color-scheme" content="dark" />
<title>Domino · Access</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON}" />
<link rel="preload" href="${GATE_FONTS[0]}" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="${GATE_FONTS[1]}" as="font" type="font/woff2" crossorigin />
<style>
  @font-face { font-family: 'Geist'; font-style: normal; font-weight: 400 500; font-display: swap; src: url('${GATE_FONTS[0]}') format('woff2'); }
  @font-face { font-family: 'Instrument Serif'; font-style: normal; font-weight: 400; font-display: swap; src: url('${GATE_FONTS[1]}') format('woff2'); }
  :root {
    color-scheme: dark;
    --bg: #0d0a08; --surface-1: #171310; --surface-2: #1f1a17; --surface-3: #2c2723;
    --fg: #f7f1ea; --fg-muted: #c8beb4; --fg-subtle: #9b9289; --fg-faint: #6e665e;
    --border: rgb(255 236 220 / 0.07); --border-lip: rgb(255 236 220 / 0.10); --border-strong: rgb(255 236 220 / 0.16);
    --btn: #faf7f3; --btn-fg: #161412; --btn-hover: #ebe6e0;
    --primary: #ff9d62; --primary-fg: #24201c; --ring: #ff9d62;
    --money-out: #f4607a;
    --pip: #faf5ea;
    --elev-card: inset 0 0 0 1px rgb(255 236 220 / 0.07), 0 12px 32px -12px rgb(0 0 0 / 0.65);
    --elev-button: 0 1px 2px rgb(0 0 0 / 0.35), 0 3px 10px -4px rgb(0 0 0 / 0.45);
    --gutter: 16px; --header-h: 56px;
    --font-display: 'Instrument Serif', ui-serif, Georgia, 'Times New Roman', serif;
    --font-sans: 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  @media (min-width: 768px) { :root { --gutter: 24px; --header-h: 72px; } }
  @media (min-width: 1024px) { :root { --gutter: 40px; } }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; min-height: 100dvh;
    display: grid; grid-template-rows: auto 1fr auto;
    background: var(--bg); color: var(--fg);
    font: 14px/20px var(--font-sans); letter-spacing: -0.2px;
    -webkit-font-smoothing: antialiased;
  }
  header { width: 100%; max-width: calc(1200px + 2 * var(--gutter)); height: var(--header-h); margin-inline: auto; padding-inline: var(--gutter); display: flex; align-items: center; }
  .wordmark { display: inline-flex; align-items: center; gap: 8px; }
  .wordmark svg { display: block; flex-shrink: 0; }
  .tile { fill: var(--primary); }
  .rule { fill: var(--primary-fg); opacity: 0.32; }
  .pip { fill: var(--pip); }
  .word { font: 400 24px/24px var(--font-display); letter-spacing: 0; }
  .word span { color: var(--primary); }
  main { display: grid; place-items: center; padding: 24px var(--gutter) 48px; }
  .card {
    width: 100%; max-width: 400px;
    background: var(--surface-2); border-radius: 12px; box-shadow: var(--elev-card);
    padding: 28px 24px 24px;
  }
  .eyebrow {
    display: inline-flex; align-items: center; gap: 8px; min-height: 30px; padding: 7px 10px;
    border-radius: 12px; background: var(--surface-3); box-shadow: inset 0 0 0 1px var(--border);
    color: var(--fg); font-size: 13px; line-height: 16px; font-weight: 500; letter-spacing: -0.1px; white-space: nowrap;
  }
  .eyebrow::before { content: ''; width: 6px; height: 6px; flex-shrink: 0; border-radius: 9999px; background: var(--fg-faint); }
  h1 { margin: 20px 0 8px; font: 400 34px/38px var(--font-display); letter-spacing: -0.2px; }
  .lede { margin: 0 0 24px; color: var(--fg-muted); text-wrap: pretty; }
  .lede:last-child { margin-bottom: 0; }
  label { display: block; margin-bottom: 6px; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--fg-muted); }
  input {
    display: block; width: 100%; height: 44px; margin: 0; padding: 0 12px;
    border: 0; border-radius: 12px; background: var(--surface-1); color: var(--fg);
    box-shadow: inset 0 0 0 1px var(--border-lip);
    font: inherit; letter-spacing: inherit; outline: none;
    transition: box-shadow .15s ease;
  }
  input:hover { box-shadow: inset 0 0 0 1px var(--border-strong); }
  input:focus-visible { box-shadow: inset 0 0 0 1px var(--border-strong); outline: 2px solid var(--ring); outline-offset: 1px; }
  input[aria-invalid="true"] { box-shadow: inset 0 0 0 1px var(--money-out); }
  input:-webkit-autofill { -webkit-text-fill-color: var(--fg); caret-color: var(--fg); box-shadow: inset 0 0 0 1px var(--border-lip), inset 0 0 0 44px var(--surface-1); }
  input[aria-invalid="true"]:-webkit-autofill { box-shadow: inset 0 0 0 1px var(--money-out), inset 0 0 0 44px var(--surface-1); }
  .error { margin: 8px 0 0; font-size: 13px; line-height: 18px; color: var(--money-out); }
  button {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 44px; margin: 16px 0 0; padding: 0 18px;
    border: 0; border-radius: 12px; cursor: pointer;
    background: var(--btn); color: var(--btn-fg); box-shadow: var(--elev-button);
    font: 500 14px/20px var(--font-sans); letter-spacing: -0.2px;
    transition: background-color .15s ease, scale .1s cubic-bezier(0.4, 0, 0.2, 1);
  }
  button:hover { background: var(--btn-hover); }
  button:active { scale: 0.99; }
  button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  footer { padding: 20px var(--gutter) 28px; text-align: center; color: var(--fg-subtle); font-size: 12px; line-height: 16px; }
  @media (min-width: 768px) {
    .word { font-size: 26px; line-height: 26px; }
    .card { padding: 32px 28px 28px; }
  }
  @media (max-width: 479px) {
    main { place-items: start center; padding-top: 12px; }
    .card { padding: 24px 20px 20px; }
    h1 { font-size: 28px; line-height: 32px; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
  <header>
    <span class="wordmark">
      <svg width="16" height="28" viewBox="0 0 20 34" aria-hidden="true">
        <rect class="tile" x="0.6" y="0.6" width="18.8" height="32.8" rx="2.6" />
        <rect class="rule" x="2.2" y="16.6" width="15.6" height="0.9" rx="0.45" />
        <circle class="pip" cx="14.1" cy="5.85" r="1.95" />
        <circle class="pip" cx="6.05" cy="12.7" r="1.95" />
        <circle class="pip" cx="9.62" cy="25.2" r="1.95" />
      </svg>
      <span class="word">domino<span>.</span></span>
    </span>
  </header>
  <main>
    <div class="card">
      <span class="eyebrow">Invitation only</span>
      ${body}
    </div>
  </main>
  <footer>Robinhood Chain</footer>
  <script>${GATE_SCRIPT}</script>
</body>
</html>`
}
