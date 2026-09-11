/**
 * Set by vite.config.ts from the build mode, never from the environment.
 *
 * `sample` in every build that can be deployed or previewed. Comparisons with
 * it are constant-folded, so the fixture and bridge branches, and every module
 * only they import, are absent from the default bundle, which a test checks.
 */
declare const __DOMINO_READ_MODE__: 'sample' | 'fixture' | 'bridge'
