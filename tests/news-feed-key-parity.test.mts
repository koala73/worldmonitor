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

const __dirname = dirname(fileURLToPath(import.meta.url));

const CLIENT_FEEDS_PATH = resolve(__dirname, '../src/config/feeds.ts');
const SERVER_FEEDS_PATH = resolve(__dirname, '../server/worldmonitor/news/v1/_feeds.ts');

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
    knownGapsClientOnly: [
      // No tech-variant server buckets for these. Either add them
      // server-side with curated RSS sources, or drop the panels
      // client-side. Tracked in todos/257 item 9.
      'podcasts',
      'thinktanks',
    ],
  },
  { clientConst: 'FINANCE_FEEDS', serverKey: 'finance', knownGapsClientOnly: [] },
  { clientConst: 'COMMODITY_FEEDS', serverKey: 'commodity', knownGapsClientOnly: [] },
  // FULL_FEEDS / HAPPY_FEEDS / ENERGY_FEEDS aren't asserted yet —
  // those variants don't have a fully-aligned server bucket map at the
  // time this test was written. Add them as the server catches up.
];

// Strip line + block comments so natural-language words in JSDoc/inline
// notes can't masquerade as property keys.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// Extract a top-level const block by name. Returns the body between the
// outermost `{` and `}` so we can scan property keys safely.
function extractConstObjectBody(src: string, constName: string): string | null {
  const cleaned = stripComments(src);
  const re = new RegExp(`(?:export\\s+)?const\\s+${constName}\\b[^=]*=\\s*\\{`);
  const m = cleaned.match(re);
  if (!m || typeof m.index !== 'number') return null;
  const open = cleaned.indexOf('{', m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') {
      depth--;
      if (depth === 0) return cleaned.slice(open + 1, i);
    }
  }
  return null;
}

// Extract the inner body for a named property of `VARIANT_FEEDS` whose
// value is an object literal: `<variantKey>: { ... }`.
function extractVariantBlock(src: string, variantKey: string): string | null {
  const cleaned = stripComments(src);
  // Match either bare or quoted variant key, but only at top of a line so
  // we don't catch e.g. a comment-stripped sentence ending in `<word>: {`.
  const re = new RegExp(`(?:^|\\n)\\s+(?:'${variantKey}'|"${variantKey}"|${variantKey})\\s*:\\s*\\{`, 'm');
  const m = cleaned.match(re);
  if (!m || typeof m.index !== 'number') return null;
  const open = cleaned.indexOf('{', m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') {
      depth--;
      if (depth === 0) return cleaned.slice(open + 1, i);
    }
  }
  return null;
}

// Pull category keys out of a variant body. We only count properties
// whose VALUE is an array literal (`<key>: [`). That excludes nested
// objects and natural-language text that happens to contain a colon.
// Both bare identifiers and quoted (kebab-case) keys are accepted.
//
// Brace-depth tracking: a key only counts when found at depth 0 of the
// passed body. Otherwise a future feed entry shaped like
// `{ name: '...', tags: ['a', 'b'] }` would emit a spurious `tags` key
// for the test. The current feed maps use flat single-line objects so
// this isn't observable yet, but the guard means the parity guard
// stays correct under reasonable future formatting.
function extractCategoryKeys(body: string): string[] {
  const keys: string[] = [];
  // Anchor: <leading-ws><key>: [   where <key> is either a bare
  // identifier or a single/double-quoted string.
  const KEY_RE = /[ \t]+(?:'([^']+)'|"([^"]+)"|([a-zA-Z_$][a-zA-Z0-9_$]*))\s*:\s*\[/y;
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? '';
    // Crude string skip — string literals can contain `{` / `}` / `:` which would
    // otherwise corrupt depth tracking. We don't need full template-literal
    // expression handling because feed map values never contain ${...}.
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch as '"' | "'" | '`';
      continue;
    }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') { depth--; continue; }
    if (depth !== 0) continue;
    if (ch !== '\n') continue;
    KEY_RE.lastIndex = i + 1;
    const m = KEY_RE.exec(body);
    if (m) {
      const key = m[1] ?? m[2] ?? m[3];
      if (key) keys.push(key);
    }
  }
  return keys;
}

describe('news feed key parity (client FEEDS ⇔ server VARIANT_FEEDS)', () => {
  const clientSrc = readFileSync(CLIENT_FEEDS_PATH, 'utf-8');
  const serverSrc = readFileSync(SERVER_FEEDS_PATH, 'utf-8');

  for (const { clientConst, serverKey, knownGapsClientOnly } of VARIANTS) {
    test(`${serverKey}: every client key has a matching server key`, () => {
      const clientBody = extractConstObjectBody(clientSrc, clientConst);
      assert.ok(clientBody, `failed to locate const ${clientConst} in client feeds.ts`);

      const serverBody = extractVariantBlock(serverSrc, serverKey);
      assert.ok(serverBody, `failed to locate VARIANT_FEEDS.${serverKey} in server _feeds.ts`);

      const clientKeys = new Set(extractCategoryKeys(clientBody));
      const serverKeys = new Set(extractCategoryKeys(serverBody));
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

  // Every client-side variant feed map. CANONICAL_FEEDS is their union.
  const ALL_FEED_CONSTS = [
    'FULL_FEEDS',
    'TECH_FEEDS',
    'FINANCE_FEEDS',
    'COMMODITY_FEEDS',
    'ENERGY_FEEDS',
    'HAPPY_FEEDS',
  ];

  test('every createNewsPanel(...) key resolves to feeds in CANONICAL_FEEDS', () => {
    const clientSrc = readFileSync(CLIENT_FEEDS_PATH, 'utf-8');
    // NB: do NOT run stripComments() on panel-layout.ts — unlike the pure-data
    // feed maps, it contains regex literals (e.g. /-([a-z])/g) that the naive
    // block-comment regex would mangle. The createNewsPanel('X') call shape is
    // distinctive enough to match safely on raw source.
    const panelLayoutSrc = readFileSync(PANEL_LAYOUT_PATH, 'utf-8');

    const canonicalKeys = new Set<string>();
    for (const constName of ALL_FEED_CONSTS) {
      const body = extractConstObjectBody(clientSrc, constName);
      assert.ok(body, `failed to locate const ${constName} in feeds.ts`);
      for (const k of extractCategoryKeys(body)) canonicalKeys.add(k);
    }
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
