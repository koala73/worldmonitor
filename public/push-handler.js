// Service worker push handler (Phase 6).
//
// Imported by VitePWA's generated sw.js via workbox.importScripts:
// ['/push-handler.js']. Runs in the SW global scope — has access to
// self.addEventListener, self.registration.showNotification,
// clients.openWindow, etc.
//
// Payload contract (sent by scripts/notification-relay.cjs):
//   { title: string, body: string, url?: string, tag?: string,
//     icon?: string, badge?: string }
//
// Any deviation from that shape falls back to a safe default so a
// malformed payload still renders something readable instead of
// silently dropping the notification.

/* eslint-env serviceworker */
/* global self, clients */

// Classify a click target. Payload URLs come from event.payload.link, which
// is published verbatim by Pro accounts through /api/notify or ingested
// verbatim from external RSS feeds, so the target is not trusted.
//
//   crossOrigin: false — reuse the open dashboard tab (focus + navigate)
//   crossOrigin: true  — the article opens in its OWN tab
//
// The distinction is the whole guard: navigating the already-open dashboard
// to an attacker-supplied link replaces a trusted surface with a page
// WorldMonitor does not control. Opening a fresh tab is the same thing the
// email / Telegram / Slack channels already do with the link in the message.
// Anything that is neither same-origin nor https collapses to the dashboard,
// so a javascript: or data: target can never become a navigation.

// Generic aliases for "the dashboard", matched by EXACT hostname equality —
// never a prefix, suffix, or substring test, which would pull
// worldmonitor.app.evil.com onto the serving origin. The vertical subdomains
// are deliberately absent: tech/finance/etc. are distinct surfaces with their
// own installs, so rewriting one onto another would land the user on the wrong
// dashboard. This list does not grow when a vertical is added.
const GENERIC_FIRST_PARTY_HOSTS = ['worldmonitor.app', 'www.worldmonitor.app'];

// Paths Cloudflare serves on the apex and must NEVER be rewritten to www.
// Mirrors ARCHITECTURE.md §2 and the APEX_SERVED list in
// tests/agent-corpus-canonical-host.test.mjs. Dropping /mcp* breaks every
// apex-URL MCP client; dropping /oauth/* turns a registration POST into a GET
// and kills it with 405 (#4938). Matched against the parsed pathname, not the
// raw target, so /oauth/../dashboard classifies by where it actually lands.
const APEX_SERVED_PATHS = [
  /^\/mcp(?:\/|$)/,
  /^\/oauth\//,
  /^\/\.well-known\//,
  /^\/robots\.txt$/,
  /^\/security\.txt$/,
];

function isApexServedPath(pathname) {
  return APEX_SERVED_PATHS.some((re) => re.test(pathname));
}

function classifyClickTarget(raw) {
  const dashboard = { url: '/', crossOrigin: false };
  if (typeof raw !== 'string' || raw.length === 0) return dashboard;
  let parsed;
  try {
    parsed = new URL(raw, self.location.origin);
  } catch {
    return dashboard;
  }
  // Embedded credentials (https://worldmonitor.app@evil.com/) exist only to
  // make a hostile host read as ours. No real article link carries them.
  if (parsed.username || parsed.password) return dashboard;

  // Scheme gate runs BEFORE the origin comparison. URL.origin for a blob:
  // returns the INNER origin, so blob:https://www.worldmonitor.app/x would
  // otherwise satisfy the same-origin branch and reach navigate() on the
  // dashboard tab. The comment above claims this collapse is exhaustive; it is
  // only true with the check in this position.
  if (parsed.protocol !== 'https:') return dashboard;

  if (parsed.origin === self.location.origin) return { url: raw, crossOrigin: false };

  // A generic first-party absolute means "the dashboard", so re-express it on
  // whatever origin is actually serving this worker. This is the only half that
  // can fix payloads already sitting in a notification center: a displayed
  // notification never expires and its click is dispatched to whichever worker
  // is active at click time, so the relay can no longer reach it.
  if (
    GENERIC_FIRST_PARTY_HOSTS.indexOf(parsed.hostname) !== -1 &&
    !isApexServedPath(parsed.pathname)
  ) {
    const rewritten = parsed.pathname + parsed.search + parsed.hash;
    // Re-attaching a preserved path to our origin is itself a relativization,
    // and it is the dangerous one: https://worldmonitor.app//evil.com has a
    // pathname of //evil.com, which resolves straight back off-origin — onto
    // the open dashboard tab, which is precisely the attack this guard exists
    // to stop. Both laundering spellings arrive as that same pathname, because
    // the parser normalizes a backslash to a slash. We re-resolve and compare
    // origins rather than testing the string's shape, because that is robust to
    // ANY pathname the parser can produce, not just the ones we thought to list.
    let resolved;
    try {
      resolved = new URL(rewritten, self.location.origin);
    } catch {
      return dashboard;
    }
    if (resolved.origin !== self.location.origin) return dashboard;
    return { url: resolved.href, crossOrigin: false };
  }

  return { url: parsed.href, crossOrigin: true };
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_err) {
    // Non-JSON payload: treat the text body as the notification body.
    try {
      data = { title: 'WorldMonitor', body: event.data ? event.data.text() : '' };
    } catch {
      data = {};
    }
  }

  const title = typeof data.title === 'string' && data.title.length > 0
    ? data.title
    : 'WorldMonitor';
  const body = typeof data.body === 'string' ? data.body : '';
  const url = classifyClickTarget(data.url).url;
  const tag = typeof data.tag === 'string' ? data.tag : 'worldmonitor-generic';
  const icon = typeof data.icon === 'string'
    ? data.icon
    : '/favico/android-chrome-192x192.png';
  const badge = typeof data.badge === 'string'
    ? data.badge
    : '/favico/android-chrome-192x192.png';

  const opts = {
    body,
    icon,
    badge,
    tag,
    // requireInteraction keeps the notification on screen until the
    // user acts on it. Critical for brief_ready where we want the
    // reader to actually open the magazine, not dismiss it from the
    // lock screen.
    requireInteraction: data.eventType === 'brief_ready',
    data: { url, eventType: data.eventType ?? 'unknown' },
  };

  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url: target, crossOrigin } = classifyClickTarget(
    event.notification.data && event.notification.data.url,
  );
  const tag = (event.notification.data && event.notification.data.tag)
    || (typeof event.notification.tag === 'string' ? event.notification.tag : '');
  // The blocked notice itself carries tag 'suppressed:*': bypass the check
  // so its click can never re-enter the suppression path.
  if (typeof tag === 'string' && tag.startsWith('suppressed:')) {
    event.waitUntil((async () => {
      try {
        if (clients.openWindow) await clients.openWindow('/');
      } catch {
        // Swallow — nothing to do beyond failing silently.
      }
    })());
    return;
  }
  event.waitUntil((async () => {
    // Operator revoke path (#8401): an already-delivered push payload
    // carries its URL on-device. When the operator blocks that URL after
    // delivery, the click must not navigate to it — show the blocked
    // notice instead. Fail-open: when the check file is absent (old SW)
    // or the endpoint is unreachable, navigate as before.
    try {
      const suppression = self.wmLinkSuppression;
      if (suppression && typeof suppression.checkLinkSuppressed === 'function') {
        const blocked = await suppression.checkLinkSuppressed(target);
        if (blocked) {
          if (typeof self.wmShowBlockedNotice === 'function') {
            try {
              await self.wmShowBlockedNotice(tag);
            } catch {
              // The blocked decision is terminal even when the replacement
              // notice cannot be shown. Never fall through to the blocked URL.
            }
          }
          return;
        }
      }
    } catch {
      // Suppression-check failure must never strand the click.
    }
    try {
      // An off-origin article always gets a fresh tab. Never hand it the
      // dashboard's — that tab is a trusted surface the user came back to.
      if (crossOrigin) {
        if (clients.openWindow) return await clients.openWindow(target);
        return;
      }
      const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      // If an existing window points at our origin, focus it and
      // navigate rather than spawning a new tab. Cheaper for the
      // user, less duplicated app state.
      for (const c of all) {
        try {
          const sameOrigin = new URL(c.url).origin === self.location.origin;
          if (sameOrigin && 'focus' in c) {
            if ('navigate' in c && typeof c.navigate === 'function') {
              await c.navigate(target);
            }
            // Once a client has been navigated the content is delivered, so a
            // focus failure must not fall through to openWindow — that would
            // leave the tab navigated AND spawn a duplicate at the same URL,
            // the "duplicated app state" this branch exists to avoid.
            // focus() rejects with InvalidAccessError once the click's
            // transient activation expires, which the awaited navigate() above
            // makes reachable.
            try {
              return await c.focus();
            } catch {
              return;
            }
          }
        } catch {
          // URL parse failure, cross-origin, or a focus/navigate rejection
          // — fall through and try opening a window instead.
        }
      }
      if (clients.openWindow) return await clients.openWindow(target);
    } catch {
      // Swallow — nothing to do beyond failing silently.
    }
  })());
});
