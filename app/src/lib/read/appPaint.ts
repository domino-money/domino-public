/**
 * This browser's copy of the last stored overview (marketsPaint.ts), the deployable build's alone: the markets
 * provider paints Home and Markets from it (bridgeMarkets.ts), the featured list gives its first read longer when there
 * is none (featuredSource.ts), and a pool's page paints from it (screens/PoolDetail.tsx). Added 2026-09-28 (speed wave,
 * items 8 and 44), when the second and third users came; the copy itself is unchanged. Null in the test builds, which
 * keep nothing in the browser.
 */
import * as publicRuntime from 'api-contracts/read-v3/runtime.mjs'
import { createPaintMemory, type PaintMemory } from './marketsPaint'

export const appPaint: PaintMemory | null = __DOMINO_POOL_SET__ === 'selected' ? createPaintMemory(() => localStorage, publicRuntime) : null
