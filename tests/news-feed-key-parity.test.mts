// Static parity guard: client-side `FEEDS` category keys MUST match
// server-side `VARIANT_FEEDS` keys for each variant.
//
// Background — concrete regression that motivated this test:
//
// The finance-variant Financial Regulation panel rendered empty for
// every user (anon AND pro) because the client used category key
// `'fin-regulation'` (in `src/config/feeds.ts` FINANCE_FEEDS, mirrored
// by the panel config in `src/config/panels.ts` and a one-time storage
// migration in `src/App.ts`) while the server still emitted the digest
// bucket under key `'regulation'`. The client iterates
// `Object.keys(FEEDS)` and does `digest.categories[category]`, so a
// rename on one side without the other means the panel never finds its
// items, the per-feed RSS fallback is gated off on web, and the body
// renders `[]` → "No news available" + UNAVAILABLE pill.
//
// This guard locks the per-variant key set so any future drift fails
// CI before reaching production.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NEWS_CATALOG } from '../shared/news-catalog.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));


// Map client const names to the variant string used by the server.
// The runtime selector in src/config/feeds.ts:927-937 routes
// SITE_VARIANT === 'X' → X_FEEDS for each X in this list.
//
// `knownGapsClientOnly` is a documented allowlist of category keys
// that exist client-side but have no server bucket today. Listed
// keys still render empty / "UNAVAILABLE" on web — they're tracked
// as deferred follow-ups (todos/257 item 9), not silent drift. Any
// client key NOT in this allowlist must have a server match.
const VARIANTS: Array<{ clientConst: string; serverKey: string; knownGapsClientOnly: string[] }> = [
  {
    clientConst: 'TECH_FEEDS',
    serverKey: 'tech',
    knownGapsClientOnly: [],
  },
  { clientConst: 'FINANCE_FEEDS', serverKey: 'finance', knownGapsClientOnly: [] },
  { clientConst: 'COMMODITY_FEEDS', serverKey: 'commodity', knownGapsClientOnly: [] },
  // FULL_FEEDS / HAPPY_FEEDS / ENERGY_FEEDS aren't asserted yet —
  // those variants don't have a fully-aligned server bucket map at the
  // time this test was written. Add them as the server catches up.
];

// Category layout per edition, read from the one catalog.
const LAYOUT = NEWS_CATALOG.layout;

describe('news feed key parity (client FEEDS ⇔ server VARIANT_FEEDS)', () => {
  for (const { clientConst, serverKey, knownGapsClientOnly } of VARIANTS) {
    test(`${serverKey}: every client key has a matching server key`, () => {
      const clientKeys = new Set(LAYOUT.browser[serverKey] ?? []);
      const serverKeys = new Set(LAYOUT.server[serverKey] ?? []);
      assert.ok(clientKeys.size > 0, `client ${clientConst} parsed 0 keys`);
      assert.ok(serverKeys.size > 0, `server VARIANT_FEEDS.${serverKey} parsed 0 keys`);

      const known = new Set(knownGapsClientOnly);
      const orphans = [...clientKeys]
        .filter(k => !serverKeys.has(k) && !known.has(k))
        .sort();
      assert.deepStrictEqual(
        orphans,
        [],
        `Client category keys missing on the server for variant '${serverKey}'.\n` +
        `These categories will render empty + 'UNAVAILABLE' on the panel because the\n` +
        `client looks up digest.categories[<key>] and the server emits a different key.\n\n` +
        `Missing on server: ${orphans.join(', ')}\n\n` +
        `Fix: rename the server-side key in server/worldmonitor/news/v1/_feeds.ts under\n` +
        `VARIANT_FEEDS.${serverKey} to match the client. (Or add the key to\n` +
        `\`knownGapsClientOnly\` in this test if the gap is intentional and tracked.)`,
      );

      // Sanity: every key in knownGapsClientOnly must actually be a real
      // gap. If a future server change covers one, drop it from the
      // allowlist so we don't carry phantom entries forever.
      const staleListed = knownGapsClientOnly.filter(k => serverKeys.has(k));
      assert.deepStrictEqual(
        staleListed,
        [],
        `'${serverKey}' knownGapsClientOnly contains keys the server NOW covers: ` +
        `${staleListed.join(', ')}. Remove them from the allowlist so future drift can be detected.`,
      );

      // Sanity: every key in knownGapsClientOnly must still exist on the
      // client. If it was renamed/dropped, the allowlist entry is stale.
      const goneFromClient = knownGapsClientOnly.filter(k => !clientKeys.has(k));
      assert.deepStrictEqual(
        goneFromClient,
        [],
        `'${serverKey}' knownGapsClientOnly contains keys no longer in the client: ` +
        `${goneFromClient.join(', ')}. Remove them from the allowlist.`,
      );
    });
  }
});

// Static guard: every news panel the UI can create MUST have a feed
// definition somewhere in feeds.ts — otherwise enabling it (in its own
// variant OR customized into another variant) leaves it stuck on
// "Loading..." forever, because loadNews()/panel-layout resolve feeds from
// CANONICAL_FEEDS (the union of every variant's *_FEEDS map).
//
// Regression motivated this: 14 Tech news panels (startups, github, …) were
// reachable via the settings picker in the `full` variant but had no
// FULL_FEEDS category, so they never loaded. The fix made the data layer
// panel-driven; this guard locks the invariant.
describe('news panel ↔ feed coverage (panel-layout createNewsPanel ⇔ feeds.ts)', () => {
  const PANEL_LAYOUT_PATH = resolve(__dirname, '../src/app/panel-layout.ts');

  // News panels intentionally NOT backed by a *_FEEDS category — they have a
  // dedicated loader path in data-loader.ts instead. Keep this list tight.
  const SPECIAL_CASED = new Set<string>([
    'intel', // INTEL_SOURCES + bespoke branch in DataLoader.loadNews()
  ]);

  // CANONICAL_FEEDS is the union of every edition's browser categories,
  // including the on-demand edition (nq-news).
  test('every createNewsPanel(...) key resolves to feeds in CANONICAL_FEEDS', () => {
    // NB: do NOT run stripComments() on panel-layout.ts — unlike the pure-data
    // feed maps, it contains regex literals (e.g. /-([a-z])/g) that the naive
    // block-comment regex would mangle. The createNewsPanel('X') call shape is
    // distinctive enough to match safely on raw source.
    const panelLayoutSrc = readFileSync(PANEL_LAYOUT_PATH, 'utf-8');

    const canonicalKeys = new Set<string>(Object.values(LAYOUT.browser).flat());
    assert.ok(canonicalKeys.size > 0, 'parsed 0 canonical feed keys');

    const createNewsPanelKeys = new Set<string>();
    const re = /createNewsPanel\(\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(panelLayoutSrc)) !== null) {
      if (m[1]) createNewsPanelKeys.add(m[1]);
    }
    assert.ok(createNewsPanelKeys.size > 0, 'parsed 0 createNewsPanel keys from panel-layout.ts');

    const orphans = [...createNewsPanelKeys]
      .filter(k => !canonicalKeys.has(k) && !SPECIAL_CASED.has(k))
      .sort();
    assert.deepStrictEqual(
      orphans,
      [],
      `News panels created by panel-layout.ts with NO feed definition in any ` +
      `*_FEEDS map:\n\n  ${orphans.join(', ')}\n\n` +
      `These panels can be enabled via the settings picker but will sit on ` +
      `"Loading..." forever — loadNews() resolves feeds from CANONICAL_FEEDS ` +
      `(the union of all *_FEEDS maps) and finds nothing.\n\n` +
      `Fix: add the category to the relevant *_FEEDS map in src/config/feeds.ts, ` +
      `or add it to SPECIAL_CASED in this test if it has a dedicated loader.`,
    );
  });
});
