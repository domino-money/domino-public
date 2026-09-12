import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/tokens.css'

/**
 * Entry of the read lab: every read-v1 fixture case, rendered by the real
 * components, for tests/read-states.browser.test.mjs and for a look by hand.
 *
 * The default build does not include this page at all. The dev server still
 * serves read-lab.html in every mode, so outside the fixture build it says
 * where the lab lives and loads nothing.
 */
const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

if (__DOMINO_READ_MODE__ === 'fixture' && window.location.hash.startsWith('#screens')) {
  // The read screens' cases, one per page: read-lab.html#screens/<case>.
  const caseId = window.location.hash.slice('#screens/'.length)
  void import('./screensCases').then(({ ScreensLab }) =>
    createRoot(root).render(
      <StrictMode>
        <ScreensLab caseId={caseId} />
      </StrictMode>,
    ),
  )
} else if (__DOMINO_READ_MODE__ === 'fixture') {
  void import('./ReadLab').then(({ ReadLab }) =>
    createRoot(root).render(
      <StrictMode>
        <ReadLab />
      </StrictMode>,
    ),
  )
} else {
  root.textContent = 'The read lab exists only in the fixture build: npm run dev:fixtures.'
}
