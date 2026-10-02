/**
 * The other screens' files, fetched while the page sits idle (2026-10-01, platform workstream, F1).
 *
 * Every screen but Home is a chunk of its own now, so Home paints without them; but a first move to another screen
 * would wait for its chunk, where it used to be in the entry. Once the page has loaded and gone quiet, this asks the
 * browser for the main screens' files with <link rel="prefetch">: at the lowest priority, into the HTTP cache only, so
 * nothing the page is reading waits for them, and a prefetch that fails changes nothing (the import fetches the file
 * itself when it is needed). The list is the one the build wrote into the page for its boot script
 * (functions/_lib/boot.ts). A connection that asks to save data, or a 2G one, gets none of it.
 */

/** The routes worth having before they are opened: the main navigation's screens and a position's page. */
export const PREFETCHED = Object.freeze(['markets', 'positions', 'position', 'pool', 'new', 'automate', 'docs'])

interface DocumentLike {
  getElementById(id: string): { textContent: string | null } | null
  querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null }>
  createElement(tag: 'link'): { rel: string; as: string; crossOrigin: string | null; setAttribute(name: string, value: string): void }
  head: { appendChild(node: unknown): unknown }
}

/** Adds the prefetch links, once per file; says how many. */
export function prefetchRoutes(doc: DocumentLike = document as unknown as DocumentLike, connection: { saveData?: boolean; effectiveType?: string } | undefined = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection): number {
  if (connection?.saveData === true || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return 0
  let chunks: Record<string, unknown> = {}
  try {
    const data = JSON.parse(doc.getElementById('dm-boot')?.textContent ?? 'null') as { chunks?: Record<string, unknown> } | null
    chunks = data && typeof data.chunks === 'object' && data.chunks !== null ? data.chunks : {}
  } catch {
    return 0
  }
  const known = new Set(Array.from(doc.querySelectorAll('link[href], script[src]'), (node) => node.getAttribute('href') ?? node.getAttribute('src')))
  let added = 0
  for (const route of PREFETCHED) {
    const files = chunks[route]
    if (!Array.isArray(files)) continue
    for (const file of files) {
      if (typeof file !== 'string' || !/^\/assets\/[\w.-]+\.(?:js|css)$/.test(file) || known.has(file)) continue
      known.add(file)
      const link = doc.createElement('link')
      link.rel = 'prefetch'
      // As the app's own loader asks for them (crossorigin, anonymous), so the cached copy is the one it takes.
      link.as = file.endsWith('.css') ? 'style' : 'script'
      link.crossOrigin = ''
      link.setAttribute('href', file)
      doc.head.appendChild(link)
      added += 1
    }
  }
  return added
}
