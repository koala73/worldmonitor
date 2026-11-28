import { createRequire } from 'node:module';
import ts from 'typescript';
import { Agent, Dispatcher1Wrapper } from 'undici';

const require = createRequire(import.meta.url);
const { assertNotificationWebhookDeliveryUrlSafe, isBlockedResolvedAddress } = require('./notification-webhook-ssrf.cjs');

// Read catalog data without loading mcp-store's browser/storage dependencies.
// An unsupported entry must fail the monitor, never silently lose coverage.
export function extractPresets(source) {
  const file = ts.createSourceFile('mcp-store.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(node => ts.isIdentifier(node.name) && node.name.text === 'MCP_PRESETS');
  const array = declaration?.initializer;
  if (file.parseDiagnostics.length || !array || !ts.isArrayLiteralExpression(array) || !array.elements.length) {
    throw new Error('Could not read non-empty MCP_PRESETS catalog');
  }
  return array.elements.map(element => {
    if (!ts.isObjectLiteralExpression(element) || element.properties.some(ts.isSpreadAssignment)) {
      throw new Error('MCP_PRESETS entries must be explicit objects');
    }
    const preset = {};
    for (const key of ['name', 'serverUrl', 'defaultTool', 'authNote']) {
      const property = element.properties.find(node => node.name?.text === key);
      if (!property && key !== 'name' && key !== 'serverUrl') continue;
      if (!property || !ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) {
        throw new Error(`MCP_PRESETS ${key} must be a string literal`);
      }
      preset[key] = property.initializer.text;
    }
    return preset;
  });
}

export function isTemplatePreset(preset) {
  const host = new URL(preset.serverUrl).hostname;
  return ['example.com', 'example.net', 'example.org'].some(domain => host === domain || host.endsWith(`.${domain}`));
}

// The monitor's verdict must not be STRICTER than what the proxy can actually
// serve, or it reports an outage for traffic that works. api/mcp-proxy.ts
// follows exactly one method-preserving hop, https-only, so this mirrors that
// boundary rather than inventing its own.
//
// 301/302/303 stay failures on purpose: they permit a client to rewrite the
// request to GET, which turns the JSON-RPC handshake into a bodyless GET —
// the #4938 fingerprint. The proxy refuses them, so the monitor must too.
//
// Keeping `redirect: 'manual'` is what makes the hop visible at all: the hop is
// still recorded in `observed`, so a vendor re-plumbing behind a stable front
// door shows up as drift a human can read, not as silence.
const METHOD_PRESERVING_REDIRECTS = new Set([307, 308]);
const MAX_REDIRECT_HOPS = 1;

// The vendor chooses this target, so it is untrusted in exactly the way the
// proxy's serverUrl is: without the same checks a 308 could point the probe at
// a loopback, private, or link-local address, and because `observed` is
// published into a public issue, the reachability answer leaks. api/mcp-proxy.ts
// re-runs assertServerUrlSafe on every hop; this is the scripts-side equivalent,
// reusing the repo's SSRF classifier rather than restating its address ranges.
// It returns the vetted addresses so the hop connects to exactly what was
// checked; a second DNS answer (rebinding) never reaches the socket.
async function redirectTargetFor(response, fromUrl, { resolveHostname } = {}) {
  const location = response.headers?.get?.('location');
  if (!location) return null;
  let next;
  try {
    next = new URL(location, fromUrl);
  } catch {
    return null;
  }
  try {
    // Covers the scheme rule, metadata hostnames, literal private addresses,
    // and a hostname whose DNS resolves into a reserved range.
    const { resolvedAddresses } = await (resolveHostname
      ? assertNotificationWebhookDeliveryUrlSafe(next.toString(), resolveHostname)
      : assertNotificationWebhookDeliveryUrlSafe(next.toString()));
    return { url: next, dispatcher: pinnedDispatcher(resolvedAddresses) };
  } catch {
    return null;
  }
}

// Same pin as api/mcp-proxy.ts: the URL hostname still drives SNI, certificate
// validation and Host; only the socket address is fixed to the vetted answer.
function pinnedDispatcher(resolvedAddresses) {
  const address = resolvedAddresses.find(candidate => !candidate.includes(':')) ?? resolvedAddresses[0];
  if (!address || isBlockedResolvedAddress(address)) throw new Error('redirect target has no vetted address');
  const family = address.includes(':') ? 6 : 4;
  return new Agent({ connect: { lookup: pinnedLookup(address, family) } });
}

// net.connect uses the `{ all: true }` form when autoSelectFamily is on and the
// single-address form otherwise; answer both so neither path is unpinned.
function pinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    if (options && typeof options === 'object' && options.all) done(null, [{ address, family }]);
    else done(null, address, family);
  };
}

export async function probePreset(preset, { fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 15_000, resolveHostname } = {}) {
  const result = { name: preset.name, serverUrl: preset.serverUrl, ok: false };
  const controller = new AbortController();
  // One deadline covers both hops, so a redirecting vendor cannot quietly take
  // twice the budget every other preset gets.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let dispatcher;
  try {
    let target = preset.serverUrl;
    let trail = '';
    for (let hop = 0; ; hop++) {
      const response = await fetchImpl(target, {
        ...(dispatcher ? { dispatcher: new Dispatcher1Wrapper(dispatcher) } : {}),
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'User-Agent': 'WorldMonitor-MCP-Proxy/1.0',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'worldmonitor', version: '1.0' } },
        }),
        signal: controller.signal,
      });
      const next = hop < MAX_REDIRECT_HOPS && METHOD_PRESERVING_REDIRECTS.has(response.status)
        ? await redirectTargetFor(response, target, { resolveHostname })
        : null;
      if (next) {
        // Record the hop even when it resolves cleanly — a working redirect is
        // still drift worth seeing.
        trail += `HTTP ${response.status} -> `;
        target = next.url.toString();
        dispatcher = next.dispatcher;
        continue;
      }
      result.observed = trail ? `${trail}HTTP ${response.status} ${target}` : `HTTP ${response.status}`;
      result.ok = response.status === 200 || (Boolean(preset.authNote) && [401, 403].includes(response.status));
      break;
    }
  } catch (error) {
    result.ok = false;
    result.observed = controller.signal.aborted
      ? `Request timeout after ${timeoutMs}ms`
      : `Request failed: ${error.cause?.code || error.code || error.name}: ${error.message}`;
  } finally {
    clearTimeout(timer);
    // Liveness needs only headers; release SSE connections without changing the verdict.
    controller.abort();
    dispatcher?.destroy().catch(() => {});
  }
  return result;
}
