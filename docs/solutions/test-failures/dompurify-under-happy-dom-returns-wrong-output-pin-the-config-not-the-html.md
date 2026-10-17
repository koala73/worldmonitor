---
title: DOMPurify under happy-dom returns wrong output, so a tests/dom test must pin the purify config, not the sanitized HTML
module: tests-dom
date: 2026-10-14
problem_type: test_failure
component: testing_framework
severity: medium
symptoms:
  - "A tests/dom test asserting DOMPurify output fails with 'expected ... not to contain <img' although the config omits img"
  - "DOMPurify.sanitize('<p class=\"a\" id=\"b\">t<img src=x></p>', { ALLOWED_TAGS: ['p'], ALLOWED_ATTR: ['class'] }) returns 't<img src=\"x\">' under vitest.dom.config.mts"
  - "DOMPurify.isSupported is true under happy-dom, so nothing warns that the sanitizer is not doing its job"
root_cause: wrong_api
resolution_type: test_fix
related_components: [tooling, development_workflow]
tags: [dompurify, happy-dom, vitest, tests-dom, sanitizer, deduction-panel, green-while-dead]
---

# DOMPurify under happy-dom returns wrong output, so a tests/dom test must pin the purify config, not the sanitized HTML

## Problem

`src/components/DeductionPanel.ts` gained a restrictive DOMPurify config so LLM markdown grounded on RSS headlines cannot carry an `<img>` or `<a href>` into the panel (PR #9131). The first test for it ran `DOMPurify.sanitize(marked.parse(md), DEDUCTION_PURIFY_CONFIG)` under `vitest.dom.config.mts` (happy-dom) and asserted the output. It failed in both directions: the output still contained `<img`, and a `<p class="ds-verdict">` was reduced to the bare text `t`.

## Symptoms

- `expected '<strong>Bottom Line</strong>\n<p>Esca…' not to contain '<img'`
- `expected 't' to be '<p class="ds-verdict">t</p>'`
- `DOMPurify.isSupported === true`, `DOMPurify.version === '3.4.16'`, with happy-dom as the vitest environment (`vitest.dom.config.mts` sets `environment: 'happy-dom'`).

## What Didn't Work

- Trusting `isSupported`. It only checks that a DOM exists, not that the walk behaves.
- Switching to jsdom. It is not in `node_modules`, and the existing DOM suite is happy-dom by design (see the pre-push routing doc linked below).
- The ChatAnalystPanel DOM test (`tests/dom/chat-analyst-deferred-markdown.test.mts`) looked like precedent for sanitizer assertions, but it only checks `<strong>` presence after a deferred render; it never asserts that anything was *removed*.

## Solution

Pin the config object, which is what the panel actually passes, and leave sanitizer semantics to DOMPurify's own suite:

```ts
// tests/dom/deduction-purify-config.test.mts
import { DEDUCTION_PURIFY_CONFIG } from '../../src/components/DeductionPanel';

const tags = new Set(DEDUCTION_PURIFY_CONFIG.ALLOWED_TAGS);
for (const tag of ['img', 'a', 'iframe', 'svg', 'form', 'script', /* … */]) {
  expect(tags.has(tag), tag).toBe(false);
}
expect(DEDUCTION_PURIFY_CONFIG.ALLOWED_ATTR).toEqual(['class']);
expect(DEDUCTION_PURIFY_CONFIG.ALLOW_DATA_ATTR).toBe(false);
expect(DEDUCTION_PURIFY_CONFIG.ALLOW_ARIA_ATTR).toBe(false);
```

A structural test in `tests/deduction-sanitize-yield.test.mts` already pins that the panel calls `DOMPurify.sanitize(parsed, DEDUCTION_PURIFY_CONFIG)`, so the two together prove the config is both correct and used.

## Why This Works

A standalone probe (happy-dom `Window` as `globalThis.window`/`document`, then `require('dompurify')`) reproduces the failure outside vitest, so this is happy-dom's DOM, not vitest. DOMPurify walks the parsed tree with a `NodeIterator`; happy-dom's implementation hands back nodes in an order that lets DOMPurify remove the `<p>` it is standing on and skip the `<img>` it should have removed. The output is therefore wrong, not merely different. Asserting on it proves nothing, and a test that happened to pass would be green for the wrong reason.

The config is the contract the component owns. DOMPurify's tag and attribute filtering is covered upstream against a real DOM, so the config-shape test plus the structural call-site test cover everything this repo controls.

## Prevention

- In `tests/dom/`, never assert on `DOMPurify.sanitize` output. Assert on the config object and on the call site.
- If a test needs real sanitizer behaviour, that is a Playwright e2e against a browser, not a happy-dom unit.
- When introducing a per-panel purify config, also set `ALLOW_ARIA_ATTR: false`; DOMPurify keeps `aria-*` even when `ALLOWED_ATTR` omits them (CodeRabbit on #9131), and an injected `aria-hidden` would hide the content from screen readers.
- A reusable probe lives in this repo's history as the PR #9131 review notes; three lines reproduce it: create a happy-dom `Window`, assign `window`/`document` on `globalThis`, call `DOMPurify.sanitize` with an `ALLOWED_TAGS` list.

## Related Issues

- PR #9131 (the DeductionPanel purify config and this test).
- [Pre-push fed vitest DOM tests to the node:test runner](pre-push-fed-vitest-dom-tests-to-the-node-test-runner.md): why `tests/dom/` is happy-dom under vitest and must stay out of `node --test`.
