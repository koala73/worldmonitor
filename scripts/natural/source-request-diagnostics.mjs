import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { randomUUID } from 'node:crypto';

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
      requestId: randomUUID(),
      startedAt: new Date().toISOString(),
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
  ['undici:request:headers', ({ request, response }) => update(request, progress => {
    if (response.statusCode < 200) return;
    progress.responseHeadersObserved = true;
    progress.statusCode = response.statusCode;
    const headers = response.headers;
    const entries = Array.isArray(headers)
      ? headers.flatMap((name, i) => i % 2 === 0 ? [[name, headers[i + 1]]] : [])
      : Object.entries(headers);
    for (const [rawName, rawValue] of entries) {
      const name = rawName.toString().toLowerCase();
      if (name !== 'content-type' && name !== 'x-request-id' && name !== 'cf-ray') continue;
      const value = rawValue.toString();
      if (name === 'content-type') {
        const type = value.split(';', 1)[0].trim().toLowerCase();
        if (['application/json', 'text/html', 'text/plain', 'application/problem+json'].includes(type)) progress.contentType = type;
      } else if (/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
        progress[name === 'cf-ray' ? 'cfRay' : 'responseRequestId'] = value;
      }
    }
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
