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

export async function hasValidCookie(config: BetaConfig, header: string | null, nowMs: number): Promise<boolean> {
  if (!header || header.length > MAX_COOKIE_HEADER) return false
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE_NAME}=`))
    .map((part) => part.slice(COOKIE_NAME.length + 1))
  // Exactly one: a duplicate is either a mistake or an attempt to confuse parsing.
  if (values.length !== 1) return false
  const match = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(values[0])
  if (!match) return false
  const expires = Number(match[1])
  const now = Math.floor(nowMs / 1000)
  if (expires <= now || expires > now + SESSION_SECONDS + 60) return false
  const signature = fromBase64Url(match[2])
  if (!signature || signature.length !== 32) return false
  // subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', config.key, signature, signedPayload(config, expires))
}

/** CSP for the access page itself: no scripts at all, fonts from the same host as the app. */
export const PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  'img-src data:',
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ')

export type PageState = 'ask' | 'wrong' | 'unavailable'

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23ff843d'/%3E%3Ccircle cx='32' cy='19' r='5.5' fill='%2324201c'/%3E%3Crect x='16' y='30.5' width='32' height='3.2' rx='1.6' fill='%2324201c'/%3E%3Ccircle cx='32' cy='45' r='5.5' fill='%2324201c'/%3E%3C/svg%3E"

/**
 * The access page. Self-contained, no script, the approved Tangerine palette,
 * following the viewer's light or dark preference like the app does.
 */
export function accessPage(state: PageState): string {
  const body =
    state === 'unavailable'
      ? `<h1>Access is paused.</h1>
        <p class="lede">The beta is temporarily unavailable. Nothing is wrong on your side — please try again a little later.</p>`
      : `<h1>You’re early.</h1>
        <p class="lede">Domino is in a closed beta. Enter the access password from your invitation to continue.</p>
        <form method="post" action="/__beta/login" novalidate>
          <label for="password">Access password</label>
          <input id="password" name="password" type="password" autocomplete="current-password"
            required autofocus spellcheck="false" autocapitalize="off"${state === 'wrong' ? ' aria-invalid="true" aria-describedby="error"' : ''} />
          ${state === 'wrong' ? '<p id="error" class="error" role="alert">That password didn’t work. Check it and try again.</p>' : ''}
          <button type="submit">Enter Domino</button>
        </form>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="color-scheme" content="light dark" />
<title>Domino · Closed beta</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON}" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Geist:wght@400;500&family=Geist+Mono:wght@400&display=swap" />
<style>
  :root {
    --bg: #f0f1f2; --surface: #ffffff; --field: #f7f8f9;
    --fg: #232428; --muted: #64666e; --subtle: #8a8d95;
    --line: rgb(0 0 0 / 0.09); --line-strong: rgb(0 0 0 / 0.16);
    --primary: #ff843d; --primary-fg: #24201c; --ring: #b24413;
    --error: #b33036; --error-bg: #fff0f0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #191b20; --surface: #282b32; --field: #1f2229;
      --fg: #f5f4f2; --muted: #b9bbc4; --subtle: #82858f;
      --line: rgb(255 255 255 / 0.07); --line-strong: rgb(255 255 255 / 0.14);
      --primary: #ff9d62; --ring: #ff9d62;
      --error: #ffaaaa; --error-bg: #442b31;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; min-height: 100%;
    display: grid; grid-template-rows: auto 1fr auto;
    background: var(--bg); color: var(--fg);
    font: 15px/1.55 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
    background-image:
      radial-gradient(60rem 30rem at 50% -8rem, color-mix(in srgb, var(--primary) 22%, transparent), transparent 70%);
    background-repeat: no-repeat;
  }
  header { padding: 22px 24px; display: flex; align-items: center; gap: 10px; }
  .word { font-family: 'Instrument Serif', ui-serif, Georgia, serif; font-size: 24px; line-height: 1; }
  .word span { color: var(--primary); }
  main { display: grid; place-items: center; padding: 24px 20px 48px; }
  .card {
    width: 100%; max-width: 420px;
    background: var(--surface); border: 1px solid var(--line); border-radius: 16px;
    padding: 32px 28px 28px;
  }
  .eyebrow {
    display: inline-flex; align-items: center; gap: 8px;
    font: 500 11px/1 'Geist Mono', ui-monospace, monospace; letter-spacing: 0.7px; text-transform: uppercase;
    color: var(--muted); padding: 7px 11px; border: 1px solid var(--line-strong); border-radius: 999px;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 25%, transparent); }
  h1 {
    margin: 18px 0 8px;
    font: 400 40px/1.05 'Instrument Serif', ui-serif, Georgia, serif; letter-spacing: -0.3px;
  }
  .lede { margin: 0 0 24px; color: var(--muted); font-size: 14px; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  input {
    width: 100%; height: 48px; padding: 0 14px;
    background: var(--field); color: var(--fg);
    border: 1px solid var(--line-strong); border-radius: 12px;
    font: 15px 'Geist Mono', ui-monospace, monospace; letter-spacing: 0.5px;
    outline: none; transition: border-color .15s, box-shadow .15s;
  }
  input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 28%, transparent); }
  input[aria-invalid="true"] { border-color: var(--error); }
  .error {
    margin: 10px 0 0; padding: 9px 12px; border-radius: 10px;
    background: var(--error-bg); color: var(--error); font-size: 13px;
  }
  button {
    margin-top: 16px; width: 100%; height: 48px;
    border: 0; border-radius: 999px; cursor: pointer;
    background: var(--primary); color: var(--primary-fg);
    font: 500 15px 'Geist', ui-sans-serif, system-ui, sans-serif;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary) 35%, transparent), 0 10px 32px -10px color-mix(in srgb, var(--primary) 60%, transparent);
    transition: filter .15s, transform .05s;
  }
  button:hover { filter: brightness(1.06); }
  button:active { transform: translateY(1px); }
  button:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }
  footer { padding: 20px 24px 28px; text-align: center; color: var(--subtle); font-size: 12px; }
  @media (max-width: 480px) {
    .card { padding: 26px 20px 22px; border-radius: 14px; }
    h1 { font-size: 34px; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
  <header>
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <rect x="1" y="1" width="24" height="24" rx="7" fill="var(--primary)" />
      <circle cx="13" cy="8" r="2.1" fill="var(--primary-fg)" />
      <rect x="6.5" y="12.4" width="13" height="1.3" rx="0.65" fill="var(--primary-fg)" />
      <circle cx="13" cy="18" r="2.1" fill="var(--primary-fg)" />
    </svg>
    <span class="word">domino<span>.</span></span>
  </header>
  <main>
    <div class="card">
      <span class="eyebrow"><span class="dot"></span>Closed beta</span>
      ${body}
    </div>
  </main>
  <footer>Robinhood Chain · Invitation only</footer>
</body>
</html>`
}
