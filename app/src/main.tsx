import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import App from './App'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

// The read lab (src/lab/main.tsx) marks its document: this module is reached
// from there through a chunk the read screens share with the app, and must
// not mount the app over the lab's own root.
if (!('dominoLab' in document.documentElement.dataset)) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
