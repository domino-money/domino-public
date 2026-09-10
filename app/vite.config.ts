import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// `core` points at the workbench's domain modules. They belong to rugged97 and
// are consumed read-only: never copied into app/, never edited from here. A fix
// he makes in web/lib reaches this app without any action on our side.
//
// Those modules live under web/ and import React themselves. Node resolution
// would give them web/node_modules/react while this app renders with
// app/node_modules/react, so a hook called from web/lib would run against a
// second React with a null dispatcher. That is invisible in dev and produces a
// blank production page. React and React DOM are therefore pinned to this
// app's copies for every module in the graph, wherever it sits on disk.
const reactRoot = here('./node_modules/react')
const reactDomRoot = here('./node_modules/react-dom')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    alias: [
      { find: '@', replacement: here('./src') },
      { find: 'core', replacement: here('../web/lib') },
      // Exact matches only, so react-dom/client and react/jsx-runtime still resolve.
      { find: /^react$/, replacement: reactRoot },
      { find: /^react-dom$/, replacement: reactDomRoot },
    ],
  },
  server: {
    port: 5273,
    // Required because `core` resolves outside this project root.
    fs: { allow: [here('.'), here('../web')] },
  },
})
