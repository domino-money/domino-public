/**
 * Whether the second chain's section is open where the page is served (2026-10-01, the chain2 workstream; flag.ts says
 * why it is decided this way), on its own (part B): the app's menu asks it on every page (components/HeaderMenu.tsx), so
 * this module imports nothing at run time, and the menu brings neither the chain's record nor the API forwarder's
 * tables into the page every visitor downloads. The site's two origins are copies of functions/_lib/bridge.ts APP_ORIGIN
 * and PREVIEW_ORIGIN (importing that module would bring its family tables with them), held equal to it by
 * tests/elysium-adapter.test.mjs.
 *
 * Pure: the origin is handed in.
 */
import type { Deployment } from '../../config/chainKit'

export type SectionMode = 'off' | 'preview' | 'live'

/** The site's own origin (copy: functions/_lib/bridge.ts APP_ORIGIN). */
export const SITE_ORIGIN = 'https://domino.money'
/** The single gated Pages preview alias (copy: functions/_lib/bridge.ts PREVIEW_ORIGIN). */
export const PREVIEW_ALIAS = 'https://preview.domino-app-e65.pages.dev'
/** The Vite development server (vite.config.ts server.port). */
export const DEV_ORIGIN = 'http://localhost:5273'

/**
 * Whether the section has a source it may read the chain from (2026-10-02, review of the RPC switch, finding 1). Its
 * pools, positions and vaults are read from the chain itself, and the only line to the Elysium testnet it has is that
 * network's public RPC (config/chainElysium.ts ELYSIUM.rpc), read from the browser. The owner's final decision of
 * 2026-10-01 is that the site reads nothing from a public RPC, on the preview too: so the section is closed everywhere,
 * preview alias and development server included, until rugged97 serves its reads through this site's own route
 * (/uniswap-v3/*, functions/uniswap-v3/[[path]].ts) and transport.ts reads them there. Then this turns true, and the
 * rule below holds again unchanged. functions/_middleware.ts APP_CSP_CHAIN2 names no host of that network meanwhile.
 */
export const SECTION_READS: boolean = false

/**
 * The section's mode at `origin` for a chain whose deployment is in the registry with `deployment.status`: `off`
 * everywhere while it has nothing it may read (`reads`, SECTION_READS); else, on the site, `live` once the deployment is
 * qualified and `off` until then; on the preview alias and the development server, `preview`; anywhere else (a hash
 * deployment, a copy of the site), `off`.
 */
export function sectionMode(origin: string, chain: { readonly deployment: Pick<Deployment, 'status'> }, reads: boolean = SECTION_READS): SectionMode {
  if (!reads) return 'off'
  if (origin === SITE_ORIGIN) return chain.deployment.status === 'qualified' ? 'live' : 'off'
  if (origin === PREVIEW_ALIAS || origin === DEV_ORIGIN) return 'preview'
  return 'off'
}

/** Whether the menu links the section at `origin`: wherever its mode is not off, by the same rule. */
export const sectionLinked = (origin: string, status: Deployment['status'], reads: boolean = SECTION_READS): boolean => sectionMode(origin, { deployment: { status } }, reads) !== 'off'
