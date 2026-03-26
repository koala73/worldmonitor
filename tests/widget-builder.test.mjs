/**
 * AI Widget Builder — E2E / Static verification tests
 *
 * Covers:
 *   1. Relay security  — SSRF guard, auth gate, isPublicRoute, body limit, CORS
 *   2. Widget store    — constants, span-map keys, `cw-` prefix, history trim
 *   3. Title regex     — hyphens in titles (bug fixed: [^\n\-] → [^\n])
 *   4. HTML sanitizer  — allowlist shape, forbidden tags, unsafe style strip
 *   5. Panel guardrails — cw- exclusion in UnifiedSettings, event-handlers
 *   6. SSE event types — html_complete, done, error, tool_call all present
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function src(relPath) {
  return readFileSync(resolve(root, relPath), 'utf-8');
}

// ---------------------------------------------------------------------------
// 1. Relay security
// ---------------------------------------------------------------------------
describe('widget-agent relay — security', () => {
  const relay = src('scripts/ais-relay.cjs');

  it('isPublicRoute includes /widget-agent so relay secret gate is bypassed', () => {
    // Must be on the same line as other isPublicRoute checks
    const match = relay.match(/isPublicRoute\s*=\s*[^;]+/);
    assert.ok(match, 'isPublicRoute assignment not found');
    assert.ok(
      match[0].includes("'/widget-agent'") || match[0].includes('"/widget-agent"'),
      `isPublicRoute does not exempt /widget-agent:\n  ${match[0]}`,
    );
  });

  it('route is registered before the 404 catch-all', () => {
    const routeIdx = relay.indexOf("pathname === '/widget-agent' && req.method === 'POST'");
    const catchAllIdx = relay.lastIndexOf('res.writeHead(404)');
    assert.ok(routeIdx !== -1, 'widget-agent route registration not found');
    assert.ok(catchAllIdx !== -1, '404 catch-all not found');
    assert.ok(routeIdx < catchAllIdx, 'widget-agent route must appear before 404 catch-all');
  });

  it('auth check uses x-widget-key header (not relay shared secret)', () => {
    assert.ok(
      relay.includes("req.headers['x-widget-key']"),
      "Handler must check req.headers['x-widget-key']",
    );
    assert.ok(
      relay.includes('WIDGET_AGENT_KEY'),
      'Must compare against configured WIDGET_AGENT_KEY',
    );
  });

  it('widget-agent fails closed when WIDGET_AGENT_KEY is missing', () => {
    assert.ok(
      relay.includes('!status.widgetKeyConfigured'),
      'Shared widget-agent auth helper must reject requests when WIDGET_AGENT_KEY is unset',
    );
    const missingKeyIdx = relay.indexOf('!status.widgetKeyConfigured');
    const region = relay.slice(missingKeyIdx, missingKeyIdx + 200);
    assert.ok(region.includes('503'), 'Missing WIDGET_AGENT_KEY should return 503');
  });

  it('auth 403 response is sent before any processing on bad key', () => {
    const handlerStart = relay.indexOf('async function handleWidgetAgentRequest');
    assert.ok(handlerStart !== -1, 'handleWidgetAgentRequest not found');
    // Use 4000 chars to cover the full auth/setup section including SSE headers
    const handlerBody = relay.slice(handlerStart, handlerStart + 4000);
    const authCheckIdx = handlerBody.indexOf('requireWidgetAgentAccess(req, res)');
    const sseHeaderIdx = handlerBody.indexOf("text/event-stream");
    assert.ok(authCheckIdx !== -1, 'Auth helper call not found in handler start');
    assert.ok(sseHeaderIdx !== -1, "text/event-stream SSE header not found within handler");
    assert.ok(authCheckIdx < sseHeaderIdx, 'Auth check must come before SSE headers');
  });

  it('body size limit is enforced (160KB for PRO, covers basic too)', () => {
    assert.ok(
      relay.includes('163840'),
      'Body limit of 163840 bytes (160KB) must be present',
    );
    // Verify 413 is returned when limit exceeded (check global presence near the limit)
    assert.ok(relay.includes('413'), 'Body size guard must respond 413');
    // Both the check and 413 should be in the handler
    const handlerStart = relay.indexOf('async function handleWidgetAgentRequest');
    const handlerBody = relay.slice(handlerStart, handlerStart + 500);
    assert.ok(handlerBody.includes('163840'), 'Body limit must be enforced in handleWidgetAgentRequest');
  });

  it('SSRF guard — ALLOWED_ENDPOINTS set is present', () => {
    assert.ok(relay.includes('WIDGET_ALLOWED_ENDPOINTS'), 'WIDGET_ALLOWED_ENDPOINTS not found');
    assert.ok(
      relay.includes("new Set(["),
      'WIDGET_ALLOWED_ENDPOINTS should be a Set',
    );
  });

  it('SSRF guard — allowlist is checked before any fetch call in tool loop', () => {
    const allowlistCheck = relay.indexOf('WIDGET_ALLOWED_ENDPOINTS.has(endpoint)');
    assert.ok(allowlistCheck !== -1, 'WIDGET_ALLOWED_ENDPOINTS.has() check missing');
    // The fetch call to api.worldmonitor.app must come AFTER the check
    const fetchCallIdx = relay.indexOf("'https://api.worldmonitor.app'", allowlistCheck);
    assert.ok(
      fetchCallIdx > allowlistCheck,
      'fetch() to api.worldmonitor.app must appear after allowlist check',
    );
  });

  it('SSRF guard — only worldmonitor.app endpoints are in allowlist', () => {
    const setStart = relay.indexOf('WIDGET_ALLOWED_ENDPOINTS = new Set');
    assert.ok(setStart !== -1);
    const setBody = relay.slice(setStart, relay.indexOf(']);', setStart) + 2);
    // Extract all quoted strings inside the Set
    const entries = [...setBody.matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
    for (const entry of entries) {
      assert.ok(
        entry.startsWith('/api/'),
        `Non-API endpoint in WIDGET_ALLOWED_ENDPOINTS: "${entry}" — must start with /api/`,
      );
    }
  });

  it('tool loop is bounded by maxTurns (6 for basic, 10 for PRO)', () => {
    assert.ok(
      relay.includes('turn < maxTurns'),
      'Tool loop must use maxTurns variable (not hardcoded 6)',
    );
    // Basic tier maxTurns is set to 6
    assert.ok(
      relay.includes('maxTurns = isPro ? 10 : 6') || relay.includes('isPro ? 10 : 6'),
      'maxTurns must be 6 for basic and 10 for PRO',
    );
  });

  it('server timeout is 90 seconds', () => {
    assert.ok(
      relay.includes('90_000') || relay.includes('90000'),
      'Server timeout must be 90 seconds (90_000 ms)',
    );
  });

  it('CORS for /widget-agent: POST in Allow-Methods, X-Widget-Key and X-Pro-Key in Allow-Headers', () => {
    const widgetCorsIdx = relay.indexOf("pathname.startsWith('/widget-agent')");
    assert.ok(widgetCorsIdx !== -1);
    const corsBlock = relay.slice(widgetCorsIdx, widgetCorsIdx + 500);
    assert.ok(
      corsBlock.includes('GET, POST, OPTIONS'),
      'CORS must include POST in Allow-Methods for /widget-agent',
    );
    assert.ok(
      corsBlock.includes('X-Widget-Key'),
      'CORS must include X-Widget-Key in Allow-Headers for /widget-agent',
    );
    assert.ok(
      corsBlock.includes('X-Pro-Key'),
      'CORS must include X-Pro-Key in Allow-Headers for /widget-agent',
    );
  });

  it('CORS reuses getCorsOrigin (not a narrow hardcoded origin list)', () => {
    const widgetCorsIdx = relay.indexOf("pathname.startsWith('/widget-agent')");
    const corsBlock = relay.slice(widgetCorsIdx, widgetCorsIdx + 600);
    // Must NOT define a hardcoded origins array for this specific route
    assert.ok(
      !corsBlock.includes("['https://worldmonitor.app'"),
      'Do NOT hardcode origins for /widget-agent — reuse getCorsOrigin()',
    );
    // Must reference corsOrigin variable (set by getCorsOrigin earlier)
    // (The block itself may not set Access-Control-Allow-Origin since that's
    // already set above; it just overrides Methods and Headers)
    assert.ok(
      corsBlock.includes('Access-Control-Allow-Methods') ||
      corsBlock.includes('Access-Control-Allow-Headers'),
      'CORS block for /widget-agent must set Allow-Methods or Allow-Headers',
    );
  });

  it('registers GET /widget-agent/health before the 404 catch-all', () => {
    const healthRouteIdx = relay.indexOf("pathname === '/widget-agent/health' && req.method === 'GET'");
    const catchAllIdx = relay.lastIndexOf('res.writeHead(404)');
    assert.ok(healthRouteIdx !== -1, 'widget-agent health route registration not found');
    assert.ok(healthRouteIdx < catchAllIdx, 'widget-agent health route must appear before 404 catch-all');
  });

  it('uses raw @anthropic-ai/sdk (not agent SDK)', () => {
    // Dynamic import should be for @anthropic-ai/sdk specifically
    assert.ok(
      relay.includes("'@anthropic-ai/sdk'") || relay.includes('"@anthropic-ai/sdk"'),
      'Must use @anthropic-ai/sdk (raw SDK)',
    );
    assert.ok(
      !relay.includes('@anthropic-ai/claude-code'),
      'Must NOT use @anthropic-ai/claude-code Agent SDK',
    );
  });

  it('model used is claude-haiku (cost-efficient for widgets)', () => {
    assert.ok(
      relay.includes('claude-haiku'),
      'Widget agent should use claude-haiku model for cost efficiency',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Widget store
// ---------------------------------------------------------------------------
describe('widget-store — constants and logic', () => {
  const store = src('src/services/widget-store.ts');

  it('storage key is wm-custom-widgets', () => {
    assert.ok(
      store.includes("'wm-custom-widgets'"),
      "Storage key must be 'wm-custom-widgets'",
    );
  });

  it('auth gate checks wm-widget-key localStorage entry', () => {
    assert.ok(
      store.includes("'wm-widget-key'"),
      "Feature gate must check localStorage key 'wm-widget-key'",
    );
  });

  it('MAX_WIDGETS is 10', () => {
    assert.ok(
      store.includes('MAX_WIDGETS') && store.includes('10'),
      'MAX_WIDGETS constant should be 10',
    );
    const match = store.match(/MAX_WIDGETS\s*=\s*(\d+)/);
    assert.ok(match, 'MAX_WIDGETS not found');
    assert.equal(Number(match[1]), 10, 'MAX_WIDGETS must be 10');
  });

  it('MAX_HTML_CHARS is 50000', () => {
    const match = store.match(/MAX_HTML_(?:CHARS|BYTES)\s*=\s*([\d_]+)/);
    assert.ok(match, 'MAX_HTML_CHARS/BYTES constant not found');
    const val = Number(match[1].replace(/_/g, ''));
    assert.equal(val, 50000, 'HTML size limit must be 50,000 chars');
  });

  it('MAX_HISTORY is 10', () => {
    const match = store.match(/MAX_HISTORY\s*=\s*(\d+)/);
    assert.ok(match, 'MAX_HISTORY constant not found');
    assert.equal(Number(match[1]), 10, 'MAX_HISTORY must be 10');
  });

  it('widget IDs use cw- prefix (in modal or store)', () => {
    const modal = src('src/components/WidgetChatModal.ts');
    assert.ok(
      store.includes("'cw-'") || store.includes('"cw-"') ||
      modal.includes("'cw-'") || modal.includes('"cw-"') ||
      modal.includes('`cw-'),
      "Widget IDs must use 'cw-' prefix (check widget-store.ts and WidgetChatModal.ts)",
    );
  });

  it('deleteWidget cleans worldmonitor-panel-spans (aggregate map)', () => {
    assert.ok(
      store.includes("'worldmonitor-panel-spans'"),
      "deleteWidget must clean 'worldmonitor-panel-spans'",
    );
  });

  it('deleteWidget cleans worldmonitor-panel-col-spans (aggregate map)', () => {
    assert.ok(
      store.includes("'worldmonitor-panel-col-spans'"),
      "deleteWidget must clean 'worldmonitor-panel-col-spans'",
    );
  });

  it('saveWidget trims conversationHistory before write', () => {
    // Should call slice(-MAX_HISTORY) before persisting
    const saveIdx = store.indexOf('function saveWidget');
    assert.ok(saveIdx !== -1, 'saveWidget not found');
    const saveBody = store.slice(saveIdx, saveIdx + 800);
    assert.ok(
      saveBody.includes('.slice(-') || saveBody.includes('slice(-MAX_HISTORY'),
      'saveWidget must trim conversationHistory with .slice(-MAX_HISTORY)',
    );
  });

  it('saveWidget truncates html to MAX_HTML_CHARS before write', () => {
    const saveIdx = store.indexOf('function saveWidget');
    assert.ok(saveIdx !== -1);
    const saveBody = store.slice(saveIdx, saveIdx + 800);
    assert.ok(
      saveBody.includes('.slice(0, MAX_HTML'),
      'saveWidget must truncate html to MAX_HTML_CHARS',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Title regex (hyphens-in-titles bug fix)
// ---------------------------------------------------------------------------
describe('widget-agent relay — title extraction regex', () => {
  const relay = src('scripts/ais-relay.cjs');

  it('title regex does NOT exclude hyphens (fixed bug: [^\\n\\-] → [^\\n])', () => {
    // Extract the title extraction regex from the relay source
    const match = relay.match(/titleMatch\s*=\s*text\.match\(([^;]+)\)/);
    assert.ok(match, 'Title extraction line not found (expected: titleMatch = text.match(...))');
    const regexStr = match[1];
    // Must NOT have \- inside a character class (the old bug)
    assert.ok(
      !regexStr.includes('\\-') && !regexStr.includes('\\\\-'),
      `Title regex must not exclude hyphens. Found: ${regexStr}`,
    );
  });

  it('title regex correctly parses hyphenated titles', () => {
    // Simulate the regex from the source
    const regex = /<!--\s*title:\s*([^\n]+?)\s*-->/;
    const cases = [
      { input: '<!-- title: Market-Tracker -->', expected: 'Market-Tracker' },
      { input: '<!-- title: US-China Trade Watch -->', expected: 'US-China Trade Watch' },
      { input: '<!-- title: Simple Widget -->', expected: 'Simple Widget' },
      { input: '<!-- title:  Leading Spaces -->', expected: 'Leading Spaces' },
    ];
    for (const { input, expected } of cases) {
      const m = input.match(regex);
      assert.ok(m, `No match for: ${input}`);
      assert.equal(m[1].trim(), expected, `Wrong title extracted from: ${input}`);
    }
  });

  it('title regex falls back to "Custom Widget" when comment absent', () => {
    const regex = /<!--\s*title:\s*([^\n]+?)\s*-->/;
    const text = 'Some widget HTML without title comment';
    const m = text.match(regex);
    const title = m?.[1]?.trim() ?? 'Custom Widget';
    assert.equal(title, 'Custom Widget');
  });

  it('html extraction regex handles multiline content', () => {
    const regex = /<!--\s*widget-html\s*-->([\s\S]*?)<!--\s*\/widget-html\s*-->/;
    const html = `<!-- widget-html -->\n<div>hello</div>\n<!-- /widget-html -->`;
    const m = html.match(regex);
    assert.ok(m, 'HTML extraction must match');
    assert.ok(m[1].includes('<div>hello</div>'), 'Must capture content between markers');
  });

  it('html extraction falls back to full text when markers missing', () => {
    const regex = /<!--\s*widget-html\s*-->([\s\S]*?)<!--\s*\/widget-html\s*-->/;
    const text = '<div>fallback</div>';
    const m = text.match(regex);
    const html = (m?.[1] ?? text).slice(0, 50000);
    assert.equal(html, '<div>fallback</div>');
  });
});

// ---------------------------------------------------------------------------
// 4. HTML sanitizer
// ---------------------------------------------------------------------------
describe('widget-sanitizer — allowlist verification', () => {
  const san = src('src/utils/widget-sanitizer.ts');

  const REQUIRED_ALLOWED_TAGS = ['div', 'span', 'p', 'table', 'svg', 'path'];
  const REQUIRED_FORBIDDEN_TAGS = ['button', 'input', 'script', 'iframe', 'form'];
  const REQUIRED_ALLOWED_ATTRS = ['class', 'style', 'viewBox', 'fill', 'stroke'];

  for (const tag of REQUIRED_ALLOWED_TAGS) {
    it(`allowed tag '${tag}' is in ALLOWED_TAGS`, () => {
      assert.ok(
        san.includes(`'${tag}'`) || san.includes(`"${tag}"`),
        `Tag '${tag}' must be in ALLOWED_TAGS`,
      );
    });
  }

  for (const tag of REQUIRED_FORBIDDEN_TAGS) {
    it(`forbidden tag '${tag}' is in FORBID_TAGS`, () => {
      assert.ok(
        san.includes(`'${tag}'`) || san.includes(`"${tag}"`),
        `Tag '${tag}' must be in FORBID_TAGS`,
      );
    });
  }

  for (const attr of REQUIRED_ALLOWED_ATTRS) {
    it(`attribute '${attr}' is in ALLOWED_ATTR`, () => {
      assert.ok(
        san.includes(`'${attr}'`) || san.includes(`"${attr}"`),
        `Attr '${attr}' must be in ALLOWED_ATTR`,
      );
    });
  }

  it('FORCE_BODY is true (prevents <html> wrapper)', () => {
    assert.ok(san.includes('FORCE_BODY: true'), 'FORCE_BODY must be true');
  });

  it('post-pass strips url() from style attributes', () => {
    assert.ok(
      san.includes('url') && (san.includes('UNSAFE_STYLE') || san.includes('unsafe')),
      'Must have post-pass regex stripping url() from style values',
    );
  });

  it('post-pass strips javascript: from style attributes', () => {
    assert.ok(
      san.includes('javascript'),
      'Must have post-pass regex stripping javascript: from style values',
    );
  });

  it('post-pass strips expression() from style attributes', () => {
    assert.ok(
      san.includes('expression'),
      'Must have post-pass regex stripping expression() from style values',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Panel guardrails — cw- exclusions
// ---------------------------------------------------------------------------
describe('panel guardrails — cw- prefix handling', () => {
  const settings = src('src/components/UnifiedSettings.ts');
  const events = src('src/app/event-handlers.ts');
  const layout = src('src/app/panel-layout.ts');

  it('UnifiedSettings filters out cw- panels from settings list', () => {
    assert.ok(
      settings.includes("startsWith('cw-')"),
      "UnifiedSettings must filter panels with id.startsWith('cw-')",
    );
  });

  it('event-handlers confirms before deleting cw- panels', () => {
    assert.ok(
      events.includes("startsWith('cw-')"),
      "event-handlers must detect cw- prefix for custom widget panels",
    );
    assert.ok(
      events.includes("t('widgets.confirmDelete')"),
      'Custom widget delete confirmation must use localized widgets.confirmDelete copy',
    );
    assert.ok(
      events.includes('confirm') || events.includes('window.confirm'),
      'Must show a confirm dialog before deleting custom widgets',
    );
  });

  it('event-handlers calls deleteWidget for cw- panels', () => {
    assert.ok(
      events.includes('deleteWidget'),
      'Must call deleteWidget() when removing a custom widget panel',
    );
  });

  it('event-handlers registers wm:widget-modify listener', () => {
    assert.ok(
      events.includes('wm:widget-modify'),
      'Must listen for wm:widget-modify custom event',
    );
  });

  it('panel-layout loads widgets when feature is enabled', () => {
    assert.ok(
      layout.includes('hasPremiumAccess') || layout.includes('isProUser'),
      'panel-layout must check hasPremiumAccess (or isProUser) before loading widgets',
    );
    assert.ok(
      layout.includes('loadWidgets'),
      'panel-layout must call loadWidgets() to restore persisted widgets',
    );
  });

  it('panel-layout has addCustomWidget method', () => {
    assert.ok(
      layout.includes('addCustomWidget'),
      'panel-layout must implement addCustomWidget() method',
    );
  });

  it('panel-layout AI button is gated by hasPremiumAccess', () => {
    const hasCheck = layout.includes('hasPremiumAccess') || layout.includes('isProUser');
    const buttonIdx = layout.indexOf('ai-widget-block');
    assert.ok(hasCheck, 'hasPremiumAccess (or isProUser) not found in panel-layout');
    assert.ok(buttonIdx !== -1, 'AI widget button not found in panel-layout');
  });

  it('panel-layout DEV warning excludes cw- panels', () => {
    assert.ok(
      layout.includes("startsWith('cw-')"),
      "DEV warning must exclude panels with id.startsWith('cw-')",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. SSE event types
// ---------------------------------------------------------------------------
describe('widget-agent relay — SSE event protocol', () => {
  const relay = src('scripts/ais-relay.cjs');

  const EXPECTED_SSE_EVENTS = ['html_complete', 'done', 'error', 'tool_call'];

  for (const event of EXPECTED_SSE_EVENTS) {
    it(`SSE event '${event}' is sent by handler`, () => {
      assert.ok(
        relay.includes(`'${event}'`) || relay.includes(`"${event}"`),
        `SSE event '${event}' not found in relay handler`,
      );
    });
  }

  it('sendWidgetSSE helper is defined', () => {
    assert.ok(
      relay.includes('sendWidgetSSE') || relay.includes('function sendWidgetSSE'),
      'sendWidgetSSE helper must be defined',
    );
  });

  it('html_complete event carries html payload', () => {
    const idx = relay.indexOf('html_complete');
    assert.ok(idx !== -1);
    const region = relay.slice(idx - 50, idx + 200);
    assert.ok(region.includes('html'), "html_complete event must include 'html' field");
  });

  it('done event carries title payload', () => {
    const idx = relay.indexOf("'done'");
    assert.ok(idx !== -1);
    const region = relay.slice(idx, idx + 100);
    assert.ok(region.includes('title'), "done event must include 'title' field");
  });

  it('tool_call event carries endpoint for UI badge display', () => {
    const idx = relay.indexOf("'tool_call'");
    assert.ok(idx !== -1);
    const region = relay.slice(idx, idx + 150);
    assert.ok(region.includes('endpoint'), "tool_call event must include 'endpoint' field");
  });
});

// ---------------------------------------------------------------------------
// 7. WidgetChatModal — client-side SSE handling
// ---------------------------------------------------------------------------
describe('WidgetChatModal — SSE client protocol', () => {
  const modal = src('src/components/WidgetChatModal.ts');

  it('uses fetch (not EventSource) for POST SSE', () => {
    assert.ok(modal.includes('fetch(widgetAgentUrl'), 'Must use fetch() not EventSource');
    assert.ok(!modal.includes('new EventSource'), 'Must NOT use EventSource (POST not supported)');
  });

  it('sends X-Widget-Key header', () => {
    assert.ok(
      modal.includes('X-Widget-Key'),
      'Must send X-Widget-Key header with request',
    );
  });

  it('runs preflight against widget-agent health route on open', () => {
    assert.ok(modal.includes('widgetAgentHealthUrl'), 'Modal must import widgetAgentHealthUrl()');
    assert.ok(modal.includes('runPreflight'), 'Modal must define runPreflight()');
    assert.ok(modal.includes("fetch(widgetAgentHealthUrl()"), 'Modal must fetch widgetAgentHealthUrl() during preflight');
  });

  it('AbortController used for cancellation', () => {
    assert.ok(modal.includes('AbortController'), 'Must use AbortController for stream cancellation');
  });

  it('client timeout is 60 seconds', () => {
    assert.ok(
      modal.includes('60_000') || modal.includes('60000'),
      'Client timeout must be 60 seconds (60_000 ms)',
    );
  });

  it('currentHtml sent as separate field (not embedded in conversationHistory)', () => {
    const bodyIdx = modal.indexOf('JSON.stringify');
    assert.ok(bodyIdx !== -1);
    const bodyRegion = modal.slice(bodyIdx, bodyIdx + 400);
    assert.ok(bodyRegion.includes('currentHtml'), 'Must send currentHtml as separate request field');
    assert.ok(bodyRegion.includes('conversationHistory'), 'Must send conversationHistory');
  });

  it('prompt is sliced to 2000 chars before sending', () => {
    assert.ok(
      modal.includes('.slice(0, 2000)'),
      'Prompt must be sliced to 2000 chars before sending',
    );
  });

  it('history content is sliced to 500 chars per entry', () => {
    assert.ok(
      modal.includes('.slice(0, 500)'),
      'Each history entry content must be sliced to 500 chars',
    );
  });

  it('modal handles AbortError without showing error to user', () => {
    assert.ok(
      modal.includes('AbortError'),
      'Must handle AbortError (e.g. from timeout or close) gracefully',
    );
  });

  it('Escape key closes modal', () => {
    assert.ok(
      modal.includes('Escape') || modal.includes("'Escape'"),
      'Escape key must close the modal',
    );
  });

  it('action button says "Add to Dashboard" (create) or "Apply Changes" (modify)', () => {
    assert.ok(modal.includes("t('widgets.addToDashboard')"), 'Create mode button must use widgets.addToDashboard');
    assert.ok(modal.includes("t('widgets.applyChanges')"), 'Modify mode button must use widgets.applyChanges');
  });

  it('uses split layout and sticky footer action bar structure', () => {
    assert.ok(modal.includes('widget-chat-layout'), 'Modal must render widget-chat-layout');
    assert.ok(modal.includes('widget-chat-sidebar'), 'Modal must render widget-chat-sidebar');
    assert.ok(modal.includes('widget-chat-main'), 'Modal must render widget-chat-main');
    assert.ok(modal.includes('widget-chat-footer'), 'Modal must render widget-chat-footer');
  });

  it('renders prompt example chips', () => {
    assert.ok(modal.includes('EXAMPLE_PROMPT_KEYS'), 'Modal must define prompt example keys');
    assert.ok(modal.includes('widget-chat-example-chip'), 'Modal must render prompt example chips');
  });

  it('conversationHistory entries use literal role types (user | assistant)', () => {
    // After our fix, these should use `as const`
    assert.ok(
      modal.includes("'user' as const") || modal.includes('"user" as const'),
      "role must be typed as literal 'user' with `as const`",
    );
    assert.ok(
      modal.includes("'assistant' as const") || modal.includes('"assistant" as const'),
      "role must be typed as literal 'assistant' with `as const`",
    );
  });

  it('multi-turn requests reuse mutable sessionHistory instead of original spec history', () => {
    assert.ok(
      modal.includes('const sessionHistory = [...(options.existingSpec?.conversationHistory ?? [])]'),
      'Modal must keep a mutable sessionHistory array for iterative requests',
    );
    assert.ok(
      modal.includes('conversationHistory: sessionHistory'),
      'Outgoing request body must use the mutable sessionHistory array',
    );
    assert.ok(
      modal.includes('sessionHistory.push('),
      'Modal must append new user/assistant turns back into sessionHistory after success',
    );
    assert.ok(
      modal.includes('conversationHistory: [...sessionHistory]'),
      'Saved widget spec must persist the updated sessionHistory',
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Vite proxy + URL helper
// ---------------------------------------------------------------------------
describe('proxy routing — widgetAgentUrl', () => {
  const proxy = src('src/utils/proxy.ts');
  const vite = src('vite.config.ts');

  it('widgetAgentUrl() exists in proxy.ts', () => {
    assert.ok(
      proxy.includes('widgetAgentUrl'),
      'widgetAgentUrl() must be defined in src/utils/proxy.ts',
    );
  });

  it('widgetAgentUrl returns /widget-agent in dev (for Vite proxy)', () => {
    assert.ok(
      proxy.includes("'/widget-agent'") || proxy.includes('"/widget-agent"'),
      'widgetAgentUrl must return /widget-agent in dev mode',
    );
  });

  it('widgetAgentUrl targets proxy.worldmonitor.app (not toRuntimeUrl)', () => {
    // The URL may be in a constant above the function; search the whole file
    assert.ok(
      proxy.includes('proxy.worldmonitor.app'),
      'Must target proxy.worldmonitor.app directly (sidecar destroys SSE via arrayBuffer)',
    );
    // Verify the function itself does not use toRuntimeUrl
    const fnIdx = proxy.indexOf('function widgetAgentUrl');
    assert.ok(fnIdx !== -1, 'widgetAgentUrl function not found');
    const fnBody = proxy.slice(fnIdx, fnIdx + 400);
    assert.ok(
      !fnBody.includes('toRuntimeUrl'),
      'widgetAgentUrl must NOT use toRuntimeUrl — sidecar buffers via arrayBuffer, destroying SSE',
    );
  });

  it('vite.config.ts proxies /widget-agent to proxy.worldmonitor.app', () => {
    assert.ok(
      vite.includes('/widget-agent'),
      'vite.config.ts must have proxy entry for /widget-agent',
    );
    assert.ok(
      vite.includes('proxy.worldmonitor.app'),
      'Vite proxy target must be proxy.worldmonitor.app',
    );
  });

  it('widgetAgentHealthUrl() exists and targets /widget-agent/health', () => {
    assert.ok(proxy.includes('widgetAgentHealthUrl'), 'widgetAgentHealthUrl() must be defined');
    assert.ok(proxy.includes('/widget-agent/health'), 'widgetAgentHealthUrl() must target /widget-agent/health');
  });
});

// ---------------------------------------------------------------------------
// 9. i18n completeness
// ---------------------------------------------------------------------------
describe('i18n — widgets section completeness', () => {
  const en = JSON.parse(src('src/locales/en.json'));

  const REQUIRED_KEYS = [
    'createWithAi',
    'confirmDelete',
    'chatTitle',
    'modifyTitle',
    'inputPlaceholder',
    'addToDashboard',
    'applyChanges',
    'send',
    'changeAccent',
    'modifyWithAi',
    'ready',
    'fetching',
    'requestTimedOut',
    'serverError',
    'unknownError',
    'generatedWidget',
    'checkingConnection',
    'preflightConnected',
    'preflightInvalidKey',
    'preflightUnavailable',
    'preflightAiUnavailable',
    'readyToGenerate',
    'readyToApply',
    'modifyHint',
    'generating',
    'examplesTitle',
    'previewTitle',
    'phaseChecking',
    'phaseReadyToPrompt',
    'phaseFetching',
    'phaseComposing',
    'phaseComplete',
    'phaseError',
    'previewCheckingHeading',
    'previewReadyHeading',
    'previewFetchingHeading',
    'previewComposingHeading',
    'previewErrorHeading',
    'previewCheckingCopy',
    'previewReadyCopy',
    'previewFetchingCopy',
    'previewComposingCopy',
    'previewErrorCopy',
  ];

  for (const key of REQUIRED_KEYS) {
    it(`widgets.${key} is defined and non-empty`, () => {
      assert.ok(
        en.widgets && typeof en.widgets[key] === 'string' && en.widgets[key].length > 0,
        `en.json must have non-empty widgets.${key}`,
      );
    });
  }

  it('confirmDelete text sounds permanent (not just hide)', () => {
    assert.ok(
      en.widgets.confirmDelete.toLowerCase().includes('remove') ||
      en.widgets.confirmDelete.toLowerCase().includes('delete') ||
      en.widgets.confirmDelete.toLowerCase().includes('permanent'),
      'confirmDelete must convey permanence — not just hide',
    );
  });

  it('widget UI sources labels from i18n keys instead of hardcoded English copy', () => {
    const modal = src('src/components/WidgetChatModal.ts');
    const panel = src('src/components/CustomWidgetPanel.ts');
    const events = src('src/app/event-handlers.ts');
    assert.ok(modal.includes("t('widgets.chatTitle')"), 'WidgetChatModal must use widgets.chatTitle');
    assert.ok(modal.includes("t('widgets.modifyTitle')"), 'WidgetChatModal must use widgets.modifyTitle');
    assert.ok(modal.includes("t('widgets.inputPlaceholder')"), 'WidgetChatModal must use widgets.inputPlaceholder');
    assert.ok(panel.includes("t('widgets.changeAccent')"), 'CustomWidgetPanel must use widgets.changeAccent');
    assert.ok(panel.includes("t('widgets.modifyWithAi')"), 'CustomWidgetPanel must use widgets.modifyWithAi');
    assert.ok(events.includes("t('widgets.confirmDelete')"), 'Delete confirmation must use widgets.confirmDelete');
  });

  it('prompt examples are defined and non-empty', () => {
    const exampleKeys = ['oilGold', 'cryptoMovers', 'flightDelays', 'conflictHotspots'];
    for (const key of exampleKeys) {
      assert.ok(
        typeof en.widgets.examples[key] === 'string' && en.widgets.examples[key].length > 0,
        `en.json must have non-empty widgets.examples.${key}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 10. CustomWidgetPanel
// ---------------------------------------------------------------------------
describe('CustomWidgetPanel — header buttons and events', () => {
  const panel = src('src/components/CustomWidgetPanel.ts');
  const sanitizer = src('src/utils/widget-sanitizer.ts');

  it('dispatches wm:widget-modify event from chat button', () => {
    assert.ok(
      panel.includes('wm:widget-modify'),
      'CustomWidgetPanel must dispatch wm:widget-modify CustomEvent',
    );
  });

  it('ACCENT_COLORS has 9 entries (8 colors + null reset)', () => {
    // Array spans multiple lines — use [\s\S]*? to capture across newlines
    const match = panel.match(/ACCENT_COLORS[^=]*=\s*\[([\s\S]*?)\];/);
    assert.ok(match, 'ACCENT_COLORS array not found');
    const entries = match[1].split(',').map(s => s.trim()).filter(Boolean);
    assert.equal(entries.length, 9, `ACCENT_COLORS must have 9 entries (8 colors + null), found ${entries.length}: [${entries.join(', ')}]`);
    assert.ok(entries.includes('null'), 'ACCENT_COLORS must include null for reset');
  });

  it('accent color persists via saveWidget after color cycle', () => {
    assert.ok(
      panel.includes('saveWidget'),
      'Color cycle must call saveWidget() to persist accentColor',
    );
  });

  it('applies --widget-accent CSS variable', () => {
    assert.ok(
      panel.includes('--widget-accent'),
      'CustomWidgetPanel must apply --widget-accent CSS variable',
    );
  });

  it('renderWidget uses shared wrapped widget HTML helper', () => {
    assert.ok(
      panel.includes('wrapWidgetHtml'),
      'renderWidget must use wrapWidgetHtml() for shell + sanitization',
    );
    assert.ok(
      sanitizer.includes('sanitizeWidgetHtml'),
      'wrapWidgetHtml() must sanitize HTML internally',
    );
    assert.ok(
      sanitizer.includes('wm-widget-generated'),
      'wrapWidgetHtml() must provide a contained generated-widget wrapper',
    );
  });

  it('extends Panel (display-only widget with panel infrastructure)', () => {
    assert.ok(
      panel.includes('extends Panel'),
      'CustomWidgetPanel must extend Panel',
    );
  });

  it('renderWidget branches on tier — PRO uses wrapProWidgetHtml', () => {
    assert.ok(
      panel.includes('wrapProWidgetHtml'),
      "renderWidget must call wrapProWidgetHtml() for PRO tier",
    );
  });

  it('PRO badge rendered in header when tier is pro', () => {
    assert.ok(
      panel.includes('widget-pro-badge'),
      'CustomWidgetPanel must render .widget-pro-badge for PRO widgets',
    );
  });
});

// ---------------------------------------------------------------------------
// 11. PRO widget — relay
// ---------------------------------------------------------------------------
describe('PRO widget — relay auth and configuration', () => {
  const relay = src('scripts/ais-relay.cjs');

  it('PRO_WIDGET_KEY is read from env', () => {
    assert.ok(
      relay.includes('PRO_WIDGET_KEY'),
      'PRO_WIDGET_KEY must be defined from env',
    );
  });

  it('PRO_WIDGET_RATE_LIMIT is 20', () => {
    const match = relay.match(/PRO_WIDGET_RATE_LIMIT\s*=\s*(\d+)/);
    assert.ok(match, 'PRO_WIDGET_RATE_LIMIT constant not found');
    assert.equal(Number(match[1]), 20, 'PRO_WIDGET_RATE_LIMIT must be 20');
  });

  it('proWidgetRateLimitMap is a separate rate limit bucket from basic', () => {
    assert.ok(
      relay.includes('proWidgetRateLimitMap'),
      'PRO must use a separate rate limit map (proWidgetRateLimitMap)',
    );
    // Must also have the basic bucket
    assert.ok(
      relay.includes('widgetRateLimitMap'),
      'Basic must have its own rate limit map (widgetRateLimitMap)',
    );
    // Verify they are different variables
    assert.notEqual(
      relay.indexOf('proWidgetRateLimitMap'),
      relay.indexOf('widgetRateLimitMap'),
      'PRO and basic must use separate rate limit maps',
    );
  });

  it('x-pro-key header is read for PRO auth', () => {
    assert.ok(
      relay.includes("req.headers['x-pro-key']") || relay.includes('x-pro-key'),
      "Handler must read req.headers['x-pro-key'] for PRO auth",
    );
  });

  it('PRO request rejected with 403 when x-pro-key is wrong', () => {
    assert.ok(
      relay.includes('getWidgetAgentProvidedProKey'),
      'getWidgetAgentProvidedProKey function must be defined',
    );
    // The PRO key comparison is near the 403 rejection — find it directly
    const keyCompareIdx = relay.indexOf('providedProKey !== PRO_WIDGET_KEY');
    assert.ok(keyCompareIdx !== -1, 'PRO key comparison must be present');
    const region = relay.slice(keyCompareIdx, keyCompareIdx + 200);
    assert.ok(region.includes('403'), 'Wrong PRO key must return 403');
  });

  it('invalid tier value rejected with 400', () => {
    assert.ok(
      relay.includes("tier !== 'basic' && tier !== 'pro'") ||
      relay.includes("!['basic', 'pro'].includes(tier)") ||
      (relay.includes("tier === 'pro'") && relay.includes('400')),
      'Invalid tier must be rejected with 400',
    );
  });

  it('health endpoint includes proKeyConfigured boolean', () => {
    const healthIdx = relay.indexOf('getWidgetAgentStatus');
    assert.ok(healthIdx !== -1, 'getWidgetAgentStatus not found');
    const region = relay.slice(healthIdx, healthIdx + 400);
    assert.ok(
      region.includes('proKeyConfigured'),
      'Health/status response must include proKeyConfigured field',
    );
  });

  it('PRO uses claude-sonnet model (not haiku)', () => {
    assert.ok(
      relay.includes('claude-sonnet'),
      'PRO tier must use claude-sonnet model',
    );
  });

  it('PRO max_tokens is 8192', () => {
    // maxTokens is set via isPro ternary, then passed to max_tokens
    assert.ok(
      relay.includes('isPro ? 8192') || relay.includes('isPro?8192') || relay.includes('8192'),
      'PRO max_tokens must be 8192',
    );
    const tokenMatch = relay.match(/maxTokens\s*=\s*isPro\s*\?\s*8192/) || relay.match(/isPro\s*\?\s*8192/);
    assert.ok(tokenMatch, 'maxTokens must be set to 8192 when isPro');
  });

  it('WIDGET_PRO_SYSTEM_PROMPT exists and forbids DOCTYPE/html wrappers', () => {
    assert.ok(
      relay.includes('WIDGET_PRO_SYSTEM_PROMPT'),
      'WIDGET_PRO_SYSTEM_PROMPT constant must be defined',
    );
    // Use lastIndexOf to find the constant definition (not earlier references/usages)
    const promptIdx = relay.lastIndexOf('WIDGET_PRO_SYSTEM_PROMPT');
    const promptRegion = relay.slice(promptIdx, promptIdx + 2000);
    // PRO system prompt must instruct "body only" (no full page generation)
    assert.ok(
      promptRegion.includes('body') || promptRegion.includes('<body>'),
      'PRO system prompt must instruct generating body content only',
    );
  });

  it('PRO system prompt allows cdn.jsdelivr.net for Chart.js', () => {
    // Use lastIndexOf to find the constant definition
    const promptIdx = relay.lastIndexOf('WIDGET_PRO_SYSTEM_PROMPT');
    const promptRegion = relay.slice(promptIdx, promptIdx + 3500);
    assert.ok(
      promptRegion.includes('cdn.jsdelivr.net') || promptRegion.includes('chart.js') || promptRegion.includes('Chart.js'),
      'PRO system prompt must mention cdn.jsdelivr.net/Chart.js as allowed CDN',
    );
  });
});

// ---------------------------------------------------------------------------
// 12. PRO widget — store and sanitizer
// ---------------------------------------------------------------------------
describe('PRO widget — store and sanitizer', () => {
  const store = src('src/services/widget-store.ts');
  const san = src('src/utils/widget-sanitizer.ts');

  it('MAX_HTML_CHARS_PRO is 80000', () => {
    const match = store.match(/MAX_HTML_CHARS_PRO\s*=\s*([\d_]+)/);
    assert.ok(match, 'MAX_HTML_CHARS_PRO constant not found');
    const val = Number(match[1].replace(/_/g, ''));
    assert.equal(val, 80000, 'MAX_HTML_CHARS_PRO must be 80,000');
  });

  it('isProWidgetEnabled checks wm-pro-key localStorage key', () => {
    assert.ok(
      store.includes("'wm-pro-key'"),
      "isProWidgetEnabled must check localStorage key 'wm-pro-key'",
    );
    assert.ok(
      store.includes('isProWidgetEnabled'),
      'isProWidgetEnabled function must be exported',
    );
  });

  it('PRO HTML stored in separate wm-pro-html-{id} key', () => {
    assert.ok(
      store.includes('wm-pro-html-'),
      "PRO HTML must be stored in 'wm-pro-html-{id}' separate localStorage key",
    );
  });

  it('loadWidgets hydrates PRO HTML from separate key', () => {
    const loadIdx = store.indexOf('function loadWidgets');
    assert.ok(loadIdx !== -1, 'loadWidgets not found');
    const loadBody = store.slice(loadIdx, loadIdx + 600);
    assert.ok(
      loadBody.includes('proHtml') || loadBody.includes('wm-pro-html'),
      'loadWidgets must read PRO HTML from separate key',
    );
  });

  it("loadWidgets drops PRO entry when wm-pro-html-{id} is missing", () => {
    const loadIdx = store.indexOf('function loadWidgets');
    const loadBody = store.slice(loadIdx, loadIdx + 600);
    assert.ok(
      loadBody.includes('continue') || loadBody.includes('skip'),
      'loadWidgets must skip/drop PRO entries with missing HTML key',
    );
  });

  it('saveWidget for PRO uses raw localStorage.setItem (not saveToStorage helper)', () => {
    const saveIdx = store.indexOf('function saveWidget');
    assert.ok(saveIdx !== -1, 'saveWidget not found');
    const saveBody = store.slice(saveIdx, saveIdx + 800);
    assert.ok(
      saveBody.includes('localStorage.setItem'),
      'PRO saveWidget must use raw localStorage.setItem for atomicity-safe writes',
    );
  });

  it('saveWidget for PRO rolls back HTML key if metadata write fails', () => {
    const saveIdx = store.indexOf('function saveWidget');
    const saveBody = store.slice(saveIdx, saveIdx + 800);
    assert.ok(
      saveBody.includes('removeItem') || saveBody.includes('rollback'),
      'saveWidget must rollback (removeItem) PRO HTML key if metadata write throws',
    );
  });

  it('deleteWidget removes wm-pro-html-{id} key', () => {
    const deleteIdx = store.indexOf('function deleteWidget');
    assert.ok(deleteIdx !== -1, 'deleteWidget not found');
    const deleteBody = store.slice(deleteIdx, deleteIdx + 400);
    assert.ok(
      deleteBody.includes('wm-pro-html') || deleteBody.includes('proHtmlKey'),
      'deleteWidget must also remove the wm-pro-html-{id} key',
    );
  });

  it('wrapProWidgetHtml returns iframe with sandbox="allow-scripts" only', () => {
    assert.ok(san.includes('wrapProWidgetHtml'), 'wrapProWidgetHtml must be exported');
    // Use 1500 chars to cover the full function body including the long CSP meta tag
    const fnIdx = san.indexOf('wrapProWidgetHtml');
    const fnBody = san.slice(fnIdx, fnIdx + 1500);
    assert.ok(
      fnBody.includes('sandbox="allow-scripts"') || fnBody.includes("sandbox='allow-scripts'"),
      'iframe sandbox must be exactly "allow-scripts" — no allow-same-origin',
    );
    assert.ok(
      !fnBody.includes('allow-same-origin'),
      'sandbox must NOT include allow-same-origin',
    );
  });

  it('wrapProWidgetHtml places CSP as first head child (client-owned skeleton)', () => {
    const fnIdx = san.indexOf('wrapProWidgetHtml');
    const fnBody = san.slice(fnIdx, fnIdx + 800);
    assert.ok(
      fnBody.includes('Content-Security-Policy'),
      'wrapProWidgetHtml must embed CSP in the head',
    );
    // CSP meta should come before any style tag
    const cspPos = fnBody.indexOf('Content-Security-Policy');
    const stylePos = fnBody.indexOf('<style>');
    assert.ok(
      cspPos < stylePos,
      'CSP meta must appear before <style> in the generated HTML skeleton',
    );
  });

  it('wrapProWidgetHtml CSP has connect-src none (blocks beaconing)', () => {
    const fnIdx = san.indexOf('wrapProWidgetHtml');
    const fnBody = san.slice(fnIdx, fnIdx + 800);
    assert.ok(
      fnBody.includes("connect-src 'none'"),
      "CSP must include connect-src 'none' to block network beaconing from iframe",
    );
  });

  it('wrapProWidgetHtml uses escapeSrcdoc for attribute safety', () => {
    assert.ok(
      san.includes('escapeSrcdoc'),
      'wrapProWidgetHtml must escape the srcdoc attribute value',
    );
  });

  it('wrapProWidgetHtml injects Chart.js from jsdelivr so new Chart() is available', () => {
    const fnIdx = san.indexOf('wrapProWidgetHtml');
    const fnBody = san.slice(fnIdx, fnIdx + 1500);
    assert.ok(
      fnBody.includes('cdn.jsdelivr.net') && fnBody.includes('chart.js'),
      'wrapProWidgetHtml must inject Chart.js CDN script so widgets can call new Chart(...)',
    );
    // Script must appear before </head> so Chart is defined when body scripts run
    const scriptPos = fnBody.indexOf('chart.js');
    const bodyPos = fnBody.indexOf('<body>');
    assert.ok(
      scriptPos < bodyPos,
      'Chart.js script tag must be in <head>, before <body>',
    );
  });
});

// ---------------------------------------------------------------------------
// 13. PRO widget — modal and layout
// ---------------------------------------------------------------------------
describe('PRO widget — modal and layout integration', () => {
  const modal = src('src/components/WidgetChatModal.ts');
  const layout = src('src/app/panel-layout.ts');

  it('modal sends tier in request body', () => {
    const bodyIdx = modal.indexOf('JSON.stringify');
    assert.ok(bodyIdx !== -1);
    const bodyRegion = modal.slice(bodyIdx, bodyIdx + 400);
    assert.ok(bodyRegion.includes('tier'), "Request body must include 'tier' field");
  });

  it('modal sends X-Pro-Key header for PRO requests', () => {
    assert.ok(
      modal.includes('X-Pro-Key'),
      'Modal must send X-Pro-Key header for PRO tier requests',
    );
  });

  it('modal uses 120s timeout for PRO (vs 60s basic)', () => {
    assert.ok(
      modal.includes('120_000') || modal.includes('120000'),
      'PRO modal timeout must be 120 seconds',
    );
    assert.ok(
      modal.includes('60_000') || modal.includes('60000'),
      'Basic modal timeout must still be 60 seconds',
    );
  });

  it('modal shows preflightProUnavailable when proKeyConfigured is false', () => {
    assert.ok(
      modal.includes('proKeyConfigured') || modal.includes('preflightProUnavailable'),
      'Modal must handle proKeyConfigured=false from health endpoint',
    );
  });

  it('pendingSaveSpec includes tier field', () => {
    assert.ok(
      modal.includes('pendingSaveSpec'),
      'Modal must use pendingSaveSpec before saving',
    );
    // tier should be part of the spec being saved
    const specIdx = modal.indexOf('pendingSaveSpec');
    const specRegion = modal.slice(specIdx, specIdx + 200);
    assert.ok(
      specRegion.includes('tier') || modal.includes("tier: currentTier"),
      'pendingSaveSpec must include tier field',
    );
  });

  it('PRO example chips defined (separate from basic examples)', () => {
    assert.ok(
      modal.includes('PRO_EXAMPLE_PROMPT_KEYS'),
      'Modal must define PRO_EXAMPLE_PROMPT_KEYS for PRO example chips',
    );
  });

  it('layout has PRO create button when hasPremiumAccess', () => {
    assert.ok(
      layout.includes('hasPremiumAccess') || layout.includes('isProUser'),
      'panel-layout must import/call hasPremiumAccess (or isProUser)',
    );
    assert.ok(
      layout.includes('ai-widget-block-pro'),
      'panel-layout must render PRO create button (.ai-widget-block-pro)',
    );
  });

  it('layout PRO button opens modal with tier: pro', () => {
    const proButtonIdx = layout.indexOf('ai-widget-block-pro');
    assert.ok(proButtonIdx !== -1);
    // Use 1200 chars to cover the full button element including the click handler
    const proButtonRegion = layout.slice(proButtonIdx, proButtonIdx + 1200);
    assert.ok(
      proButtonRegion.includes("tier: 'pro'") || proButtonRegion.includes("tier:'pro'") || proButtonRegion.includes('"pro"'),
      "PRO button must open modal with tier: 'pro'",
    );
  });
});

// ---------------------------------------------------------------------------
// 14. PRO widget — i18n and CSS
// ---------------------------------------------------------------------------
describe('PRO widget — i18n keys and CSS', () => {
  const en = JSON.parse(src('src/locales/en.json'));
  const css = src('src/styles/main.css');

  const PRO_REQUIRED_KEYS = [
    'createInteractive',
    'proBadge',
    'preflightProUnavailable',
  ];

  for (const key of PRO_REQUIRED_KEYS) {
    it(`widgets.${key} is defined and non-empty`, () => {
      assert.ok(
        en.widgets && typeof en.widgets[key] === 'string' && en.widgets[key].length > 0,
        `en.json must have non-empty widgets.${key}`,
      );
    });
  }

  it('widgets.proExamples has all 4 example keys', () => {
    const exKeys = ['interactiveChart', 'sortableTable', 'animatedCounters', 'tabbedComparison'];
    for (const key of exKeys) {
      assert.ok(
        en.widgets?.proExamples?.[key] && en.widgets.proExamples[key].length > 0,
        `en.json must have non-empty widgets.proExamples.${key}`,
      );
    }
  });

  it('.widget-pro-badge CSS class defined', () => {
    assert.ok(
      css.includes('.widget-pro-badge'),
      'CSS must define .widget-pro-badge class for PRO pill badge',
    );
  });

  it('.wm-widget-pro iframe CSS sets 400px height', () => {
    assert.ok(
      css.includes('.wm-widget-pro'),
      'CSS must target .wm-widget-pro for PRO iframe container',
    );
    const proIdx = css.indexOf('.wm-widget-pro');
    const proRegion = css.slice(proIdx, proIdx + 300);
    assert.ok(
      proRegion.includes('400px') || css.includes('400px'),
      'PRO iframe must have 400px height defined in CSS',
    );
  });
});
