import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { assertNotificationWebhookDeliveryUrlSafe } = require('./notification-webhook-ssrf.cjs');

// Read a literal initializer out of the catalog AST. `defaultArgs` is the only
// non-string field the monitor reads, and across the catalog its values are
// strings, numbers, empty arrays and nested objects, so this has to cover the
// whole literal grammar rather than just string literals. Anything it cannot
// represent throws, per the "fail visibly" rule below: a preset whose args stop
// being statically readable must break the monitor, not decay into `undefined`.
function readLiteralValue(node, context) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(element => readLiteralValue(element, context));
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || typeof property.name?.text !== 'string') {
        throw new Error(`MCP_PRESETS ${context} must contain only literal properties`);
      }
      value[property.name.text] = readLiteralValue(property.initializer, context);
    }
    return value;
  }
  throw new Error(`MCP_PRESETS ${context} must be a literal value`);
}

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
    for (const key of ['name', 'serverUrl', 'defaultTool', 'authNote', 'apiKeyHeader']) {
      const property = element.properties.find(node => node.name?.text === key);
      if (!property && key !== 'name' && key !== 'serverUrl') continue;
      if (!property || !ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) {
        throw new Error(`MCP_PRESETS ${key} must be a string literal`);
      }
      preset[key] = property.initializer.text;
    }
    const defaultArgs = element.properties.find(node => node.name?.text === 'defaultArgs');
    if (defaultArgs) {
      if (!ts.isPropertyAssignment(defaultArgs) || !ts.isObjectLiteralExpression(defaultArgs.initializer)) {
        throw new Error('MCP_PRESETS defaultArgs must be an object literal');
      }
      preset.defaultArgs = readLiteralValue(defaultArgs.initializer, 'defaultArgs');
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
    await (resolveHostname
      ? assertNotificationWebhookDeliveryUrlSafe(next.toString(), resolveHostname)
      : assertNotificationWebhookDeliveryUrlSafe(next.toString()));
  } catch {
    return null;
  }
  return next;
}

export async function probePreset(preset, { fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 15_000, resolveHostname } = {}) {
  const result = { name: preset.name, serverUrl: preset.serverUrl, ok: false };
  const controller = new AbortController();
  // One deadline covers both hops, so a redirecting vendor cannot quietly take
  // twice the budget every other preset gets.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let target = preset.serverUrl;
    let trail = '';
    for (let hop = 0; ; hop++) {
      const response = await fetchImpl(target, {
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
        target = next.toString();
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
  }
  return result;
}
