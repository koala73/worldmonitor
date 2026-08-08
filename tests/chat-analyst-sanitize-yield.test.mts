import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// U4b wiring lock (no jsdom; ChatAnalystPanel + its streaming flow can't be
// rendered in the suite). Assert the synchronous DOMPurify+marked sanitize is
// deferred off the current task via a guarded fire-and-forget yield, applied at
// both render sites — no async ripple through the sync streaming callers (#4537).
const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/components/ChatAnalystPanel.ts'),
  'utf8',
);

test('ChatAnalystPanel imports the shared yield primitive (R5)', () => {
  assert.match(src, /import \{ yieldToMain \} from '@\/utils\/after-paint'/);
});

test('renderMarkdownDeferred yields, guards isConnected, renders, then scrolls (R5)', () => {
  const m = src.match(/private renderMarkdownDeferred\([^)]*\)\s*:\s*void\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'renderMarkdownDeferred helper exists');
  const body = m![0];
  assert.match(body, /yieldToMain\(\)\.then/, 'defers via yieldToMain');
  assert.match(body, /if \(!el\.isConnected\) return/, 'guards a detached node');
  assert.match(body, /setTrustedHtml\(el, renderMarkdown\(content\)\)/, 'renders after the yield');
  // Scroll must come AFTER the render so it doesn't undershoot the grown DOM.
  const renderIdx = body.indexOf('setTrustedHtml(el, renderMarkdown(content))');
  const scrollIdx = body.indexOf('this.scrollToBottom()');
  assert.ok(scrollIdx > renderIdx, 'scrollToBottom runs after the markdown render');
});

test('finalizeStreamingBubble does not scroll synchronously before the deferred render (R5)', () => {
  const m = src.match(/private finalizeStreamingBubble\([^)]*\)\s*:\s*void\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'finalizeStreamingBubble exists');
  assert.doesNotMatch(m![0], /this\.scrollToBottom\(\)/,
    'scroll is deferred (handled inside renderMarkdownDeferred), not synchronous here');
});

test('appendMessage scrolls synchronously only for the synchronous (user) branch (R5)', () => {
  const m = src.match(/private appendMessage\([^)]*\)\s*:\s*void\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'appendMessage exists');
  assert.match(m![0], /if \(role !== 'assistant'\) this\.scrollToBottom\(\)/,
    'assistant defers its scroll; user scrolls now');
});

test('both render sites route through the deferred helper, not a sync renderMarkdown (R5)', () => {
  assert.match(src, /this\.renderMarkdownDeferred\(body, content\)/, 'appendMessage uses the helper');
  assert.match(src, /this\.renderMarkdownDeferred\(bodyEl, text\)/, 'finalizeStreamingBubble uses the helper');
  // The only remaining `setTrustedHtml(..., renderMarkdown(...))` is inside the helper itself.
  const directRenders = src.match(/setTrustedHtml\([^,]+,\s*renderMarkdown\(/g) ?? [];
  assert.equal(directRenders.length, 1, 'exactly one direct render call — the one inside the helper');
});
