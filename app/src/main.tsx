import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import App, { parseHash } from './App'
import { parseExploreHash } from './components/explore/routes'
import { startMarkets } from './lib/read/buildMode'
import { startLoadTimings } from './lib/loadTiming'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

// The read lab (src/lab/main.tsx) marks its document: this module is reached
// from there through a chunk the read screens share with the app, and must
// not mount the app over the lab's own root.
if (!('dominoLab' in document.documentElement.dataset)) {
  startLoadTimings(window)
  // Home and Markets ask for their pools now, not once the page has rendered (speed wave, item 9, 2026-09-28). A
  // token's own view on Markets (#/markets/<address>) shows no list, and asks for none.
  const { page } = parseHash(window.location.hash)
  if (page === 'overview' || (page === 'markets' && !parseExploreHash(window.location.hash).token)) startMarkets()
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
