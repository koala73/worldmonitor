import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const panelLayoutSrc = readFileSync(resolve(__dirname, '../src/app/panel-layout.ts'), 'utf-8');
const panelsSrc = readFileSync(resolve(__dirname, '../src/config/panels.ts'), 'utf-8');
const commandsSrc = readFileSync(resolve(__dirname, '../src/config/commands.ts'), 'utf-8');

const VARIANT_FILES = ['full', 'tech', 'finance', 'commodity', 'energy', 'happy', 'usachina'];

// Depth-aware extraction of the TOP-LEVEL keys of a `const X_PANELS = { ... }`
// object literal — i.e. the panel ids, not nested config keys like
// `defaultLayout`. Brace-walks the block so nested objects never leak in.
function topLevelPanelIds(variant) {
  const tag = variant.toUpperCase() + '_PANELS';
  const m = panelsSrc.match(new RegExp(`const ${tag}[^{]*\\{`));
  if (!m) return [];
  const open = panelsSrc.indexOf('{', m.index);
  let depth = 0, end = open;
  for (let i = open; i < panelsSrc.length; i++) {
    const c = panelsSrc[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = panelsSrc.slice(open + 1, end);
  const depthAt = new Array(body.length).fill(0);
  let cur = 0;
  for (let i = 0; i < body.length; i++) { depthAt[i] = cur; if (body[i] === '{') cur++; else if (body[i] === '}') cur--; }
  const ids = new Set();
  const keyRe = /['"]?([a-zA-Z0-9_-]+)['"]?\s*:\s*\{/g;
  let mm;
  while ((mm = keyRe.exec(body))) { if (depthAt[mm.index] === 0) ids.add(mm[1]); }
  return [...ids];
}

function allRegistryPanelIds() {
  const ids = new Set();
  for (const v of VARIANT_FILES) for (const id of topLevelPanelIds(v)) ids.add(id);
  return ids;
}

// Parses commands.ts `panel:<id>` commands → Map<id, keywordCount>.
// Line-based on purpose: commands are one-per-line (biome-enforced) and `id`
// always precedes `keywords`. An object-literal matcher can't be used here —
// the `icon: '\u{...}'` escapes contain literal braces, which would break any
// `{...}` brace-walk. The "non-empty sets" test below catches catastrophic
// regex drift if this convention ever changes.
function panelCommandKeywordCounts() {
  const out = new Map();
  const re = /id:\s*'panel:([a-zA-Z0-9_-]+)'[^\n]*?keywords:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(commandsSrc))) {
    out.set(m[1], m[2].split(',').filter((s) => s.trim().length > 0).length);
  }
  return out;
}

// Collects every panelKey listed anywhere in PANEL_CATEGORY_MAP.
// Brace-walks from the map's opening `{` to its matching `}` (same robust
// approach as topLevelPanelIds) rather than a `\n};` end-sentinel, which would
// silently truncate if a later const reused that closing pattern.
function categoryMappedPanelIds() {
  const decl = panelsSrc.indexOf('PANEL_CATEGORY_MAP');
  // Anchor on the assignment `= {`, not the first `{` — the type annotation
  // `Record<string, { labelKey... }>` contains braces ahead of the value.
  const open = panelsSrc.indexOf('{', panelsSrc.indexOf('= {', decl));
  let depth = 0, end = open;
  for (let i = open; i < panelsSrc.length; i++) {
    const c = panelsSrc[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = panelsSrc.slice(open + 1, end);
  const ids = new Set();
  for (const block of body.matchAll(/panelKeys\s*:\s*\[([^\]]*)\]/g)) {
    for (const tok of block[1].split(',')) {
      const t = tok.trim().replace(/['"]/g, '');
      if (t) ids.add(t);
    }
  }
  return ids;
}

function parsePanelKeys(variant) {
  const src = readFileSync(resolve(__dirname, '../src/config/panels.ts'), 'utf-8');
  const tag = variant.toUpperCase() + '_PANELS';
  const start = src.indexOf(`const ${tag}`);
  if (start === -1) return [];
  const block = src.slice(start, src.indexOf('};', start) + 2);
  const keys = [];
  for (const m of block.matchAll(/(?:['"]([^'"]+)['"]|(\w[\w-]*))\s*:/g)) {
    const key = m[1] || m[2];
    if (key && !['name', 'enabled', 'priority', 'string', 'PanelConfig', 'Record'].includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

describe('panel-config guardrails', () => {
  it('every variant config includes "map"', () => {
    for (const v of VARIANT_FILES) {
      const keys = parsePanelKeys(v);
      assert.ok(keys.includes('map'), `${v} variant missing "map" panel`);
    }
  });

  it('no unguarded direct this.ctx.panels[...] = assignments in createPanels()', () => {
    const lines = panelLayoutSrc.split('\n');
    const violations = [];

    const allowedContexts = [
      /this\.ctx\.panels\[key\]\s*=/,             // createPanel helper
      /this\.ctx\.panels\['deduction'\]/,          // async-mounted PRO panel — gated via WEB_PREMIUM_PANELS
      /this\.ctx\.panels\['regional-intelligence'\]/, // async-mounted PRO panel — gated via WEB_PREMIUM_PANELS
      /this\.ctx\.panels\['runtime-config'\]/,     // desktop-only, intentionally ungated
      /this\.ctx\.panels\['live-news'\]/,          // mountLiveNewsIfReady — has its own channel guard
      /panel as unknown as/,                       // lazyPanel generic cast
      /this\.ctx\.panels\[panelKey\]\s*=/,         // FEEDS loop (guarded by DEFAULT_PANELS check)
      /this\.ctx\.panels\[spec\.id\]\s*=/,         // custom widgets (cw- prefix, always enabled)
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('this.ctx.panels[') || !line.includes('=')) continue;
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      if (!line.match(/this\.ctx\.panels\[.+\]\s*=/)) continue;
      if (allowedContexts.some(p => p.test(line))) continue;

      const preceding20 = lines.slice(Math.max(0, i - 20), i).join('\n');
      const isGuarded =
        preceding20.includes('shouldCreatePanel') ||
        preceding20.includes('createPanel') ||
        preceding20.includes('createNewsPanel');
      if (isGuarded) continue;

      violations.push({ line: i + 1, text: line.trim() });
    }

    assert.deepStrictEqual(
      violations,
      [],
      `Found unguarded panel assignments that bypass createPanel/shouldCreatePanel guards:\n` +
      violations.map(v => `  L${v.line}: ${v.text}`).join('\n') +
      `\n\nUse this.createPanel(), this.createNewsPanel(), or wrap with shouldCreatePanel().`
    );
  });

  it('reapplies panel settings after mounting the async deduction panel', () => {
    const deductionMount = panelLayoutSrc.match(
      /import\('@\/components\/DeductionPanel'\)\.then\(\(\{ DeductionPanel \}\) => \{([\s\S]*?)\n\s*\}\);/
    );

    assert.ok(deductionMount, 'expected async DeductionPanel mount block in panel-layout.ts');
    assert.match(
      deductionMount[1],
      /this\.applyPanelSettings\(\);/,
      'async DeductionPanel mount must replay saved panel settings after insertion',
    );
  });

  it('premium gating stays unconditional (AALICE:OpenEYE has no tier)', () => {
    // Replaces the upstream "anon lock-CTA invariant" guard, which checked
    // that every API-key-entitled panel also appeared in WEB_PREMIUM_PANELS
    // so anonymous/free web users got a "Sign In to Unlock" CTA instead of a
    // half-rendered panel.
    //
    // This fork has no anonymous tier, no subscription and no Convex
    // entitlement snapshot, so that invariant is not just unnecessary — the
    // lists it compared no longer exist. What IS worth guarding is the
    // replacement: the four choke points must stay unconditional, because
    // re-introducing a condition in any one of them silently restores a
    // paywall across ~40 downstream call sites that never mention "pro".
    const gatingSrc = readFileSync(
      resolve(__dirname, '../src/services/panel-gating.ts'), 'utf-8');
    const entitlementsSrc = readFileSync(
      resolve(__dirname, '../src/services/entitlements.ts'), 'utf-8');
    const widgetStoreSrc = readFileSync(
      resolve(__dirname, '../src/services/widget-store.ts'), 'utf-8');

    const unconditional = [
      ['hasPremiumAccess', gatingSrc,
       /export function hasPremiumAccess\([^)]*\): boolean \{\s*return true;\s*\}/],
      ['isEntitled', entitlementsSrc,
       /export function isEntitled\(\): boolean \{\s*return true;\s*\}/],
      ['hasSelfHostUnlock', widgetStoreSrc,
       /function hasSelfHostUnlock\(\): boolean \{\s*return true;\s*\}/],
      ['isPanelEntitled', panelsSrc,
       /export function isPanelEntitled\([\s\S]*?\): boolean \{[\s\S]*?return true;\s*\}/],
    ];

    for (const [name, src, re] of unconditional) {
      assert.ok(
        re.test(src),
        `${name}() must return true unconditionally on this fork. ` +
        'Re-adding a condition here restores the Pro paywall app-wide.',
      );
    }

    // And the upsell chrome must stay gone.
    assert.ok(
      !panelLayoutSrc.includes('WEB_CLERK_PRO_ONLY_PANELS'),
      'WEB_CLERK_PRO_ONLY_PANELS re-gates panels past hasPremiumAccess() — keep it removed.',
    );
  });

  it('panel keys are consistent across variant configs (no typos)', () => {
    const allKeys = new Map();
    for (const v of VARIANT_FILES) {
      for (const key of parsePanelKeys(v)) {
        if (!allKeys.has(key)) allKeys.set(key, []);
        allKeys.get(key).push(v);
      }
    }

    const keys = [...allKeys.keys()];
    const allowedPairs = new Set([
      'ai-regulation|fin-regulation',
      'fin-regulation|ai-regulation',
    ]);
    const typos = [];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const minLen = Math.min(keys[i].length, keys[j].length);
        if (minLen < 5) continue;
        if (levenshtein(keys[i], keys[j]) <= 2 && keys[i] !== keys[j] && !allowedPairs.has(`${keys[i]}|${keys[j]}`)) {
          typos.push(`"${keys[i]}" ↔ "${keys[j]}"`);
        }
      }
    }
    assert.deepStrictEqual(typos, [], `Possible panel key typos: ${typos.join(', ')}`);
  });

  // ── Discoverability parity ─────────────────────────────────────────────
  // A registered panel a user cannot reach is dead weight. Every panel must
  // be (a) reachable by CMD+K (has a `panel:<id>` command with enough
  // keywords to actually match a query) and (b) browsable (categorized).
  // These guards exist because oil-inventories + 33 other panels had drifted
  // out of PANEL_CATEGORY_MAP and 5 had no command at all — the data was in
  // the API but undiscoverable in the UI.

  it('parsers resolve non-empty sets (guards against silent regex drift)', () => {
    assert.ok(allRegistryPanelIds().size > 50, `registry parse returned ${allRegistryPanelIds().size} panels — regex likely broke`);
    assert.ok(panelCommandKeywordCounts().size > 50, `command parse returned ${panelCommandKeywordCounts().size} commands — regex likely broke`);
    assert.ok(categoryMappedPanelIds().size > 50, `category parse returned ${categoryMappedPanelIds().size} keys — regex likely broke`);
  });

  it('every registered panel has a CMD+K command (discoverable by search)', () => {
    const panels = allRegistryPanelIds();
    const commands = panelCommandKeywordCounts();
    const missing = [...panels].filter((id) => !commands.has(id)).sort();
    assert.deepStrictEqual(
      missing,
      [],
      `Panels with no panel:<id> command in src/config/commands.ts — they can never appear in CMD+K:\n  ${missing.join(', ')}\n` +
      `Add a { id: 'panel:<id>', keywords: [...], label, icon, category: 'panels' } entry for each.`,
    );
  });

  it('every registered panel is categorized in PANEL_CATEGORY_MAP (browsable)', () => {
    const panels = allRegistryPanelIds();
    const categorized = categoryMappedPanelIds();
    const missing = [...panels].filter((id) => !categorized.has(id)).sort();
    assert.deepStrictEqual(
      missing,
      [],
      `Panels missing from PANEL_CATEGORY_MAP — no browse path exists for them:\n  ${missing.join(', ')}\n` +
      `Add each to an appropriate category's panelKeys in src/config/panels.ts.`,
    );
  });

  it('every panel command carries >=3 keywords (thin keywords fail to match real queries)', () => {
    const commands = panelCommandKeywordCounts();
    const thin = [...commands.entries()].filter(([, n]) => n < 3).map(([id, n]) => `${id}(${n})`).sort();
    assert.deepStrictEqual(
      thin,
      [],
      `panel:<id> commands with fewer than 3 keywords — too thin for reliable CMD+K discovery:\n  ${thin.join(', ')}\n` +
      `Add synonyms/related terms (e.g. demonyms, acronyms) to each command's keywords array.`,
    );
  });

  it("every category:'panels' command uses the panel:<id> prefix (else handleCommand dead-clicks)", () => {
    // search-manager.ts handleCommand splits on the first ':' and returns
    // early when there is none — so a `category: 'panels'` command whose id
    // lacks the `panel:` prefix can never route to scrollToPanel/enablePanel.
    // It renders in CMD+K but does nothing on select (the maritime-activity
    // orphan that motivated this guard).
    // Line-based for the same reason as panelCommandKeywordCounts (brace-laden
    // icon escapes preclude an object-literal matcher); commands are one-per-line.
    const offenders = [];
    const re = /\{\s*id:\s*'([^']+)'[^\n]*category:\s*'panels'/g;
    let m;
    while ((m = re.exec(commandsSrc))) {
      if (!m[1].startsWith('panel:')) offenders.push(m[1]);
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `Commands tagged category:'panels' but missing the 'panel:' prefix — they dead-click in CMD+K:\n  ${offenders.join(', ')}\n` +
      `Prefix the id with 'panel:' (and ensure the panel exists) or remove the command.`,
    );
  });

  it('no stale panel command or category entry references a non-existent panel', () => {
    const panels = allRegistryPanelIds();
    const staleCommands = [...panelCommandKeywordCounts().keys()].filter((id) => !panels.has(id)).sort();
    const staleCategory = [...categoryMappedPanelIds()].filter((id) => !panels.has(id)).sort();
    assert.deepStrictEqual(
      { staleCommands, staleCategory },
      { staleCommands: [], staleCategory: [] },
      `Dead references to panels that no longer exist in the registry.\n` +
      `  Stale panel:<id> commands (remove from commands.ts): ${staleCommands.join(', ') || '—'}\n` +
      `  Stale PANEL_CATEGORY_MAP panelKeys (remove from panels.ts): ${staleCategory.join(', ') || '—'}`,
    );
  });

  // Guards the convention that App.ts isDynamicPanel() relies on: the `cw-`
  // (custom widget) and `mcp-` prefixes are reserved for runtime-created,
  // user-owned panels. A *registered* built-in using either prefix would be
  // misclassified as dynamic — surviving variant resets it should undergo and
  // dodging enforceFreeTierLimits gating. The ALL_PANELS membership check in
  // isDynamicPanel handles the collision at runtime; this locks the invariant
  // at its source so a mis-prefixed registration fails CI instead.
  it('no registered panel uses a reserved dynamic-panel prefix (cw-/mcp-)', () => {
    const collisions = [...allRegistryPanelIds()]
      .filter((id) => id.startsWith('cw-') || id.startsWith('mcp-'))
      .sort();
    assert.deepStrictEqual(
      collisions,
      [],
      `Registered built-in panels using a reserved dynamic-panel prefix:\n  ${collisions.join(', ')}\n` +
      `App.ts isDynamicPanel() treats cw-/mcp- keys as user-created widgets. A built-in with this\n` +
      `prefix would be skipped on variant switches and bypass free-tier gating. Rename to a\n` +
      `non-reserved prefix.`,
    );
  });
});

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
