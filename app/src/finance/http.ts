import type { FetchLike } from '../lib/http/rawReply'

/** All financial HTTP clients use the same-origin boundary and bounded parser. */
export const financialFetch: FetchLike = (url, init) => window.fetch(url, init)
