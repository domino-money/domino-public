/**
 * Says so when this is not the deployable build. Rendered only by fixture and
 * bridge-test builds; the default build folds it away.
 */
export function BuildBanner({ mode }: { mode: 'fixture' | 'bridge' }) {
  return (
    <div role="note" className="border-b bg-money-wait-bg px-5 py-2 text-center text-[0.75rem] text-money-wait" data-build-banner={mode}>
      {mode === 'fixture'
        ? 'Fixture build: read-v1 contract fixtures through the real read pipeline. Not observations, not deployable.'
        : 'Bridge test build: live reads against a local bridge stub. Not deployable.'}
    </div>
  )
}
