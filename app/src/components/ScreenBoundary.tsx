import { Component, type ReactNode } from 'react'

/** A routed screen that couldn't load or draw: one quiet line in the screen's own page frame (App.tsx screenFailed). */
export const ScreenFailed = () => (
  <main className="dm-page">
    <p role="alert" className="text-body text-fg-muted">
      This page couldn’t load. Reload to try again.
    </p>
  </main>
)

interface Props {
  /** The page and its parameter: a move to another one draws the screen again. */
  route: string
  children: ReactNode
}

/**
 * Keeps a screen that throws as it draws from taking the page down with it (2026-10-14, incident X1). React unmounted
 * the whole app, and the visitor was left on a blank page with no header and no way on. App.tsx draws the header and
 * the footer outside this, so they stay; ScreenFailed stands in for the screen. React itself still writes the error to
 * the console (react-dom's default onCaughtError is console.error), so nothing is hidden. The stand-in lasts until the
 * route changes; a screen that never threw is not remounted by a route change, as before.
 */
export class ScreenBoundary extends Component<Props, { route: string; failed?: boolean }> {
  state = { route: this.props.route, failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  static getDerivedStateFromProps({ route }: Props, state: { route: string }) {
    return route === state.route ? null : { route, failed: false }
  }

  render() {
    return this.state.failed ? <ScreenFailed /> : this.props.children
  }
}
