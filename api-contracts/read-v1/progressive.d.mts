import type { ReadRequests, ReadResponses } from './types.js';
export type Retained<R extends keyof ReadRequests> = { data: ReadResponses[R]; receivedAt: number } | null;
export type ReadState<R extends keyof ReadRequests> =
  | { status: 'queued' | 'loading'; retained: Retained<R> }
  | { status: 'backoff'; retryAt: number; retained: Retained<R> }
  | { status: 'ready'; data: ReadResponses[R]; retained: Retained<R> }
  | { status: 'error'; error: unknown; retained: Retained<R> };
export function createProgressiveReader(options?: { fetch?: typeof fetch; now?: () => number; random?: () => number;
  intervalMs?: number; maxPending?: number; maxRetained?: number; maxRetries?: number; budgetMs?: number }): {
  read<R extends keyof ReadRequests>(route: R, body: ReadRequests[R], options?: { signal?: AbortSignal; onState?: (state: ReadState<R>) => void }): Promise<ReadResponses[R]>;
  dispose(): void;
};
