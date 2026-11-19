---
title: The push-endpoint allow-list checked one URL parser while the relay dialed with another
date: 2026-11-01
category: security-issues
module: notification-channels
problem_type: security_issue
component: background_job
severity: medium
symptoms:
  - "Sentry WORLDMONITOR-1B0 and WORLDMONITOR-XR: Pro activation failed with 'Failed to register push subscription (400): endpoint host is not a recognised push service.' for Chrome-labelled browsers on macOS"
  - "https://localhost%2epush.apple.com/x passed set-web-push as host localhost.push.apple.com, and the relay's web-push connected to localhost:443"
  - "https://internal.example.com{.push.apple.com/x was canonical WHATWG and passed the suffix check, while url.parse() read the host as internal.example.com"
root_cause: missing_validation
resolution_type: code_fix
related_components: [notification-relay, pro-activation]
tags: [ssrf, url-parsing, parser-differential, web-push, allowlist, push-endpoint, chromium]
---

# The push-endpoint allow-list checked one URL parser while the relay dialed with another

## Problem

`set-web-push` in `api/notification-channels.ts` stores a browser PushSubscription endpoint. The notification relay (`scripts/notification-relay.cjs`, `sendWebPush`) later POSTs to it, so the endpoint allow-list is the only SSRF gate. The gate had two defects. It refused a real browser host (`jmt17.google.com`). And it validated the endpoint with WHATWG `URL`, while the sink, web-push 3.6.7, dials with legacy `url.parse()`. The two parsers disagree on what the host is.

## Symptoms

- Two different users on Chrome 150 and Chrome 153 on macOS hit the 400 during the day-0 Pro activation alerts step. The events never named the rejected host.
- A percent-encoded dot (`localhost%2epush.apple.com`) passed the suffix check after WHATWG decoded it. `url.parse()` kept `%2e...` in the path and connected to `localhost`.
- After canonical form was required, `{`, `}`, `'`, `"`, `` ` `` and `;` still got through. WHATWG keeps these inside a hostname, so `href` round-trips and the suffix still matches, but `url.parse()` ends the host at them.

## What Didn't Work

**Requiring canonical form alone.** Rejecting an endpoint when `new URL(endpoint).href !== endpoint` closed the `%2e` family that the first review found. A security bot then showed that `internal.example.com{.push.apple.com` is already canonical WHATWG. Canonical form only proves WHATWG serializes the string the same way. It does not prove a second parser reads the same host.

**Adding characters one report at a time.** Each reviewer found the next character. A blocklist of characters chases the legacy parser's quirks one at a time. The fix that held was to bound the host by what both parsers agree on, then prove that with a sweep.

**Guessing the browser from the version number.** Chrome 153 on 2026-11-01 was three versions behind stable (156), so these users were not on Beta or Canary. The likely population is Chromium builds that report a non-stable channel. That is inference: the event never recorded the host. The PR adds a `push_endpoint_host` Sentry tag so the next refusal names it.

## Solution

Pending in PR #9929 (unmerged as of this writing).

The host list now follows `pushpad/known-push-services`, which Pushpad builds from about 200M real subscriptions. Chromium issues `https://jmt17.google.com/fcm/send/` on every non-STABLE channel while the `PushMessagingGcmEndpointWebpushPath` feature is off, which is the default ([Chromium `push_messaging_utils.cc`, `GetGcmEndpointForChannel`](https://chromium.googlesource.com/chromium/src/+/HEAD/components/push_messaging/push_messaging_utils.cc)). 37signals Campfire and Fizzy, Zammad and ente all allow it.

The check requires four things before the host lookup. The endpoint must be canonical. It must use the default port. It must have no userinfo. And its host must contain only letters, digits, hyphens and dots:

```ts
const PUSH_SERVICE_HOSTS = new Set([
  'fcm.googleapis.com',
  'android.googleapis.com',
  'jmt17.google.com',
  'updates.push.services.mozilla.com',
]);
const PUSH_SERVICE_DOMAIN_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];
const LDH_HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function isAllowedPushEndpoint(endpoint: string, u: URL): boolean {
  if (u.href !== endpoint || u.port !== '' || u.username !== '' || u.password !== '') return false;
  if (!LDH_HOSTNAME.test(u.hostname)) return false;
  return PUSH_SERVICE_HOSTS.has(u.hostname)
    || PUSH_SERVICE_DOMAIN_SUFFIXES.some((suffix) => u.hostname.endsWith(suffix));
}
```

The handler refuses a non-canonical endpoint rather than storing `u.href`. The stored string is matched by endpoint for deduplication and unsubscribe, so it must stay byte-for-byte what the browser sent.

The client also replaces a revoked subscription whose endpoint is on the reserved `.invalid` TLD. phpBB and Couchers treat `permanently-removed.invalid` as a dead subscription. `obtainSubscriptionPayload` in `src/services/push-notifications.ts` unsubscribes, waits 800 ms and subscribes again, at most three times. The wait comes from SullyOS, which reports that Chromium can return the placeholder again right after `unsubscribe()`.

## Why This Works

The guard and the sink now read the same host for every endpoint the guard accepts. A letters-digits-hyphens host with no userinfo, no port and no percent-escapes is a string both parsers split at the same place. The allow-list therefore constrains the host the relay actually dials, not a host only the edge function sees.

## Prevention

- When a validator and its sink use different parsers, the validator protects only what the two parsers agree on. Bound the input to that agreement, or validate with the sink's parser at send time.
- Prove the agreement with a sweep, not a list of known bad inputs. `tests/push-endpoint-allowlist.test.mts` sends every printable ASCII character and every `%XX` escape through the real handler in host positions. For each endpoint that reaches the relay, it asserts that `url.parse()` reads the same host and port as WHATWG:

  ```ts
  for (const endpoint of relayedEndpoints) {
    const whatwg = new URL(endpoint);
    const legacy = legacyParse(endpoint);
    assert.equal(legacy.hostname, whatwg.hostname, endpoint);
    assert.equal(legacy.port ?? '', whatwg.port, endpoint);
  }
  ```

  Without the host and userinfo checks, a standalone run of the same sweep found 269 mismatches.
- Test an allow-list through the handler, not by regex over its source. The old tests in `tests/brief-web-push.test.mjs` asserted that host strings appeared in the file, and neither defect could fail them.
- Keep a suffix match on a dot boundary (`.push.apple.com`) so `notpush.apple.com` and the bare apex fail. Fizzy's `end_with?(permitted)` has no leading dot. Campfire and Zammad use `".#{domain}"`.
- When a client error reports a server refusal, attach the non-secret part of the input (here the hostname, never the path, which holds the registration token). Without it, WORLDMONITOR-XR stayed undiagnosable for three months.

## Related

- `docs/solutions/security-issues/relay-rss-proxy-fetched-allowlisted-hosts-without-vetting-dns.md`. Same relay, a different SSRF gate: the RSS proxy trusted allowlisted hosts' DNS.
- `docs/solutions/security-issues/push-notification-click-navigated-the-open-tab-off-origin.md`. The other push trust boundary, enforced at click time rather than at registration.
