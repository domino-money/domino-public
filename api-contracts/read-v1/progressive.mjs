import { CONTRACT_VERSION, assertRequest, assertResponse, validateError } from './runtime.mjs';

const retainedRoutes = new Set(['token', 'pools', 'pool-market', 'catalogue', 'pool-activity', 'pool-metrics']);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const failure = (code, status = 0) => Object.assign(new Error(code), { code, status });
const abortError = () => new DOMException('Read selection cancelled', 'AbortError');

/** One screen's bounded serial reads. No timers survive dispose; no background polling. */
export function createProgressiveReader({ fetch: fetchImpl = globalThis.fetch, now = Date.now,
  random = Math.random, intervalMs = 1100, maxPending = 12, maxRetained = 6,
  maxRetries = 2, budgetMs = 60000 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof random !== 'function' ||
      !Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 10000 ||
      !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 20 ||
      !Number.isInteger(maxRetained) || maxRetained < 0 || maxRetained > 12 ||
      !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3 ||
      !Number.isInteger(budgetMs) || budgetMs < 1000 || budgetMs > 60000) throw failure('invalid_reader_options');
  const pending = new Map(), retained = new Map(), queue = [];
  let running = false, disposed = false, nextStart = 0;
  const emit = (sub, state) => { try { sub.onState?.(state); } catch { /* UI observers cannot change admission. */ } };
  const remaining = job => Math.max(0, job.expires - now());
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason ?? abortError());
      const timer = setTimeout(done, ms);
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason ?? abortError()); };
      function done() { signal.removeEventListener('abort', abort); resolve(); }
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  async function execute(job) {
    for (let attempt = 0; ; attempt++) {
      await sleep(Math.max(0, nextStart - now()), job.controller.signal);
      if (remaining(job) === 0) throw failure('read_deadline_exceeded');
      nextStart = now() + intervalMs;
      for (const sub of job.subscribers) emit(sub, { status: 'loading', retained: retained.get(job.key) ?? null });
      const response = await fetchImpl('/api/read/v1/' + job.route, {
        method: 'POST', credentials: 'same-origin', redirect: 'error', signal: job.controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': CONTRACT_VERSION },
        body: job.body,
      });
      if (job.controller.signal.aborted) throw job.controller.signal.reason ?? abortError();
      if (response.headers.get('X-Domino-Read-Contract') !== CONTRACT_VERSION) throw failure('upstream_contract_mismatch', 502);
      let payload;
      try { payload = await response.json(); } catch { throw failure('upstream_invalid_response', 502); }
      if (job.controller.signal.aborted || remaining(job) === 0) throw job.controller.signal.reason ?? failure('read_deadline_exceeded');
      if (response.status === 200) return assertResponse(job.route, payload);
      if (!validateError(response.status, payload)) throw failure('upstream_contract_mismatch', 502);
      if (response.status !== 429 || attempt >= maxRetries) throw failure(payload.error, response.status);
      const header = response.headers.get('Retry-After');
      const seconds = /^(?:[1-9]|[1-5][0-9]|60)$/.test(header ?? '') ? Number(header) : 1;
      const jitter = Math.min(1, Math.max(0, random()));
      const retryMs = seconds * 1000 + Math.floor((Number.isFinite(jitter) ? jitter : 0) * 250);
      nextStart = Math.max(nextStart, now() + retryMs);
      for (const sub of job.subscribers) emit(sub, { status: 'backoff', retryAt: nextStart, retained: retained.get(job.key) ?? null });
    }
  }
  async function pump() {
    if (running || disposed) return;
    running = true;
    try {
      while (queue.length && !disposed) {
        const job = queue.shift();
        if (!job.subscribers.size) continue;
        let payload, error;
        try {
          // A deadline race also releases the helper if an injected transport ignores abort.
          payload = await Promise.race([execute(job), new Promise((_, reject) => {
            job.controller.signal.addEventListener('abort', () => reject(job.controller.signal.reason ?? abortError()), { once: true });
          })]);
        } catch (caught) { error = caught; }
        if (pending.get(job.key) === job) pending.delete(job.key); clearTimeout(job.timer);
        if (!error && retainedRoutes.has(job.route) && maxRetained) {
          retained.delete(job.key); retained.set(job.key, { data: payload, receivedAt: now() });
          while (retained.size > maxRetained) retained.delete(retained.keys().next().value);
        }
        for (const sub of [...job.subscribers]) {
          sub.signal?.removeEventListener('abort', sub.abort);
          emit(sub, { status: error ? 'error' : 'ready', ...(error ? { error } : { data: payload }), retained: retained.get(job.key) ?? null });
          if (error) sub.reject(error); else sub.resolve(payload);
        }
        job.subscribers.clear();
      }
    } finally { running = false; }
  }
  return {
    read(route, request, { signal, onState } = {}) {
      if (disposed) return Promise.reject(failure('reader_disposed'));
      if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
      let body;
      try { body = JSON.stringify(stable(assertRequest(route, request))); } catch (error) { return Promise.reject(error); }
      const key = route + ':' + body;
      let job = pending.get(key);
      if (!job) {
        if (pending.size >= maxPending) return Promise.reject(failure('screen_read_capacity'));
        job = { key, route, body, subscribers: new Set(), controller: new AbortController(), expires: now() + budgetMs };
        job.timer = setTimeout(() => job.controller.abort(failure('read_deadline_exceeded')), budgetMs);
        pending.set(key, job); queue.push(job);
      }
      const promise = new Promise((resolve, reject) => {
        const sub = { resolve, reject, signal, onState };
        sub.abort = () => {
          job.subscribers.delete(sub); signal?.removeEventListener('abort', sub.abort); reject(signal?.reason ?? abortError());
          if (!job.subscribers.size) {
            pending.delete(key); clearTimeout(job.timer); job.controller.abort(abortError());
            const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
          }
        };
        job.subscribers.add(sub); signal?.addEventListener('abort', sub.abort, { once: true });
        emit(sub, { status: 'queued', retained: retained.get(key) ?? null });
      });
      void pump(); return promise;
    },
    dispose() {
      disposed = true; retained.clear(); queue.length = 0;
      for (const job of pending.values()) {
        clearTimeout(job.timer); job.controller.abort(abortError());
        for (const sub of job.subscribers) { sub.signal?.removeEventListener('abort', sub.abort); sub.reject(abortError()); }
        job.subscribers.clear();
      }
      pending.clear();
    },
  };
}
