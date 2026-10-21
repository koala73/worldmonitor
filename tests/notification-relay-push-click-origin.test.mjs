/**
 * REGRESSION: the relay must not stamp an origin onto push click URLs.
 *
 * Web-push payload URLs come from `event.payload.link`, which is either
 * published verbatim by a Pro account through /api/notify or ingested verbatim
 * from an external RSS feed — so every input here is attacker-supplied.
 *
 * The relay used to absolutize every first-party target onto a hardcoded apex
 * origin. The service worker runs on www and on five vertical subdomains, never
 * the apex, so those URLs read as cross-origin and opened a duplicate tab
 * instead of reusing the dashboard. The relay cannot name the right origin —
 * it is a root-level CJS script that cannot import the app's CANONICAL_ORIGIN,
 * so any origin it names is a hand-copied constant, the exact drift 066d7e6c3
 * calls out. So it names none: first-party targets go out as relative paths and
 * each worker resolves against whatever origin is serving it.
 *
 * One absolute constant survives as a PARSE BASE — `new URL('/x', '/')` throws,
 * a relative base is not a legal base — but it is never returned.
 *
 * Run: node --test tests/notification-relay-push-click-origin.test.mjs
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import {
  FIRST_PARTY_PATH_LAUNDERING,
  FIRST_PARTY_AUTHORITY_SHAPED,
  UNPARSEABLE,
  HOSTILE_SCHEMES,
  LOOKALIKE_HOSTS,
} from './fixtures/hostile-push-urls.mjs';
import {
  makeSwSandbox,
  loadHandlerInto,
  addWindowClient,
  clickNotification,
  SERVING_ORIGINS,
} from './helpers/sw-sandbox.mjs';

const require = createRequire(import.meta.url);

let safePushClickUrl;

before(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
  process.env.CONVEX_URL = 'https://convex.test';
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_NOTIFICATION_RELAY_SECRET = 'relay-secret';
  process.env.RESEND_API_KEY = 'resend-key';
  const relayPath = require.resolve('../scripts/notification-relay.cjs');
  delete require.cache[relayPath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, ...rest) {
    if (request === 'resend') {
      return { Resend: class { emails = { send: async () => ({ data: { id: 'sent' }, error: null }) }; } };
    }
    return originalLoad.call(this, request, parent, ...rest);
  };
  try {
    ({ safePushClickUrl } = require(relayPath));
  } finally {
    Module._load = originalLoad;
  }
});

describe('safePushClickUrl', () => {
  it('emits first-party targets as relative paths, carrying no origin', () => {
    assert.equal(
      safePushClickUrl('https://worldmonitor.app/api/brief/u/2026-09-19?t=x'),
      '/api/brief/u/2026-09-19?t=x',
    );
    assert.equal(safePushClickUrl('https://www.worldmonitor.app/dashboard'), '/dashboard');
    assert.equal(safePushClickUrl('https://worldmonitor.app/'), '/');
  });

  it('preserves query and fragment', () => {
    assert.equal(
      safePushClickUrl('https://worldmonitor.app/brief?t=signed#section'),
      '/brief?t=signed#section',
    );
  });

  it('leaves a relative path relative', () => {
    assert.equal(safePushClickUrl('/dashboard'), '/dashboard');
    // A bare string is a relative path, so it stays on-origin — harmless.
    assert.equal(safePushClickUrl('not a url'), '/not%20a%20url');
  });

  it('keeps off-origin https article links absolute — the SW gives them their own tab', () => {
    assert.equal(safePushClickUrl('https://reuters.com/world/story'), 'https://reuters.com/world/story');
    assert.equal(safePushClickUrl('//example.com/wm-verify-account'), 'https://example.com/wm-verify-account');
  });

  it('keeps vertical-subdomain targets absolute — a different surface is not ours to relativize', () => {
    assert.equal(
      safePushClickUrl('https://tech.worldmonitor.app/dashboard'),
      'https://tech.worldmonitor.app/dashboard',
    );
  });

  it('keeps apex-exempt paths absolute on the apex', () => {
    // Cloudflare serves these on the apex and must never see them rewritten:
    // /oauth/* turned into a www redirect makes a registration POST a GET (405,
    // #4938). Relativizing would destroy the apex origin before the worker,
    // which can only recognize an ABSOLUTE apex URL, ever gets a say.
    // Matched against the NORMALIZED pathname, so a dot-segment that escapes an
    // exempt prefix is classified by where it actually lands.
    assert.equal(
      safePushClickUrl('https://worldmonitor.app/oauth/../dashboard', 'user_abc'),
      '/dashboard',
      'a dot-segment escaping an exempt prefix is not apex-served',
    );
    for (const path of ['/mcp', '/oauth/register', '/.well-known/api-catalog', '/robots.txt']) {
      assert.equal(
        safePushClickUrl(`https://worldmonitor.app${path}`),
        `https://worldmonitor.app${path}`,
        `${path} is apex-served`,
      );
    }
  });

  it('substitutes the dashboard for schemes that must never navigate', () => {
    for (const { raw, why } of HOSTILE_SCHEMES) {
      assert.equal(safePushClickUrl(raw), '/', `must reject ${raw} (${why})`);
    }
  });

  it('does not launder a first-party URL into an off-origin link', () => {
    // These are first-party BY HOST but their pathname is //evil.com, so
    // stripping the origin emits a protocol-relative reference. Asserting the
    // re-resolved ORIGIN is the point: both spellings arrive as the same
    // `//evil.com` pathname, and comparing the resolved origin is robust to any
    // authority-shaped pathname rather than to an enumerated string shape.
    for (const { raw, why } of FIRST_PARTY_PATH_LAUNDERING) {
      const out = safePushClickUrl(raw);
      for (const origin of SERVING_ORIGINS) {
        assert.equal(
          new URL(out, origin).origin,
          origin,
          `${raw} (${why}) resolved off-origin as ${out}`,
        );
      }
    }
  });

  it('returns a resolved path, never an authority-shaped one', () => {
    // '//www.worldmonitor.app/x' is first-party and survives the origin
    // round-trip, so it is not rejected — but emitting it unresolved would pin
    // the click to www even for a worker running on a vertical, re-admitting
    // the origin coupling this function exists to remove.
    for (const { raw, expectedPath, why } of FIRST_PARTY_AUTHORITY_SHAPED) {
      const out = safePushClickUrl(raw, 'user_abc');
      assert.equal(out, expectedPath, `${raw} (${why}) must emit a resolved path`);
      for (const origin of SERVING_ORIGINS) {
        assert.equal(new URL(out, origin).origin, origin, `${out} must stay on the serving origin`);
      }
    }
  });

  it('falls back to the dashboard for missing input', () => {
    assert.equal(safePushClickUrl(''), '/');
    assert.equal(safePushClickUrl(undefined), '/');
    assert.equal(safePushClickUrl(null), '/');
    assert.equal(safePushClickUrl({ toString: () => 'https://example.com' }), '/');
  });

  it('falls back to the dashboard when the URL itself is unparseable', () => {
    // The cases above all short-circuit on the typeof guard and never reach
    // new URL(). These actually throw from it, even with a base supplied, so
    // they are what exercises the parse-failure branch.
    for (const { raw, why } of UNPARSEABLE) {
      assert.equal(safePushClickUrl(raw), '/', `must reject ${raw} (${why})`);
    }
  });

  it('does not treat lookalike hosts as first-party', () => {
    for (const { raw } of LOOKALIKE_HOSTS) {
      assert.equal(safePushClickUrl(raw), raw, `${raw} must stay absolute and off-origin`);
    }
  });
});

describe('safePushClickUrl — rejection logging', () => {
  let warnings;
  let originalWarn;

  beforeEach(() => {
    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
  });
  afterEach(() => { console.warn = originalWarn; });

  it('logs a rejection with the reason and the user, like its sibling guards', () => {
    // Every other outbound-URL guard in this file logs when it rejects
    // (Slack/Discord/webhook). This one was the only silent guard, so a false
    // positive or a bypass regression left no breadcrumb anywhere — it would
    // surface only as "push links stopped working".
    safePushClickUrl('javascript:alert(1)', 'user_abc');
    assert.equal(warnings.length, 1, 'a rejected scheme must be logged');
    assert.match(warnings[0], /push click URL rejected/i);
    assert.match(warnings[0], /user_abc/);
  });

  it('does not log the ordinary missing-url default', () => {
    // Every plain brief_ready push omits a link. Logging that would be noise,
    // not signal.
    safePushClickUrl(undefined, 'user_abc');
    safePushClickUrl('', 'user_abc');
    assert.deepEqual(warnings, []);
  });
});

describe('relay -> service worker contract', () => {
  it('sendWebPush routes its click URL through the guard', () => {
    const { readFileSync } = require('node:fs');
    const src = readFileSync(require.resolve('../scripts/notification-relay.cjs'), 'utf-8');
    const fn = src.match(/async function sendWebPush\([\s\S]+?\n\}/);
    assert.ok(fn, 'sendWebPush must exist');
    assert.match(fn[0], /url: safePushClickUrl\(payload\.url, userId\)/,
      'sendWebPush must sanitize the click URL for every call site');
  });

  it('the relay dashboard fallback reuses the open tab on every serving origin', async () => {
    // THE assertion whose absence let the regression ship. Each suite used to
    // assert against its own fixture origin and neither crossed the boundary,
    // so the relay and the worker could disagree in production while both
    // stayed green. This drives the real handler with the real relay output.
    for (const origin of SERVING_ORIGINS) {
      const relayOutput = safePushClickUrl(undefined, 'user_abc');
      const box = makeSwSandbox(origin);
      const client = addWindowClient(box);
      loadHandlerInto(box);
      await clickNotification(box, { url: relayOutput });
      assert.equal(box.opened, null, `must not open a second tab on ${origin}`);
      assert.equal(client.navigated, '/', `must reuse the open dashboard tab on ${origin}`);
    }
  });

  it('the shared absolute dashboard fallback still leaves the relay relative', () => {
    // formatEventLinkForPush falls back to the shared NOTIFY_DASHBOARD_URL,
    // an absolute apex URL; sendWebPush must strip its origin like any other.
    const { NOTIFY_DASHBOARD_URL } = require('../scripts/shared/notify-fields.cjs');
    assert.match(NOTIFY_DASHBOARD_URL, /^https:\/\//);
    assert.equal(safePushClickUrl(NOTIFY_DASHBOARD_URL, 'user_abc'), '/');
  });

  it('a relay-emitted article link still gets its own tab', async () => {
    const relayOutput = safePushClickUrl('https://reuters.com/world/story', 'user_abc');
    const box = makeSwSandbox();
    const client = addWindowClient(box);
    loadHandlerInto(box);
    await clickNotification(box, { url: relayOutput });
    assert.equal(client.navigated, null, 'the dashboard tab is never handed an article');
    assert.equal(box.opened, 'https://reuters.com/world/story');
  });

  it('a relay-emitted apex-exempt target keeps its apex through the worker', async () => {
    const relayOutput = safePushClickUrl('https://worldmonitor.app/oauth/register', 'user_abc');
    const box = makeSwSandbox();
    const client = addWindowClient(box);
    loadHandlerInto(box);
    await clickNotification(box, { url: relayOutput });
    assert.equal(client.navigated, null, 'must not be navigated onto the serving origin');
    assert.equal(box.opened, 'https://worldmonitor.app/oauth/register');
  });
});

describe('push path carries no origin literal', () => {
  // The published-corpus guard (tests/agent-corpus-canonical-host.test.mjs)
  // exists for exactly this bug class but scans only public/ text files, which
  // is why a literal in a .cjs script slipped past it. Widening that guard to
  // scripts/ is deferred: it would red 37 of 40 files, and only 9 occurrences
  // across 4 files are genuine — the rest are User-Agent strings, Origin and
  // HTTP-Referer headers, and CORS allowlist entries, which are byte-compared
  // identifiers of the same class the guard already exempts for OAuth issuers.
  // Separating those needs an exemption taxonomy that does not exist yet.
  //
  // So pin the push path narrowly instead. Scoped to the regions that build a
  // click URL, because the relay legitimately uses the apex elsewhere. Matching
  // a SCHEME-BEARING literal only, because the worker names both generic hosts
  // as bare hostnames by design — a bare-hostname ban would forbid in one place
  // what another requires.
  const ORIGIN_LITERAL = /https:\/\/(?:www\.)?worldmonitor\.app/;

  const relaySource = () => {
    const { readFileSync } = require('node:fs');
    return readFileSync(require.resolve('../scripts/notification-relay.cjs'), 'utf-8');
  };

  /** The push click-URL path is not contiguous — collect its regions by name. */
  function pushPathRegions(src) {
    const regions = {};
    const sanitizer = src.match(/function safePushClickUrl\([\s\S]+?\n\}/);
    assert.ok(sanitizer, 'safePushClickUrl must exist');
    regions.safePushClickUrl = sanitizer[0];

    const send = src.match(/async function sendWebPush\([\s\S]+?\n\}/);
    assert.ok(send, 'sendWebPush must exist');
    regions.sendWebPush = send[0];

    // Each call site plus the lines that BUILD its url. Windows are sliced by
    // line index rather than matched by a regex with a fixed-width prefix,
    // because adjacent windows overlap and a global regex silently skips the
    // overlap — which is how the first attempt at this found only 2 of 3.
    //
    // The window must reach BACKWARDS: the per-event fallback assigns
    // `const eventUrl = ...` on its own line above the call, so an
    // argument-object-only capture misses the exact line U2 fixed. Verified:
    // restoring the apex literal there left all 20 tests green.
    const lines = src.split('\n');
    const callLines = [];
    lines.forEach((line, i) => {
      // Skip the declaration — its body is already its own region above.
      if (/function sendWebPush\(/.test(line)) return;
      if (/sendWebPush\(/.test(line)) callLines.push(i);
    });
    assert.equal(callLines.length, 3, `expected exactly three sendWebPush call sites, saw ${callLines.length}`);
    callLines.forEach((idx, i) => {
      regions[`callSite${i + 1}`] = lines.slice(Math.max(0, idx - 10), idx + 12).join('\n');
    });
    return regions;
  }

  it('no region of the push click-URL path names an origin, except the parse base', () => {
    const src = relaySource();
    const regions = pushPathRegions(src);
    for (const [name, region] of Object.entries(regions)) {
      // The one allowed literal: a relative base is not a legal base, so the
      // sanitizer must keep one absolute origin to resolve against. It is
      // never returned.
      const withoutParseBase = region.replace(
        /const PUSH_PARSE_BASE = '[^']*';/,
        "const PUSH_PARSE_BASE = '<parse-base>';",
      );
      assert.doesNotMatch(
        withoutParseBase,
        ORIGIN_LITERAL,
        `${name} must not name an origin — emit a relative path instead`,
      );
    }
  });

  it('catches a literal reintroduced at any of the real removal sites', () => {
    // Poison the SOURCE and re-extract, rather than appending to an already
    // extracted region. The old form appended the literal and then asserted the
    // result contained it — true for any region, including an empty one, so it
    // proved nothing about region coverage. This form fails whenever a region
    // is missing or too narrow, which is the property being claimed.
    const src = relaySource();
    // The per-event call site's own `eventUrl` line is gone: main's
    // formatEventLinkForPush (#8414) now builds that URL, and its absolute
    // NOTIFY_DASHBOARD_URL fallback is relativized by safePushClickUrl inside
    // sendWebPush — pinned by the contract test above.
    const removalSites = [
      'url: PUSH_DASHBOARD_PATH,',
    ];
    for (const site of removalSites) {
      assert.ok(src.includes(site), `removal site must still exist in source: ${site}`);
      const poisonedSrc = src.replace(site, site.replace('PUSH_DASHBOARD_PATH', "'https://worldmonitor.app/'"));
      assert.notEqual(poisonedSrc, src, `poisoning must change the source for: ${site}`);

      const regions = pushPathRegions(poisonedSrc);
      const caught = Object.values(regions).some((region) => ORIGIN_LITERAL.test(
        region.replace(/const PUSH_PARSE_BASE = '[^']*';/, ''),
      ));
      assert.ok(caught, `a literal reintroduced at "${site}" must be inside a scanned region`);
    }
  });

  it('the service worker names no origin either', () => {
    const { readFileSync } = require('node:fs');
    const worker = readFileSync(require.resolve('../public/push-handler.js'), 'utf-8');
    // Comments legitimately quote hostile URLs to explain what the guards stop
    // (blob:https://www.worldmonitor.app/x, https://worldmonitor.app//evil.com).
    // The pin is about values the code can EMIT, so strip prose first.
    const code = worker
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(
      code,
      ORIGIN_LITERAL,
      'push-handler.js must match hosts by bare hostname, never a scheme-bearing origin',
    );
  });
});
