/**
 * React bindings for the preview controller. One controller per mounted form:
 * it follows the session and the budget only while mounted, and unmounting
 * stops it, which aborts anything in flight, clears its timers and drops any
 * preview, so a preview never outlives the screen that asked for it.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createPreviewController, type ControllerView, type PreviewDeps } from './controller'
import type { BuildResult } from './inputs'
import type { OnboardingRoute } from './types'

export interface PreviewHandle<R extends OnboardingRoute> {
  view: ControllerView<R>
  request(): void
}

export function usePreview<R extends OnboardingRoute>(route: R, deps: PreviewDeps, form: BuildResult<R>): PreviewHandle<R> {
  const controller = useMemo(() => createPreviewController(route, deps), [route, deps])
  useEffect(() => controller.start(), [controller])
  useEffect(() => {
    controller.setForm(form)
  }, [controller, form])
  const view = useSyncExternalStore(controller.subscribe, controller.getView)
  return { view, request: () => controller.request() }
}

export const useSwapPreview = (deps: PreviewDeps, form: BuildResult<'swap-preview'>) => usePreview('swap-preview', deps, form)
export const usePositionPreview = (deps: PreviewDeps, form: BuildResult<'position-preview'>) => usePreview('position-preview', deps, form)
