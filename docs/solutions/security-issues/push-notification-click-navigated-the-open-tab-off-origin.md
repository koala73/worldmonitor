---
title: A push notification click navigated the open dashboard tab to an attacker-supplied URL
date: 2026-09-19
category: security-issues
module: notification-relay
problem_type: security_issue
component: background_job
severity: medium
symptoms:
  - "/api/notify accepted a fully attacker-crafted payload and it was delivered end-to-end from the platform's own sending identity, so the notification carried WorldMonitor's icon, title and trust"
  - "Clicking the notification did not open a new tab — notificationclick fed the payload URL to c.navigate() on the first same-origin window, so the dashboard tab itself became the attacker's page"
  - "No scheme discipline on either side of the boundary: javascript:, data: and http: targets were persisted into the notification payload too"
  - "Two pre-existing security regression suites were silently deleted by a truncating edit while the file's test count went UP, and both the local run and CI stayed green"
  - "The first fix then regressed tab reuse on every host production actually serves: the dispatcher stamped apex-absolute URLs, the worker compared origins strictly, and www never equals apex — so every dashboard click opened a duplicate tab"
root_cause: missing_validation
resolution_type: code_fix
related_components: [testing_framework]
tags: [web-push, service-worker, notification-click, tab-nabbing, open-redirect, url-validation, cross-origin, phishing]
---

# A push notification click navigated the open dashboard tab to an attacker-supplied URL

## Problem

The web-push service worker navigated the user's already-open WorldMonitor dashboard tab to whatever URL the push payload carried, and those URLs come from `event.payload.link` — published verbatim by a Pro account through `/api/notify`, or ingested verbatim from an external RSS feed. An attacker-supplied link therefore replaced a trusted, authenticated surface with an arbitrary external page (security review finding, severity MEDIUM).

## Symptoms

- `POST /api/notify` accepted a fully attacker-crafted payload — `{"eventType":"rss_alert","severity":"critical","payload":{"title":"Security notice: verify your WorldMonitor account immediately","link":"https://example.com/wm-verify-account", ...}}` — and it was delivered end-to-end from the platform's own sending identity, so the notification carried WorldMonitor's icon, title and trust.
- Clicking it did not open a new tab. On `origin/main`, `notificationclick` took `const target = (event.notification.data && event.notification.data.url) || '/'` and fed it to `c.navigate(target)` on the first same-origin window — the dashboard tab itself became `https://example.com/wm-verify-account`.
- No scheme discipline anywhere on the path: the relay stored `payload.url || 'https://worldmonitor.app/'` unchecked, and the push listener stored `typeof data.url === 'string' ? data.url : '/'`, so `javascript:`, `data:` and `http:` targets were persisted into the notification payload too.
- Reproduced mechanically: running the new suite against the `origin/main` handler fails 5 of 6 new tests (20 tests, 15 pass, 5 fail), the first with `must NOT navigate the dashboard tab to https://example.com/wm-verify-account`.

## What Didn't Work

**The host-allowlist reflex.** The obvious remedy is to validate the destination against a WorldMonitor origin allowlist and substitute the dashboard for anything else. That kills the feature: the article link *is* the payload of an `rss_alert`, and the identical link is already delivered verbatim in the email, Telegram, Slack and Discord message bodies (`scripts/notification-relay.cjs:1026`, where `formatMessage` appends `event.payload.link` to every channel's message text) — so the allowlist would degrade push to a strictly worse channel while closing nothing the other four channels leave open. Rejected.

**The first fix, which regressed tab reuse on every real host.** The initial version made the dispatcher normalize relative targets against a hardcoded apex constant (`https://worldmonitor.app/`) and had the worker compare `parsed.origin === self.location.origin`. Production never serves the worker from the apex: the canonical origin is `https://www.worldmonitor.app/`, and five vertical subdomains serve their own dashboards. So every first-party click compared unequal, took the cross-origin branch, and opened a duplicate tab instead of reusing the open dashboard — the exact behavior the fix was supposed to leave untouched. Measured base-vs-head, the base reused the tab and the first head did not.

The local suite stayed green because its sandbox pinned `self.location.origin` to the apex. **The guard was not wrong about origins; the fixture agreed with the guard instead of with production**, so the one assumption that mattered was never under test. When the sandbox was later parameterized by origin, two further pre-existing tests went red immediately — their window client sat on the apex, so "we did not navigate the dashboard" had been holding vacuously for want of a same-origin tab in the fixture at all.

**A `blob:` target reached the same-origin branch — and its reachability is the interesting part.** The first fix ordered the checks credentials → origin → scheme. `new URL('blob:https://www.worldmonitor.app/abc').origin` returns the *inner* origin, `https://www.worldmonitor.app`, so on the www worker a `blob:` URL satisfied the same-origin test and was handed to `c.navigate()` on the dashboard tab — while the code comment directly above claimed the non-https collapse was exhaustive. It was exhaustive only for schemes whose origin serializes to `null` (`javascript:`, `data:`).

Four clauses, each checkable, because the obvious summary of this is wrong in both directions:

1. **Not shipped.** The branch never merged (`git merge-base --is-ancestor <head> origin/main` fails), so nothing reached production.
2. **Not reachable through the new dispatcher.** The same pass added an https-only gate to the dispatcher, so no *new* payload could carry a `blob:` target to a worker. Through that path it was pure defense-in-depth.
3. **Reachable on merge, through history.** The pre-PR dispatcher sanitized nothing — it stored `payload.url` verbatim — so a publisher could already have put a `blob:` target into a notification that is still displayed. Displayed notifications never expire and their click is dispatched to whichever worker is *active at click time*, so on merge the new worker would have handled those legacy notifications with the broken ordering. This is the same persistence property the fix is built around, turned against the fix: **adding an input guard does not retire the payloads that predate it.**
4. **Bounded to tab defacement, not a phishing pivot.** A blob URL can only be minted inside its own origin's context, so an attacker cannot create one in ours; the navigation lands on a dead blob. That is why reviewers rated it P2/P3 rather than P0, and why describing it as an exploitable navigation would misprice it for the next reader.

Moving the scheme gate above the origin comparison is what makes the comment true.

Three further defects rode along, and all three were caught by automated PR reviewers on #8384 — not by the author, not by the local run, not by CI.

**1. A Python splice silently truncated the test file.** The new suite was inserted with `open(p,'w').write(s[:start] + new_suite)`, which discards everything after the insertion point. That deleted two pre-existing security regression suites: the PR #3173 `set-web-push SSRF allow-list` lock and the `setWebPushChannelForUser endpoint dedupe` lock. Measured on this tree: `tests/brief-web-push.test.mjs` holds 14 `it()` blocks at `origin/main`, 15 at the truncating commit, 20 at the restored head — 4 added and 3 deleted in one step. The total went **up**, which is exactly why nobody noticed — the run was all-green at every step and the PR's CI reported no failures. No coverage ratchet, test-count pin, mutation gate, or diff-based deleted-test check exists in this repo, so a deleted `it()` is invisible unless the file happens to be one of roughly thirty hand-registered surfaces (`scripts/check-inventory-count-contracts.mjs`, `tests/ci-workflow-coverage.test.mts`, and friends, which read another test file's source and assert a named block still exists). `tests/brief-web-push.test.mjs` is not one of them. Only the automated security review caught it.

**2. An unawaited promise escaped its own `catch`.** `return clients.openWindow(target)` inside an `async` function's `try` returns the promise without awaiting it, so its rejection bypasses the local `catch` and surfaces as an unhandled rejection inside `event.waitUntil()`. Per the `Clients.openWindow()` contract (MDN: *"The promise is rejected with this exception if none of the windows in the app's origin have transient activation"*) it rejects with `InvalidAccessError` — a condition the user agent can legitimately produce, so the rejection has to be caught either way. The same shape applied to `return c.focus()`. Worth naming precisely: this was a **pre-existing pattern in the file** that the new cross-origin branch copied, so the bug class predates this change.

**3. A vacuously passing test.** The test named *"still reuses the dashboard tab for same-origin targets"* left the sandbox's `windowClients` array empty. With no window to reuse, the handler fell straight through to `clients.openWindow('/settings')`, and the test asserted on `box.opened` — it never exercised the reuse path in its own name. It passed, and it would have kept passing if tab reuse broke entirely. A textbook Vacuous Guard (see `CONCEPTS.md` → Vacuous Guard, Mutation Proof).

## Solution

Fix opened in **#8384**, unmerged as of this writing. Shipped in two passes: the first established the tab rule, and a code review of that pass produced the origin-agnostic design below. Branch commits are cited only to date the evidence — a squash rewrites them, so **#8384 is the durable reference**.

**The dispatcher emits no origin at all.** A generic first-party target is relativized to a bare path, so one payload is correct on www and on every vertical (`scripts/notification-relay.cjs:645`, `:665`):

```js
const PUSH_DASHBOARD_PATH = '/';
const GENERIC_FIRST_PARTY_HOSTS = ['worldmonitor.app', 'www.worldmonitor.app'];

function safePushClickUrl(raw, userId) { // :665 — userId is for rejection logging
  // ... https-only, no embedded credentials, else reject to PUSH_DASHBOARD_PATH
  if (!GENERIC_FIRST_PARTY_HOSTS.includes(parsed.hostname)) return parsed.href; // off-origin + verticals stay absolute
  if (APEX_SERVED_PATHS.some((re) => re.test(parsed.pathname))) return parsed.href;
  const relative = parsed.pathname + parsed.search + parsed.hash;
  const resolved = new URL(relative, PUSH_PARSE_BASE);
  if (resolved.origin !== PUSH_PARSE_BASE_ORIGIN) return reject('first-party host with an off-origin path'); // :705
  return resolved.pathname + resolved.search + resolved.hash;                    // :714
}
```

Three things are deliberate. The host list is matched by **exact equality**, never prefix or suffix, or `worldmonitor.app.evil.com` would be pulled onto the serving origin. The vertical subdomains are **absent from it**: they are distinct surfaces, so relativizing one would let another vertical's worker resolve it onto itself and land the user on the wrong dashboard. And `APEX_SERVED_PATHS` (`:657` — `/mcp`, `/oauth/`, `/.well-known/`, `/robots.txt`, `/security.txt`) must stay absolute because Cloudflare serves them on the apex; relativizing `/oauth/register` destroys the apex origin before the worker can act on it, and a www redirect turns a registration POST into a GET (405).

**The worker resolves onto whatever origin is serving it** (`public/push-handler.js:59`), with the scheme gate above the origin comparison:

```js
if (parsed.username || parsed.password) return dashboard;            // :70
if (parsed.protocol !== 'https:') return dashboard;                  // :77 — MUST precede :79; blob: origin is the inner origin
if (parsed.origin === self.location.origin) return { url: raw, crossOrigin: false }; // :79
if (GENERIC_FIRST_PARTY_HOSTS.indexOf(parsed.hostname) !== -1 && !isApexServedPath(parsed.pathname)) {
  const resolved = new URL(parsed.pathname + parsed.search + parsed.hash, self.location.origin);
  if (resolved.origin !== self.location.origin) return dashboard;    // :105
  return { url: resolved.href, crossOrigin: false };                 // :106
}
return { url: parsed.href, crossOrigin: true };                      // :109
```

The worker half is not redundant with the dispatcher half. A displayed notification never expires, and its click is dispatched to whichever worker is active at click time — so the worker is the **only** half that can repair a payload already sitting in a notification center, which the dispatcher can no longer reach.

**Detaching a path from its origin is the dangerous step, and both halves defend it identically.** A target can be first-party *by host* and still carry a pathname of `//evil.com`, which re-resolves straight back off-origin — onto the dashboard tab, the precise attack the guard exists to stop. Verified: `new URL('https://worldmonitor.app//evil.com').pathname` is `//evil.com`, and `new URL('//evil.com', 'https://www.worldmonitor.app').href` is `https://evil.com/`. Both laundering spellings arrive as that same pathname because the parser normalizes a backslash to a slash. Each half therefore re-resolves and compares **origins** rather than testing the string's shape — robust to any pathname the parser can produce instead of an enumeration of the ones someone thought to list — and each returns the **re-resolved** path rather than the string it validated, since an authority-shaped pathname passes the origin check and would still re-pin a vertical's click onto www.

**Verification.** Worker suite and relay sweep both green at the merged head; the suite now runs origin-sensitive cases against www and a vertical rather than a single pinned origin, and an exemption-sync test keeps the worker's `APEX_SERVED_PATHS` aligned with the canonical list. Earlier in the PR, the service-worker suite was confirmed RED against the pre-fix handler by the recipe in Prevention #4.

## Why This Works

Root cause: the handler conflated *where the user is sent* with *which surface gets consumed*. The payload URL was untrusted input, and the only navigation primitive it reached — `c.navigate()` on an existing same-origin client — is the one that destroys a trusted tab. The severity never came from the destination; it came from the destination landing in the dashboard's tab, wearing the dashboard's session and the user's belief that they were still inside WorldMonitor.

So the fix **inverts the axis of control: it does not restrict WHICH URL, it restricts WHICH TAB.** Off-origin targets survive untouched and open in their own window (`public/push-handler.js:109`); the dashboard tab is reachable only on a branch the classifier proved resolves to the worker's own origin. The tab-replacement was the vulnerability; the destination is the feature. A host allowlist was the wrong instrument because it pays for the fix with the feature, while the tab rule costs nothing a user would notice and is exactly what the email, Telegram, Slack and Discord channels already do with the same link.

The correction adds a second principle the first attempt violated: **a dispatcher that writes a click target must not encode an origin in it.** Any absolute first-party URL it stamps is correct for exactly one host and cross-origin to every other host the same app serves from — so the moment the product grows a www redirect or a vertical subdomain, a strict origin comparison downstream starts failing on traffic that is genuinely first-party. Emitting a path and letting each worker resolve against its own origin makes the payload host-independent by construction, which is why the fix *removes* knowledge rather than adding a host list to the relay. Naming the apex as canonical anywhere in that path is the root cause, not a detail.

Two narrower properties fall out of the classifier's ordering. Everything that is neither same-origin nor `https:` collapses to `/`, and that claim is only true with the scheme gate above the origin comparison, because `URL.origin` for a `blob:` returns its inner origin. Embedded credentials are rejected before either check, so `https://worldmonitor.app@evil.com/` cannot masquerade as ours in a notification the user reads at a glance. Defense is duplicated across the trust boundary on purpose: the dispatcher refuses to *emit* a bad target, the worker refuses to *act* on one, and neither depends on the other being correct — which matters most for notifications already displayed, where only the worker still has a vote.

## Prevention

**1. After any scripted rewrite of an existing file, diff for deletions.** This is the one that green tests and green CI cannot give you:

```sh
git diff <base> -- <path> | grep '^-' | grep 'describe(\|function \|export '
```

Every line it prints must be an intentional deletion. Prefer an anchored insert (`s.replace(anchor, new_suite + anchor)`) over index slicing; if you slice, `s[:start] + new_suite + s[start:]`, never `s[:start] + new_suite`. A raw count is not a substitute, because the count can rise while suites vanish: here 14 → 15 looked like +1 added, and was actually +4 added, −3 deleted.

Two refinements, both learned by hitting this class a second and third time in the same PR:

**Anchor a slice on the preceding block's own last line, never on the next section heading.** Headings repeat, and `str.index(heading)` returns the *nearest* match, which can be hundreds of lines past the block you meant to replace. Re-applying one glossary entry this way silently deleted 318 lines of the file.

**In a prose file, the diff statistic is the only signal there is.** Code has a suite that can go red; `CONCEPTS.md` has nothing. `git show --numstat` on the commit is the check — for a docs commit, insertions should dominate and every deletion should be an in-place line replacement you can name. That numstat is what caught the 318-line deletion, one step before it was pushed.

**2. `return await` inside a `try`, always.** In an `async` function, `return p` inside `try { } catch { }` hands `p`'s rejection to the caller, not to that `catch`. In a service worker the caller is `event.waitUntil()`, so the rejection becomes an unhandled rejection with no owner. Grep the SW surface for the shape:

```sh
grep -rn 'return \(clients\.openWindow\|c\.focus\|[A-Za-z_.]*\.navigate\)(' public/*.js
```

Every hit inside a `try` must read `return await`. It is pinned behaviorally rather than lexically by two tests in `tests/brief-web-push.test.mjs` — `:301` (`openWindow` rejects for both an off-origin and a same-origin target) and `:328` (a `focus()` rejection after a *successful* navigate must not also open a tab) — each asserting `await assert.doesNotReject(Promise.all(ev.waits))`.

**3. Make a tab-reuse test non-vacuous by asserting on the road not taken.** A reuse test with an empty `windowClients` array tests the fallback, not the reuse. Seed the client — with its URL derived from the sandbox origin, never a literal — then assert all three facts: navigation happened, focus happened, and *no new window opened* (`tests/brief-web-push.test.mjs:277`):

```js
box.windowClients.push({
  url: `${box.origin}/`,            // derived, not a literal — see Prevention #6
  focus() { focused = true; return this; },
  navigate(url) { navigated = url; return Promise.resolve(); },
});
// ...
assert.equal(navigated, '/settings', 'the open dashboard tab is reused');
assert.equal(focused, true);
assert.equal(box.opened, null, 'openWindow must NOT fire when a window is reused');
```

The `box.opened === null` assertion is the load-bearing one: it is what fails if the handler silently falls through to `openWindow`, which is precisely how the vacuous version passed. Mirror it on the security side — the off-origin test asserts the negative too (`:237-238`): `navigated === null`, `focused === false`, *and* `box.opened === expected`.

**4. Red-first is non-optional for a security fix, and run it against the pre-fix file, not a mutant.** Copy the base file out and repoint the harness rather than editing the shared tree:

```sh
git show origin/main:public/push-handler.js > /tmp/base-push-handler.js
sed "s#resolve(__dirname, '../../public/push-handler.js')#'/tmp/base-push-handler.js'#" \
  tests/helpers/sw-sandbox.mjs > tests/helpers/__tmp-sw-sandbox.mjs
sed "s#'./helpers/sw-sandbox.mjs'#'./helpers/__tmp-sw-sandbox.mjs'#" \
  tests/brief-web-push.test.mjs > tests/__tmp-red.test.mjs
node --test tests/__tmp-red.test.mjs
rm -f tests/__tmp-red.test.mjs tests/helpers/__tmp-sw-sandbox.mjs
```

Two patches, because the sandbox that reads the handler now lives in a shared helper — repoint the helper, then repoint the suite at the temporary helper, so the shared one is never edited in place (another agent's worktree shares it). Run at the current head this reports 35 tests, 15 pass, 20 fail. Expect the security tests red and the preserved-behavior tests green — a suite that goes *entirely* red against the old file is usually over-asserting, and one that stays green is not testing the bug.

**5. Keep the call site locked, not just the helper.** A sanitizer only helps where it is called, so a retained source-text assertion reads the `sendWebPush` source and requires the call to be present and correctly shaped (`scripts/notification-relay.cjs:734`, currently `url: safePushClickUrl(payload.url, userId)`). Note the coupling this creates, and that it fired as designed: when the helper later took a second argument for rejection logging, the assertion broke and had to be updated in the same change — a source-text guard makes the refactor re-prove the guard rather than silently outliving it.

**6. A fixture that pins an origin production never serves must be treated as a bug, not a detail.** This is the one that cost a regression. The suite pinned `self.location.origin` to the apex while the canonical origin is www and five verticals serve their own dashboards, so the fixture agreed with the guard instead of with production and the only assumption that mattered went untested. Parameterize the sandbox by origin and run origin-sensitive cases against more than one:

```js
// origin-sensitive cases run against the canonical host AND a vertical
for (const origin of ['https://www.worldmonitor.app', 'https://tech.worldmonitor.app']) { /* ... */ }
```

Derive every fixture URL from that parameter — a window client left on a hardcoded origin is how two of these tests had been passing vacuously, with no same-origin tab in the fixture for "we did not navigate the dashboard" to be about. The general rule: when a guard compares against an environment value, the fixture must supply the *real* values, and more than one of them, or the test proves only that the guard agrees with itself.

**7. Order a scheme gate above an origin comparison, and distrust `URL.origin` for exotic schemes.** `new URL('blob:https://www.worldmonitor.app/x').origin` returns the inner origin, so a `blob:` target satisfies a same-origin test that `javascript:` and `data:` (origin `null`) both fail. Any classifier that reasons about origin must reject non-`https:` first, or its "everything else collapses" comment is false for exactly the schemes nobody tests. And when you assess such a hole, separate *reachable through the new input path* from *reachable through payloads that predate the guard* — a guard added upstream does not retire what is already stored downstream. Check the claim rather than the comment:

```sh
node -e "console.log(new URL('blob:https://www.worldmonitor.app/x').origin)"   # => https://www.worldmonitor.app
```

**8. Treat every `event.payload.*` field as attacker-controlled at the sink.** `/api/notify` is a Pro-account write surface and RSS ingestion copies fields verbatim, so any new consumer of a payload field inherits this threat model. When a field reaches a navigation, a fetch, or an HTML sink, the question to ask is not "is this URL allowed" but "what surface does acting on it consume".

## Related Issues

- [Country Scope filter's permissive default leaked every unattributed alert category](../logic-errors/country-scope-filter-permissive-default-leaked-unattributed-alerts.md) — same file (`scripts/notification-relay.cjs`), same shape: the relay trusted a publisher-supplied payload field because the default was permissive rather than deny-by-default.
- PR #3173 introduced `public/push-handler.js`, `sendWebPush()`, and the `set-web-push` SSRF allow-list. **Do not conflate its guard with this one** — they are two different trust boundaries that share no source file and happen to be locked by the same test file (which is why one truncating edit hit both). #3173's `isAllowedPushEndpointHost` controls *which push-service host may receive a subscription*, at endpoint-registration time. This fix controls *which tab a click opens and which URL scheme survives*, at send time. A future reader touching either should confirm which boundary they are changing.
- PR #8384 — this fix.
