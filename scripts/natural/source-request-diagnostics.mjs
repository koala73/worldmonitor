import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';

const scope = new AsyncLocalStorage();
const requests = new WeakMap();
let activeScopes = 0;

function update(request, change) {
  const state = requests.get(request);
  if (state?.active && state.request === request) change(state.progress);
}

const listeners = [
  ['undici:request:create', ({ request }) => {
    const state = scope.getStore();
    if (!state?.active) return;
    state.request = request;
    state.progress = {
      observed: true,
      requestCount: state.progress.requestCount + 1,
      requestSendObserved: false,
      responseHeadersObserved: false,
      wireBodyBytes: null,
      firstBodyByteMs: null,
      lastBodyByteMs: null,
      wireBodyComplete: false,
    };
    requests.set(request, state);
  }],
  ['undici:client:sendHeaders', ({ request }) => update(request, progress => {
    progress.requestSendObserved = true;
  })],
  ['undici:request:headers', ({ request }) => update(request, progress => {
    progress.responseHeadersObserved = true;
  })],
  ['undici:request:bodyChunkReceived', ({ request, chunk }) => {
    const state = requests.get(request);
    if (!state?.active || state.request !== request) return;
    const elapsed = Math.round(performance.now() - state.started);
    state.progress.wireBodyBytes = (state.progress.wireBodyBytes ?? 0) + chunk.byteLength;
    state.progress.firstBodyByteMs ??= elapsed;
    state.progress.lastBodyByteMs = elapsed;
  }],
  ['undici:request:trailers', ({ request }) => update(request, progress => {
    progress.wireBodyComplete = true;
  })],
].map(([name, listener]) => [channel(name), listener]);

// Native request identities keep pooled connections and concurrent fetches separate.
// Counters cover the latest redirect hop and encoded payload bytes. A local send
// observation does not prove remote receipt; wire completion does not prove JSON validity.
// Bytes remain unknown until a chunk is observed: not all transports emit chunk events.
export async function withSourceRequestDiagnostics(operation) {
  const state = { active: true, started: performance.now(), request: null, progress: { observed: false, requestCount: 0 } };
  if (activeScopes++ === 0) {
    for (const [event, listener] of listeners) event.subscribe(listener);
  }
  try {
    return await scope.run(state, () => operation(() => ({ ...state.progress })));
  } finally {
    state.active = false;
    state.request = null;
    if (--activeScopes === 0) {
      for (const [event, listener] of listeners) event.unsubscribe(listener);
    }
  }
}
