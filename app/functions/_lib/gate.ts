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

const round = (value: number) => Math.round(value * 1000) / 1000

/*
 * The access page's drawing (2026-10-03, the owner: the page "lacks depth, it lacks life"), in the Home hero's family
 * (src/components/home/HeroArt.tsx, src/styles/art.css): six dark tiles stand in a row on the ground, and one lit
 * Tangerine tile stands on a step at the right. On a first visit the row topples toward the lit tile as a real chain
 * does, each tile coming to rest on the next and warming as it lands; the last one leans on the lit tile, which rocks a
 * little and glows; the fallen row fades, stands up unseen and comes back. The loop plays ART_LOOPS times (the app's
 * --art-loops), then rests on its complete picture, every tile standing, which is also the whole picture under
 * prefers-reduced-motion, after a wrong password and while access is paused. Only shapes: no text, no image, no colour
 * literal (each colour is a token of the page's style). The tiles are the app's art tiles (Vignettes.tsx ArtTile:
 * 1:1.75, pips of 0.075 w, never the brand mark's two-above-one-below), the dark ones drawn as the hero's run, the lit
 * one as a solid art tile.
 */
const TILE_W = 20
const TILE_H = TILE_W * 1.75
const VIEW_W = 320
const VIEW_H = 120
const GROUND = 100
const STEP = 86
/** The run: six tiles 26 apart, each one's pips (top | bottom), and the lit tile's. */
const RUN_GAP = 26
const RUN_X = [64, 90, 116, 142, 168, 194]
const RUN_PIPS: ReadonlyArray<readonly [number, number]> = [[1, 3], [3, 0], [0, 2], [2, 3], [0, 3], [1, 2]]
const LIT_PIPS = [3, 1] as const
/** A fallen run rests where each tile leans on the next at one angle: cos θ = TILE_W / RUN_GAP (39.7°, as the hero's). */
const FALL = Math.acos(TILE_W / RUN_GAP)
const FALL_DEG = round((FALL * 180) / Math.PI)
/**
 * The last tile's front foot. The lit tile stands where that tile, at the same angle, leans on it (its top corner meets
 * the lit tile's face 13 above the step); the step's edge sits just clear of the leaning tile.
 */
const LAST_FOOT = RUN_X[RUN_X.length - 1] + TILE_W
const LIT_X = round(LAST_FOOT + TILE_H * Math.sin(FALL))
const STEP_X = round(LAST_FOOT + (GROUND - STEP) * Math.tan(FALL) + 1.5)

/**
 * One loop (LOOP_S): the row stands for FIRST_TIP_S, then the wave runs through it to TOUCH_S, when the last tile meets
 * the lit one; the row rests fallen, fades out from 6.4 to 6.9 s, stands up at 7 to 7.1 s while unseen, and fades back
 * in from 7.2 to 7.8 s. Every moving part runs its own keyframes on this one timeline (same duration, delay and count),
 * so the whole picture resets at once.
 */
const LOOP_S = 9
const ART_LOOPS = 3
const ART_DELAY_S = 0.6
const FIRST_TIP_S = 0.9
const at = (seconds: number) => `${round((seconds / LOOP_S) * 100)}%`

/**
 * The wave. A tile touches its neighbour, still standing, once tipped by CONTACT (9.9°); while that neighbour is tipped
 * by φ, it rests on its back at leanOn(φ) (its top corner on the neighbour's face), which is FALL again once φ is FALL.
 * Each tile in turn is the front: the first tips from rest (p², over 2 × PUSH_S), each next one is pushed on at the
 * speed the wave reached (CONTACT per PUSH_S), and the last, with nothing ahead but the lit tile, keeps falling, faster,
 * for LAST_S until it leans on it. Every tile behind the front rests on the one ahead (the hero lets each tile fall on
 * its own clock, so one passes through the next for a moment; here none ever does).
 */
const CONTACT = Math.asin((RUN_GAP - TILE_W) / TILE_H)
const leanOn = (phi: number) => phi + Math.asin((RUN_GAP * Math.cos(phi) - TILE_W) / TILE_H)
const LAST = RUN_X.length - 1
const PUSH_S = 0.17
const LAST_S = 0.4
const FRONTS = RUN_X.map((_, k) => ({
  start: FIRST_TIP_S + (k === 0 ? 0 : (k + 1) * PUSH_S),
  span: k === 0 ? 2 * PUSH_S : k === LAST ? LAST_S : PUSH_S,
}))
const TOUCH_S = round(FRONTS[LAST].start + LAST_S)

/** The front tile's angle, `u` of the way through its turn. */
function frontAngle(k: number, u: number): number {
  if (k === 0) return CONTACT * u * u
  if (k < LAST) return CONTACT * u
  const carried = CONTACT * (LAST_S / PUSH_S)
  return carried * u + (FALL - carried) * u * u
}

/** Every run tile's angle, in degrees, `t` seconds into the loop's wave. */
function runAt(t: number): number[] {
  const angles = RUN_X.map(() => 0)
  let front = -1
  FRONTS.forEach((turn, k) => {
    if (t >= turn.start) front = k
  })
  if (front < 0) return angles
  angles[front] = frontAngle(front, Math.min(1, (t - FRONTS[front].start) / FRONTS[front].span))
  for (let i = front - 1; i >= 0; i--) angles[i] = leanOn(angles[i + 1])
  return angles.map((angle) => (angle * 180) / Math.PI)
}

/** Ramer–Douglas–Peucker on (time, angle): the fewest points whose straight segments stay within `tolerance` degrees. */
function thin(points: Array<[number, number]>, tolerance: number): Array<[number, number]> {
  if (points.length < 3) return points
  const [[t0, a0], [t1, a1]] = [points[0], points[points.length - 1]]
  let worst = 0
  let index = 0
  for (let j = 1; j < points.length - 1; j++) {
    const [t, a] = points[j]
    const off = Math.abs(a - (a0 + ((a1 - a0) * (t - t0)) / (t1 - t0)))
    if (off > worst) [worst, index] = [off, j]
  }
  if (worst <= tolerance) return [points[0], points[points.length - 1]]
  return [...thin(points.slice(0, index + 1), tolerance).slice(0, -1), ...thin(points.slice(index), tolerance)]
}

/** Tile i's angle from its turn to TOUCH_S, sampled 60 times a second and at every turn, as keyframes within 0.2°. */
function tipPath(i: number): Array<[number, number]> {
  const times = new Set(FRONTS.slice(i).map((turn) => turn.start))
  for (let t = FRONTS[i].start; t < TOUCH_S; t += 1 / 60) times.add(t)
  times.add(TOUCH_S)
  return thin([...times].sort((a, b) => a - b).map((t): [number, number] => [t, runAt(t)[i]]), 0.2)
}

/** A @keyframes rule from (seconds, declaration) pairs: one block per moment, in order. */
function keyframes(name: string, frames: Array<[number, string]>): string {
  const blocks = new Map<string, string[]>()
  for (const [seconds, declaration] of [...frames].sort((a, b) => a[0] - b[0])) {
    const key = at(seconds)
    blocks.set(key, [...(blocks.get(key) ?? []), declaration])
  }
  return `@keyframes ${name} { ${[...blocks].map(([key, list]) => `${key} { ${list.join(' ')} }`).join(' ')} }`
}

/** Tile i: standing, its path through the wave, its face warming over 0.3 s from its contact, then the reset. */
function tipKeyframes(i: number): string {
  const contact = FRONTS[i].start + FRONTS[i].span
  return keyframes(`g-tip-${i}`, [
    [0, 'rotate: 0deg;'],
    [0, 'color: var(--tile);'],
    ...tipPath(i).map(([t, angle]): [number, string] => [t, `rotate: ${round(angle)}deg;`]),
    [contact, 'color: var(--tile);'],
    [contact + 0.3, 'color: var(--tile-lit);'],
    [7, `rotate: ${FALL_DEG}deg;`],
    [7, 'color: var(--tile-lit);'],
    [7.1, 'rotate: 0deg;'],
    [7.1, 'color: var(--tile);'],
    [LOOP_S, 'rotate: 0deg;'],
    [LOOP_S, 'color: var(--tile);'],
  ])
}

/** Pip centres for one half of a tile, from `top` (Vignettes.tsx tilePips): 1 the centre, 2 the rising diagonal, 3 both. */
function tilePips(count: number, top: number): Array<[number, number]> {
  const half = TILE_W * 0.875
  const centre: [number, number] = [round(TILE_W / 2), round(top + half / 2)]
  const upper: [number, number] = [round(TILE_W * 0.75), round(top + half * 0.27)]
  const lower: [number, number] = [round(TILE_W * 0.25), round(top + half * 0.73)]
  return count === 1 ? [centre] : count === 2 ? [upper, lower] : count === 3 ? [upper, centre, lower] : []
}

/** One tile at the origin: body, divider and pips, each with `kind`'s classes. */
function tileShapes(kind: 'run' | 'lit', layout: readonly [number, number]): string {
  const middle = TILE_H / 2
  const pips = [...tilePips(layout[0], 0), ...tilePips(layout[1], middle)]
  return [
    `<rect class="${kind}-body" width="${TILE_W}" height="${TILE_H}" rx="${round(TILE_W * 0.14)}" />`,
    `<line class="${kind}-div" x1="${round(TILE_W * 0.15)}" y1="${middle}" x2="${round(TILE_W * 0.85)}" y2="${middle}" />`,
    ...pips.map(([x, y]) => `<circle class="${kind}-pip" cx="${x}" cy="${y}" r="${round(TILE_W * 0.075)}" />`),
  ].join('')
}

/** A tile's contact shadow: it stays on the ground while the tile tips about its front foot. */
const SHADOW = `<ellipse class="shadow" cx="${TILE_W / 2}" cy="${TILE_H}" rx="${TILE_W * 0.4}" ry="1.6" />`

/**
 * The drawing: the warmth on the step, the step, the ground (fading in from the left), the run and the lit tile. The
 * step and the ground run on past the view box's right edge, so a plate wider than the drawing shows them going on to
 * its own edge, which clips them; each tile stands in a group of its own for the entrance, and tips in the one inside.
 */
const ART = `<svg class="art" viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
          <defs>
            <radialGradient id="g-warm"><stop offset="0" class="warm-0" /><stop offset="1" class="warm-1" /></radialGradient>
            <linearGradient id="g-ground" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${VIEW_W}" y2="0"><stop offset="0" class="ground-0" /><stop offset="0.18" class="ground-1" /><stop offset="0.86" class="ground-1" /><stop offset="1" class="ground-0" /></linearGradient>
            <linearGradient id="g-step" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="step-0" /><stop offset="1" class="step-1" /></linearGradient>
          </defs>
          <ellipse class="warm" cx="${round(LIT_X + TILE_W / 2)}" cy="${STEP}" rx="80" ry="30" fill="url(#g-warm)" />
          <rect class="step" x="${STEP_X}" y="${STEP}" width="${round(VIEW_W + 100 - STEP_X)}" height="${VIEW_H - STEP}" fill="url(#g-step)" />
          <path class="ground" d="M0 ${GROUND} H${STEP_X} V${STEP} H${VIEW_W + 100}" stroke="url(#g-ground)" />
          <g class="run">${RUN_X.map((x, i) => `<g transform="translate(${x} ${GROUND - TILE_H})"><g class="in in-${i}">${SHADOW}<g class="tip tip-${i}">${tileShapes('run', RUN_PIPS[i])}</g></g></g>`).join('')}</g>
          <g transform="translate(${LIT_X} ${STEP - TILE_H})"><g class="in in-${RUN_X.length}">${SHADOW}<g class="lit">${tileShapes('lit', LIT_PIPS)}</g></g></g>
        </svg>`

/**
 * The motion, sent with a first visit's page alone (data-state="ask"): the entrance, then the loop (each tile's fall,
 * the row's reset, the lit tile's answer). A wrong password, a wait and a pause bring a still drawing.
 */
const loop = (name: string) => `${name} ${LOOP_S}s linear ${ART_DELAY_S}s ${ART_LOOPS}`
const ART_MOTION = [
  `body[data-state="ask"] .run { animation: ${loop('g-run')}; }`,
  ...RUN_X.map((_, i) => `body[data-state="ask"] .tip-${i} { animation: ${loop(`g-tip-${i}`)}; }`),
  `body[data-state="ask"] .lit { animation: ${loop('g-lit')}; }`,
  `body[data-state="ask"] .lit-body { animation: ${loop('g-lit-body')}; }`,
  `body[data-state="ask"] .warm { animation: ${loop('g-warm')}; }`,
  // The entrance: the card rises, the tiles are set up left to right, 50 ms apart.
  `body[data-state="ask"] .card { animation: g-rise 0.7s var(--ease-enter) backwards; }`,
  ...[...RUN_X, LIT_X].map((_, i) => `body[data-state="ask"] .in-${i} { animation: g-in 0.9s var(--ease-enter) ${round(0.2 + i * 0.05)}s backwards; }`),
  `@keyframes g-rise { from { opacity: 0; translate: 0 12px; } }`,
  `@keyframes g-in { from { opacity: 0; translate: 0 8px; } }`,
  `@keyframes g-run { 0%, ${at(6.4)} { opacity: 1; } ${at(6.9)}, ${at(7.2)} { opacity: 0; } ${at(7.8)}, 100% { opacity: 1; } }`,
  ...RUN_X.map((_, i) => tipKeyframes(i)),
  // Touched, the lit tile rocks onto its far foot and settles, and lights up a little; its glow on the step swells, then eases.
  `@keyframes g-lit { 0%, ${at(TOUCH_S)} { rotate: 0deg; animation-timing-function: cubic-bezier(0.2, 0.7, 0.3, 1); } ${at(TOUCH_S + 0.14)} { rotate: 3deg; animation-timing-function: cubic-bezier(0.5, 0, 0.6, 1); } ${at(TOUCH_S + 0.46)}, 100% { rotate: 0deg; } }`,
  `@keyframes g-lit-body { 0%, ${at(TOUCH_S)} { fill: var(--primary); } ${at(TOUCH_S + 0.18)} { fill: var(--primary-lit); } ${at(TOUCH_S + 1.4)}, 100% { fill: var(--primary); } }`,
  `@keyframes g-warm { 0%, ${at(TOUCH_S)} { opacity: 0.55; } ${at(TOUCH_S + 0.4)}, ${at(4.2)} { opacity: 1; } ${at(6.6)}, 100% { opacity: 0.55; } }`,
].join('\n  ')

const KEY_ICON =
  '<svg class="key" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="7" cy="10" r="3.25" /><path d="M10.25 10H17M14.5 10v2.5M16.75 10v2" /></svg>'
const ARROW_ICON = '<svg class="arrow" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8h9.5M8.5 4l4 4-4 4" /></svg>'
const ALERT_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.25" /><path d="M8 4.9v3.6" /><circle class="fill" cx="8" cy="11" r="0.9" /></svg>'

/** The two fonts, where they can be had: every state but `unavailable`, where the gate refuses them too (rule 1). */
const FONT_FACES = `@font-face { font-family: 'Geist'; font-style: normal; font-weight: 400 500; font-display: swap; src: url('${GATE_FONTS[0]}') format('woff2'); }
  @font-face { font-family: 'Instrument Serif'; font-style: normal; font-weight: 400; font-display: swap; src: url('${GATE_FONTS[1]}') format('woff2'); }`

/**
 * The page's style, sent as it is written here (its notes live in this comment, not in the page):
 * - the page: the Home hero's dotted grid (14 by 24.5, a tile's own proportions) fading toward the edges, a warm light
 *   behind the card and a softer one over the header; the card centred in the whole window (the space under it matches
 *   the header above it);
 * - the card: glass over the page's light, a warm ring, a lit lip with a Tangerine light along its top edge, and a soft
 *   fall of shadow under it; the drawing's stage, a dotted plate inset at its top as Home's feature cards hold theirs,
 *   warm under the step; a run tile tips about its front foot, its face its group's colour, which its keyframes warm;
 * - the field: a well sunk into the card with a key at its start, Tangerine when it has focus, red after a wrong
 *   password, which also shakes it once as the page comes back (not on a wait, never without motion);
 * - the button: Tangerine, lit along its top and glowing warm under it; brighter on hover with its arrow nudged on,
 *   pressed in while held; a Tangerine focus ring.
 *
 * A page carries only the parts its state uses (PAGE_STYLE always, FORM_STYLE with the form, ART_MOTION on a first visit,
 * REDUCED_MOTION last): the app reads no more than MAX_PAGE_BYTES (16 KiB, src/lib/read/interpret.ts) of an HTML 503 to
 * find the gate's title in it, so the paused page must stay under that (tests/gate.test.mjs).
 */
const PAGE_STYLE = `
  :root {
    color-scheme: dark;
    --bg: #0d0a08; --card: #14100d; --surface-1: #171310; --surface-2: #1f1a17; --well: #0f0c0a;
    --fg: #f7f1ea; --fg-muted: #c8beb4; --fg-subtle: #9b9289;
    --border: rgb(255 236 220 / 0.07); --border-lip: rgb(255 236 220 / 0.10); --border-card: rgb(255 236 220 / 0.11); --border-strong: rgb(255 236 220 / 0.16);
    --primary: #ff9d62; --primary-hover: #ffb07f; --primary-press: #f28a4c; --primary-lit: #ffbf96; --primary-fg: #24201c; --ring: #ff9d62;
    --money-out: #f4607a;
    --pip: #faf5ea; --line: #ffecdc;
    --dot: rgb(255 236 220 / 0.09); --dot-plate: rgb(255 236 220 / 0.05);
    --tile: #1f1a17; --tile-edge: rgb(255 157 98 / 0.58); --tile-pip: rgb(255 157 98 / 0.78); --tile-lit: #593c2a;
    --inset: inset 0 2px 4px rgb(0 0 0 / 0.35);
    --gutter: 16px; --header-h: 56px;
    --ease-enter: cubic-bezier(0.16, 1, 0.3, 1);
    --font-display: 'Instrument Serif', ui-serif, Georgia, 'Times New Roman', serif;
    --font-sans: 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  @media (min-width: 768px) { :root { --gutter: 24px; --header-h: 72px; } }
  @media (min-width: 1024px) { :root { --gutter: 40px; } }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body {
    position: relative; margin: 0; min-height: 100vh; min-height: 100dvh;
    display: grid; grid-template-rows: auto 1fr;
    background: var(--bg); color: var(--fg);
    font: 14px/20px var(--font-sans); letter-spacing: -0.2px;
    -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
    overflow-x: hidden;
  }
  body::before, body::after { content: ''; position: fixed; inset: 0; pointer-events: none; }
  body::before {
    background-image: radial-gradient(circle at center, var(--dot) 0.9px, transparent 1.4px);
    background-size: 14px 24.5px; background-position: center;
    -webkit-mask-image: radial-gradient(ellipse 62% 60% at 50% 50%, #000 15%, transparent 100%);
    mask-image: radial-gradient(ellipse 62% 60% at 50% 50%, #000 15%, transparent 100%);
  }
  body::after {
    background:
      radial-gradient(ellipse 640px 440px at 50% 46%, rgb(255 157 98 / 0.14), transparent 70%),
      radial-gradient(ellipse 1000px 320px at 50% 0%, rgb(255 157 98 / 0.05), transparent 70%);
  }
  header, main { position: relative; z-index: 1; }
  header { width: 100%; max-width: calc(1200px + 2 * var(--gutter)); height: var(--header-h); margin-inline: auto; padding-inline: var(--gutter); display: flex; align-items: center; }
  .wordmark { display: inline-flex; align-items: center; gap: 8px; }
  .wordmark svg { display: block; flex-shrink: 0; }
  .mark-tile { fill: var(--primary); }
  .mark-rule { fill: var(--primary-fg); opacity: 0.32; }
  .mark-pip { fill: var(--pip); }
  .word { font: 400 24px/24px var(--font-display); letter-spacing: 0; }
  .word span, h1 .dot { color: var(--primary); }
  main { display: grid; place-items: center; padding: 16px var(--gutter) calc(var(--header-h) + 16px); }

  .card {
    position: relative; width: 100%; max-width: 420px; border-radius: 24px;
    background: linear-gradient(180deg, rgb(28 23 20 / 0.84) 0%, rgb(20 16 13 / 0.92) 100%);
    -webkit-backdrop-filter: blur(20px) saturate(140%); backdrop-filter: blur(20px) saturate(140%);
    box-shadow:
      inset 0 1px 0 0 rgb(255 236 220 / 0.08), inset 0 0 0 1px var(--border-card),
      0 1px 2px rgb(0 0 0 / 0.4), 0 24px 48px -20px rgb(0 0 0 / 0.7), 0 56px 120px -40px rgb(0 0 0 / 0.85);
  }
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { .card { background: var(--card); } }
  .card::before {
    content: ''; position: absolute; top: 0; left: 14%; right: 14%; height: 1px; pointer-events: none;
    background: linear-gradient(90deg, transparent, rgb(255 180 132 / 0.7) 50%, transparent);
  }

  .stage {
    position: relative; height: 148px; margin: 8px 8px 0; border-radius: 16px; overflow: hidden;
    background-color: var(--surface-1);
    background-image: radial-gradient(56% 72% at 76% 100%, rgb(255 157 98 / 0.10), transparent 72%), radial-gradient(circle at center, var(--dot-plate) 0.9px, transparent 1.4px);
    background-size: 100% 100%, 14px 24.5px; background-position: 0 0, 7px 12.25px; background-repeat: no-repeat, repeat;
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .eyebrow {
    position: absolute; left: 12px; top: 12px; z-index: 1;
    display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 10px 0 9px;
    border-radius: 9999px; background: rgb(13 10 8 / 0.6); box-shadow: inset 0 0 0 1px var(--border-card);
    color: var(--fg); font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: -0.1px; white-space: nowrap;
  }
  .eyebrow::before { content: ''; width: 6px; height: 6px; flex-shrink: 0; border-radius: 9999px; background: var(--primary); box-shadow: 0 0 0 3px rgb(255 157 98 / 0.16), 0 0 8px rgb(255 157 98 / 0.55); }
  .art { position: absolute; inset: 0; display: block; width: 100%; height: 100%; overflow: visible; }
  .warm-0 { stop-color: var(--primary); stop-opacity: 0.34; }
  .warm-1 { stop-color: var(--primary); stop-opacity: 0; }
  .warm { opacity: 0.55; }
  .ground-0 { stop-color: var(--line); stop-opacity: 0; }
  .ground-1 { stop-color: var(--line); stop-opacity: 0.16; }
  .step-0 { stop-color: var(--line); stop-opacity: 0.07; }
  .step-1 { stop-color: var(--line); stop-opacity: 0; }
  .ground { fill: none; stroke-width: 1.25px; stroke-linejoin: round; }
  .shadow { fill: rgb(0 0 0 / 0.5); }
  .tip { color: var(--tile); transform-box: fill-box; transform-origin: 100% 100%; }
  .run-body { fill: currentColor; stroke: var(--tile-edge); stroke-width: 1.25px; }
  .run-div { stroke: var(--tile-edge); stroke-width: 1px; stroke-linecap: round; }
  .run-pip { fill: var(--tile-pip); }
  .lit { transform-box: fill-box; transform-origin: 100% 100%; }
  .lit-body { fill: var(--primary); }
  .lit-div { stroke: var(--primary-fg); stroke-opacity: 0.28; stroke-width: 1px; stroke-linecap: round; }
  .lit-pip { fill: var(--primary-fg); }

  .content { padding: 22px 28px 28px; text-align: center; }
  h1 { margin: 0; font: 400 40px/44px var(--font-display); letter-spacing: -0.3px; text-wrap: balance; }
  .lede { margin: 8px auto 0; max-width: 32ch; color: var(--fg-muted); font-size: 15px; line-height: 22px; text-wrap: pretty; }
  @media (min-width: 768px) { .word { font-size: 26px; line-height: 26px; } }
  @media (max-width: 479px) {
    .card { border-radius: 22px; }
    .stage { height: 128px; border-radius: 14px; }
    .content { padding: 20px 20px 22px; }
    h1 { font-size: 34px; line-height: 38px; }
    .lede { font-size: 14px; line-height: 20px; }
  }
  @media (forced-colors: active) {
    body::before, body::after, .card::before { display: none; }
    .card { border: 1px solid CanvasText; }
  }
`

const FORM_STYLE = `
  .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
  form { margin-top: 24px; text-align: left; }
  .field { position: relative; }
  input {
    display: block; width: 100%; height: 50px; margin: 0; padding: 0 16px 0 44px;
    border: 0; border-radius: 14px; background: var(--well); color: var(--fg); caret-color: var(--primary);
    box-shadow: inset 0 0 0 1px var(--border-lip), var(--inset);
    font: 400 15px/20px var(--font-sans); letter-spacing: -0.1px;
    outline: 2px solid transparent; outline-offset: 2px;
    transition: box-shadow .15s ease;
  }
  input::placeholder { color: var(--fg-subtle); opacity: 1; letter-spacing: -0.1px; }
  input:not(:placeholder-shown) { letter-spacing: 0.12em; }
  input:hover { box-shadow: inset 0 0 0 1px var(--border-strong), var(--inset); }
  input:focus-visible { box-shadow: inset 0 0 0 1px var(--ring), var(--inset), 0 0 0 4px rgb(255 157 98 / 0.18); }
  input[aria-invalid="true"] { box-shadow: inset 0 0 0 1px var(--money-out), var(--inset), 0 0 0 4px rgb(244 96 122 / 0.10); }
  input[aria-invalid="true"]:focus-visible { box-shadow: inset 0 0 0 1px var(--money-out), var(--inset), 0 0 0 4px rgb(244 96 122 / 0.18); }
  input:-webkit-autofill { -webkit-text-fill-color: var(--fg); caret-color: var(--fg); box-shadow: inset 0 0 0 1px var(--border-lip), inset 0 0 0 50px var(--well); }
  input:-webkit-autofill:focus-visible { box-shadow: inset 0 0 0 1px var(--ring), inset 0 0 0 50px var(--well), 0 0 0 4px rgb(255 157 98 / 0.18); }
  input[aria-invalid="true"]:-webkit-autofill { box-shadow: inset 0 0 0 1px var(--money-out), inset 0 0 0 50px var(--well); }
  .key { position: absolute; left: 15px; top: 50%; width: 18px; height: 18px; margin-top: -9px; color: var(--fg-subtle); pointer-events: none; transition: color .15s ease; }
  .key, .arrow, .error svg { fill: none; stroke: currentColor; stroke-width: 1.5px; stroke-linecap: round; stroke-linejoin: round; }
  input:focus-visible ~ .key { color: var(--primary); }
  input[aria-invalid="true"] ~ .key { color: var(--money-out); }
  .error { display: flex; align-items: flex-start; gap: 8px; margin: 10px 2px 0; font-size: 13px; line-height: 18px; color: var(--money-out); }
  .error svg { flex-shrink: 0; width: 16px; height: 16px; margin-top: 1px; }
  .error svg .fill { fill: currentColor; stroke: none; }
  body[data-state="wrong"] .field { animation: g-shake 0.42s cubic-bezier(0.36, 0.07, 0.19, 0.97) 0.12s; }
  @keyframes g-shake { 20% { translate: -6px 0; } 40% { translate: 5px 0; } 60% { translate: -3px 0; } 80% { translate: 2px 0; } }

  button {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; height: 50px; margin: 14px 0 0; padding: 0 20px;
    border: 0; border-radius: 14px; cursor: pointer;
    background: var(--primary); color: var(--primary-fg);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.28), inset 0 -1px 0 rgb(0 0 0 / 0.10), 0 1px 2px rgb(0 0 0 / 0.35), 0 10px 24px -12px rgb(255 157 98 / 0.55);
    font: 500 15px/20px var(--font-sans); letter-spacing: -0.2px;
    transition: background-color .15s ease, box-shadow .15s ease, scale .1s cubic-bezier(0.4, 0, 0.2, 1);
    -webkit-tap-highlight-color: transparent;
  }
  .arrow { width: 16px; height: 16px; stroke-width: 1.6px; transition: translate .2s var(--ease-enter); }
  button:hover { background: var(--primary-hover); box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.32), inset 0 -1px 0 rgb(0 0 0 / 0.10), 0 1px 2px rgb(0 0 0 / 0.35), 0 12px 30px -12px rgb(255 157 98 / 0.75); }
  button:hover .arrow { translate: 3px 0; }
  button:active { background: var(--primary-press); scale: 0.985; box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.22), 0 1px 1px rgb(0 0 0 / 0.3); }
  button:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }
  @media (max-width: 479px) { form { margin-top: 20px; } }
  @media (forced-colors: active) { input, button { border: 1px solid CanvasText; } }
`

/** Last on every page: where the system asks for reduced motion, nothing moves at all. */
const REDUCED_MOTION = `  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`

/**
 * The access page. Self-contained: the app's upright tile mark and wordmark (src/components/Header.tsx), and its warm
 * palette (src/styles/tokens.css), inlined; its two fonts from GATE_FONTS. Dark only, like the app (owner, 2026-09-26:
 * dark only): the viewer's system setting is not consulted. Its one script, GATE_SCRIPT, carries the opened link
 * through the login; `next` is that link again on a page the login answers (a wrong password, a wait), checked here.
 *
 * Changed on purpose 2026-10-03 (the owner: "I don't like the password screen. It also says 'Robinhood Chain': that
 * isn't needed, Domino is becoming multi-chain. It lacks depth, it lacks life."): no chain is named in any state (the
 * footer that said "Robinhood Chain" is gone), and the page is drawn in the Home hero's family: the hero's dotted grid
 * lit warm behind a glass card with a Tangerine edge light, the card's drawing (ART) on a dotted plate, fewer words (the
 * field is named by its placeholder, and by a label read aloud but not shown), a Tangerine button with a pressed state,
 * a Tangerine focus ring and a red, shaken field after a wrong password. Still nothing from another host, no other script
 * and the same CSP (PAGE_CSP): the drawing and its motion are inline SVG and CSS, and prefers-reduced-motion stills
 * everything. While access is paused (`unavailable`) nothing moves, and the gate refuses the fonts too (rule 1 comes
 * first), so that page names none and is set in the system's serif and sans, the same layout.
 */
export function accessPage(state: PageState, next = ''): string {
  const link = nextHash(next)
  const message = (text: string) => `<p id="error" class="error" role="alert">${ALERT_ICON}<span>${text}</span></p>`
  const notice =
    state === 'wrong'
      ? message('That password didn’t work. Check it and try again.')
      : state === 'wait'
        ? message('Too many tries in a row. Wait a minute, then try again.')
        : ''
  const fonts = state !== 'unavailable'
  const form = state !== 'unavailable'
  const body =
    state === 'unavailable'
      ? `<h1>Access is paused<span class="dot">.</span></h1>
        <p class="lede">Nothing is wrong on your side.</p>`
      : `<h1>You’re early<span class="dot">.</span></h1>
        <p class="lede">Enter the password from your invitation.</p>
        <form method="post" action="/__beta/login" novalidate>
          <label class="sr-only" for="password">Access password</label>
          <div class="field">
            <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Access password"
              required autofocus spellcheck="false" autocapitalize="off"${notice ? ' aria-invalid="true" aria-describedby="error"' : ''} />
            ${KEY_ICON}
          </div>
          ${notice}
          <input id="next" name="next" type="hidden" value="${link}" />
          <button type="submit"><span>Enter Domino</span>${ARROW_ICON}</button>
        </form>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="color-scheme" content="dark" />
<meta name="theme-color" content="#0d0a08" />
<title>Domino · Access</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON}" />${
    fonts
      ? `
<link rel="preload" href="${GATE_FONTS[0]}" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="${GATE_FONTS[1]}" as="font" type="font/woff2" crossorigin />`
      : ''
  }
<style>
  ${fonts ? FONT_FACES : ''}${PAGE_STYLE}${form ? FORM_STYLE : ''}${state === 'ask' ? `  ${ART_MOTION}\n` : ''}${REDUCED_MOTION}</style>
</head>
<body data-state="${state}">
  <header>
    <span class="wordmark">
      <svg width="16" height="28" viewBox="0 0 20 34" aria-hidden="true">
        <rect class="mark-tile" x="0.6" y="0.6" width="18.8" height="32.8" rx="2.6" />
        <rect class="mark-rule" x="2.2" y="16.6" width="15.6" height="0.9" rx="0.45" />
        <circle class="mark-pip" cx="14.1" cy="5.85" r="1.95" />
        <circle class="mark-pip" cx="6.05" cy="12.7" r="1.95" />
        <circle class="mark-pip" cx="9.62" cy="25.2" r="1.95" />
      </svg>
      <span class="word">domino<span>.</span></span>
    </span>
  </header>
  <main>
    <div class="card">
      <div class="stage">
        <span class="eyebrow">Invitation only</span>
        ${ART}
      </div>
      <div class="content">
        ${body}
      </div>
    </div>
  </main>
  <script>${GATE_SCRIPT}</script>
</body>
</html>`
}
