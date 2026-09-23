/** All financial HTTP clients use the same-origin boundary and bounded parser. */
export const financialFetch: (url: string, init: RequestInit) => Promise<Response> =
  (url, init) => window.fetch(url, init)
