import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const panelLayoutSrc = readFileSync(resolve(__dirname, '../src/app/panel-layout.ts'), 'utf-8');
const panelsSrc = readFileSync(resolve(__dirname, '../src/config/panels.ts'), 'utf-8');
const commandsSrc = readFileSync(resolve(__dirname, '../src/config/commands.ts'), 'utf-8');

const VARIANT_FILES = ['full', 'tech', 'finance', 'commodity', 'energy', 'happy'];
const PANEL_WIDE_CLASS_RE = /className:\s*['"][^'"]*\bpanel-wide\b/;
const COMPONENT_SOURCE_RE = /\.tsx?$/;

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

// Characters after which a `/` begins a regex literal rather than division.
// In object-literal / call-argument contexts (all we parse here) a regex value
// always follows one of these, so the heuristic is reliable for super(...) bodies.
const REGEX_START_PREFIX = new Set([undefined, '(', ',', ';', ':', '=', '!', '&', '|', '?', '{', '}', '[', '+', '-', '*', '%', '<', '>', '~', '^']);

function findMatchingBrace(src, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let inRegex = false;
  let regexClass = false;
  // Last non-whitespace code character, used to disambiguate `/` (regex vs divide).
  let prevSignificant;

  for (let i = openIndex; i < src.length; i++) {
    const char = src[i];
    const next = src[i + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (inRegex) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '[') regexClass = true;
      else if (char === ']') regexClass = false;
      else if (char === '/' && !regexClass) inRegex = false;
      else if (char === '\n') inRegex = false; // unterminated literal; bail out
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (char === '/' && REGEX_START_PREFIX.has(prevSignificant)) {
      inRegex = true;
      regexClass = false;
      prevSignificant = '/';
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      prevSignificant = char;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return i;
    }
    if (!/\s/.test(char)) prevSignificant = char;
  }
  return -1;
}

function staticStringLiteralValue(rawValue) {
  const value = rawValue.trim();
  if (value.length < 2) return null;
  const quote = value[0];
  if ((quote === '\'' || quote === '"') && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  if (quote === '`' && value.endsWith('`') && !value.includes('${')) {
    return value.slice(1, -1);
  }
  return null;
}

function superObjectBodies(src) {
  const bodies = [];
  let searchIndex = 0;
  while (searchIndex < src.length) {
    const superIndex = src.indexOf('super(', searchIndex);
    if (superIndex === -1) break;
    const open = src.indexOf('{', superIndex);
    const closeParen = src.indexOf(')', superIndex);
    if (open === -1 || (closeParen !== -1 && closeParen < open)) {
      searchIndex = superIndex + 'super('.length;
      continue;
    }
    const close = findMatchingBrace(src, open);
    if (close === -1) {
      searchIndex = open + 1;
      continue;
    }
    bodies.push(src.slice(open + 1, close));
    searchIndex = close + 1;
  }
  return bodies;
}

function naturalDeferredPanelFootprints() {
  const componentsDir = resolve(__dirname, '../src/components');
  const footprints = new Map();
  for (const file of readdirSync(componentsDir)) {
    if (!COMPONENT_SOURCE_RE.test(file) || file.endsWith('.d.ts')) continue;
    const src = readFileSync(resolve(componentsDir, file), 'utf-8');
    for (const body of superObjectBodies(src)) {
      const id = body.match(/id:\s*['"]([^'"]+)['"]/);
      if (!id) continue;
      const classNameRaw = body.match(/className:\s*([^,\n}]+)/);
      let panelWide = false;
      let unverifiableClassName = null;
      if (classNameRaw) {
        const classNameValue = staticStringLiteralValue(classNameRaw[1]);
        if (classNameValue === null) {
          unverifiableClassName = classNameRaw[1].trim();
        } else {
          panelWide = /\bpanel-wide\b/.test(classNameValue);
        }
      }

      // Capture the raw defaultRowSpan value so a non-literal (variable or
      // expression) is reported as unverifiable rather than silently dropped —
      // otherwise its footprint would escape this guard and reintroduce CLS.
      const rowSpanRaw = body.match(/defaultRowSpan:\s*([^,\n}]+)/);
      let rowSpan = null;
      let unverifiableRowSpan = null;
      if (rowSpanRaw) {
        const value = rowSpanRaw[1].trim();
        if (/^[2-4]$/.test(value)) rowSpan = value;
        else if (value !== '1') unverifiableRowSpan = value;
      }

      if (!rowSpan && !panelWide && !unverifiableRowSpan && !unverifiableClassName) continue;
      footprints.set(id[1], { file, rowSpan, panelWide, unverifiableRowSpan, unverifiableClassName });
    }
  }
  return footprints;
}

function deferredPanelFootprintRegistryEntries() {
  const decl = panelLayoutSrc.indexOf('DEFERRED_PANEL_NATURAL_FOOTPRINTS');
  assert.notEqual(decl, -1, 'DEFERRED_PANEL_NATURAL_FOOTPRINTS registry not found');
  const open = panelLayoutSrc.indexOf('{', panelLayoutSrc.indexOf('= {', decl));
  const close = findMatchingBrace(panelLayoutSrc, open);
  assert.ok(open !== -1 && close !== -1, 'DEFERRED_PANEL_NATURAL_FOOTPRINTS body not found');
  const body = panelLayoutSrc.slice(open + 1, close);
  const entries = new Map();
  const entryRe = /(?:['"]([^'"]+)['"]|([a-zA-Z0-9_-]+))\s*:\s*\{/g;
  let match;
  while ((match = entryRe.exec(body))) {
    const key = match[1] || match[2];
    const entryOpen = body.indexOf('{', match.index);
    const entryClose = findMatchingBrace(body, entryOpen);
    assert.ok(entryClose !== -1, 'unclosed deferred footprint entry for ' + key);
    entries.set(key, body.slice(entryOpen + 1, entryClose));
    entryRe.lastIndex = entryClose + 1;
  }
  return entries;
}


function deferredDynamicPanelFootprintRegistryEntries() {
  const decl = panelLayoutSrc.indexOf('DEFERRED_DYNAMIC_PANEL_FOOTPRINTS');
  assert.notEqual(decl, -1, 'DEFERRED_DYNAMIC_PANEL_FOOTPRINTS registry not found');
  const open = panelLayoutSrc.indexOf('{', panelLayoutSrc.indexOf('= {', decl));
  const close = findMatchingBrace(panelLayoutSrc, open);
  assert.ok(open !== -1 && close !== -1, 'DEFERRED_DYNAMIC_PANEL_FOOTPRINTS body not found');
  const body = panelLayoutSrc.slice(open + 1, close);
  const entries = new Map();
  const entryRe = /(?:['"]([^'"]+)['"]|([a-zA-Z0-9_-]+))\s*:\s*\{/g;
  let match;
  while ((match = entryRe.exec(body))) {
    const key = match[1] || match[2];
    const entryOpen = body.indexOf('{', match.index);
    const entryClose = findMatchingBrace(body, entryOpen);
    assert.ok(entryClose !== -1, 'unclosed dynamic deferred footprint entry for ' + key);
    entries.set(key, body.slice(entryOpen + 1, entryClose));
    entryRe.lastIndex = entryClose + 1;
  }
  return entries;
}

function dynamicConstructorRowSpan(file, className) {
  const src = readFileSync(resolve(__dirname, '../src/components', file), 'utf-8');
  for (const body of superObjectBodies(src)) {
    const classNameRaw = body.match(/className:\s*([^,\n}]+)/);
    if (!classNameRaw) continue;
    const classNameValue = staticStringLiteralValue(classNameRaw[1]);
    if (!classNameValue?.split(/\s+/).includes(className)) continue;
    const rowSpanRaw = body.match(/defaultRowSpan:\s*([^,\n}]+)/);
    if (!rowSpanRaw) return undefined;
    const value = rowSpanRaw[1].trim();
    return /^\d+$/.test(value) ? Number(value) : undefined;
  }
  return undefined;
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
    assert.match(
      panelLayoutSrc,
      /this\.lazyPanel\('deduction',\s*\(\)\s*=>\s*\n?\s*this\.importPanel\([\s\S]*?'@\/components\/DeductionPanel'[\s\S]*?new DeductionPanel\(\(\) => this\.ctx\.allNews\)/,
      'expected DeductionPanel to be registered through the lazy panel loader',
    );

    const mountLazyPanel = panelLayoutSrc.match(
      /private mountLazyPanel\([\s\S]*?\n\s*\}/
    );
    assert.ok(mountLazyPanel, 'expected mountLazyPanel helper in panel-layout.ts');
    assert.match(
      mountLazyPanel[0],
      /this\.afterPanelMounted\(key, panel\);/,
      'lazy panel mounts must run afterPanelMounted so saved settings and hydration replay apply',
    );

    const afterPanelMounted = panelLayoutSrc.match(
      /private afterPanelMounted\([\s\S]*?\n\s*\}/
    );
    assert.ok(afterPanelMounted, 'expected afterPanelMounted helper in panel-layout.ts');
    assert.match(
      afterPanelMounted[0],
      /panel\.toggle\(config\.enabled\);/,
      'lazy-mounted panels must replay the saved enabled/hidden state after insertion',
    );
  });

  it('reserves deferred shells for natural wide/tall panel footprints', () => {
    const mismatches = [];
    const naturalFootprints = naturalDeferredPanelFootprints();
    const registryEntries = deferredPanelFootprintRegistryEntries();

    for (const [panelId, footprint] of naturalFootprints) {
      if (footprint.unverifiableRowSpan) {
        mismatches.push(
          panelId + ' (' + footprint.file + ') has a non-literal defaultRowSpan "' +
            footprint.unverifiableRowSpan + '" this guard cannot verify; inline a literal 2-4 ' +
            'or extend naturalDeferredPanelFootprints to resolve it',
        );
        continue;
      }
      if (footprint.unverifiableClassName) {
        mismatches.push(
          panelId + ' (' + footprint.file + ') has a non-literal className "' +
            footprint.unverifiableClassName + '" this guard cannot verify for panel-wide; ' +
            'inline a static className or extend naturalDeferredPanelFootprints to resolve it',
        );
        continue;
      }
      const entry = registryEntries.get(panelId);
      if (!entry) {
        mismatches.push(panelId + ' (' + footprint.file + ') missing registry entry');
        continue;
      }
      if (footprint.rowSpan && !entry.includes('rowSpan: ' + footprint.rowSpan)) {
        mismatches.push(panelId + ' (' + footprint.file + ') missing rowSpan: ' + footprint.rowSpan);
      }
      if (footprint.panelWide && !PANEL_WIDE_CLASS_RE.test(entry)) {
        mismatches.push(panelId + ' (' + footprint.file + ') missing panel-wide className');
      }
    }

    for (const [panelId, entry] of registryEntries) {
      const footprint = naturalFootprints.get(panelId);
      if (!footprint) {
        mismatches.push(panelId + ' has stale registry entry with no natural wide/tall constructor footprint');
        continue;
      }
      const registeredRowSpan = entry.match(/rowSpan:\s*([2-4])/);
      if (registeredRowSpan && registeredRowSpan[1] !== footprint.rowSpan) {
        mismatches.push(panelId + ' registry rowSpan ' + registeredRowSpan[1] + ' does not match constructor footprint');
      }
      const registeredPanelWide = PANEL_WIDE_CLASS_RE.test(entry);
      if (registeredPanelWide !== footprint.panelWide) {
        mismatches.push(panelId + ' registry panel-wide className does not match constructor footprint');
      }
    }

    assert.deepStrictEqual(
      mismatches,
      [],
      'Deferred shell natural footprint registry mismatch:\n' + mismatches.join('\n'),
    );
  });

  it('reserves deferred shells for dynamic custom and MCP panel footprints', () => {
    const dynamicEntries = deferredDynamicPanelFootprintRegistryEntries();
    assert.match(dynamicEntries.get('cw-') ?? '', /rowSpan:\s*2/, 'cw- dynamic shell row span missing');
    assert.match(dynamicEntries.get('mcp-') ?? '', /rowSpan:\s*2/, 'mcp- dynamic shell row span missing');
    assert.equal(dynamicConstructorRowSpan('CustomWidgetPanel.ts', 'custom-widget-panel'), 2);
    assert.equal(dynamicConstructorRowSpan('McpDataPanel.ts', 'mcp-data-panel'), 2);
  });

  it('runs dynamic custom and MCP panels through the mounted-panel hydration path', () => {
    const helperStart = panelLayoutSrc.indexOf('private addDynamicPanel(');
    assert.notEqual(helperStart, -1, 'expected addDynamicPanel helper in panel-layout.ts');
    const helperEnd = panelLayoutSrc.indexOf('addCustomWidget(spec:', helperStart);
    assert.ok(helperEnd > helperStart, 'expected addDynamicPanel helper boundary in panel-layout.ts');
    const addDynamicPanel = panelLayoutSrc.slice(helperStart, helperEnd);
    assert.match(
      addDynamicPanel,
      /this\.afterPanelMounted\(key, panel\);/,
      'custom and MCP panels added after startup must run afterPanelMounted so initial hydration can be scheduled',
    );

    for (const methodName of ['addCustomWidget', 'addMcpPanel']) {
      const methodStart = panelLayoutSrc.indexOf(`${methodName}(spec:`);
      assert.notEqual(methodStart, -1, `expected ${methodName} method in panel-layout.ts`);
      const methodEnd = methodName === 'addCustomWidget'
        ? panelLayoutSrc.indexOf('addMcpPanel(spec:', methodStart)
        : panelLayoutSrc.indexOf('private getSavedPanelOrder', methodStart);
      assert.ok(methodEnd > methodStart, `expected ${methodName} method boundary in panel-layout.ts`);
      const method = panelLayoutSrc.slice(methodStart, methodEnd);
      assert.match(
        method,
        /this\.importPanel\(/,
        `${methodName} must use the shared guarded import path`,
      );
      assert.match(
        method,
        /this\.addDynamicPanel\(spec\.id, panel\);/,
        `${methodName} must insert through addDynamicPanel() so notifyConnected/afterPanelMounted run`,
      );
    }
  });

  it('every API-key-entitled premium panel is in WEB_PREMIUM_PANELS (anon lock-CTA invariant)', () => {
    // Background: src/config/panels.ts has TWO premium-related lists:
    //
    //   (a) `apiKeyPanels` — panels that an API-key holder OR a Pro user
    //       can access. Lives inside isPanelEntitled().
    //   (b) `WEB_PREMIUM_PANELS` — panels that the web layout's
    //       updatePanelGating() drives through Panel.showGatedCta() to
    //       render the "Sign In to Unlock" / "Upgrade to Pro" CTA.
    //
    // If a panel is in (a) but NOT (b), API-key users can see it, but
    // anonymous web users see the panel mount and run its loader (writing
    // empty/loading/error UI directly into the body) instead of the lock
    // CTA. The PRO badge still renders, producing a "PRO + visible loader"
    // shape that looks broken to the user.
    //
    // Concrete regression that motivated this test: PR #3578 added a soft
    // empty state to RegionalIntelligenceBoard. For anonymous users it
    // wrote "Regional intelligence is being refreshed" into the body
    // because regional-intelligence was in apiKeyPanels (so isPanelEntitled
    // mounted it) but missing from WEB_PREMIUM_PANELS (so showGatedCta
    // never fired). See todos/257-pending-p2-anon-broken-panels-sweep.md
    // item 8.
    const panelsSrc = readFileSync(resolve(__dirname, '../src/config/panels.ts'), 'utf-8');

    // Accept both quote styles — biome currently enforces single quotes
    // across the repo, but this guard is meant to outlive style drift.
    // A double-quoted entry slipping past the regex would silently
    // shrink the verified set and let an orphan re-appear.
    const QUOTED = /['"]([^'"]+)['"]/g;

    const apiKeyPanelsMatch = panelsSrc.match(/const apiKeyPanels = \[([^\]]+)\];/);
    assert.ok(apiKeyPanelsMatch, 'apiKeyPanels array not found in panels.ts');
    const apiKeyPanels = [...apiKeyPanelsMatch[1].matchAll(QUOTED)].map(m => m[1]);
    assert.ok(apiKeyPanels.length > 0, 'apiKeyPanels parse returned no entries');

    const webPremiumMatch = panelLayoutSrc.match(/const WEB_PREMIUM_PANELS = new Set\(\[([\s\S]*?)\]\);/);
    assert.ok(webPremiumMatch, 'WEB_PREMIUM_PANELS not found in panel-layout.ts');
    const webPremium = new Set([...webPremiumMatch[1].matchAll(QUOTED)].map(m => m[1]));
    assert.ok(webPremium.size > 0, 'WEB_PREMIUM_PANELS parse returned no entries');

    const orphans = apiKeyPanels.filter(k => !webPremium.has(k));
    assert.deepStrictEqual(
      orphans,
      [],
      `apiKeyPanels members missing from WEB_PREMIUM_PANELS: ${orphans.join(', ')}\n` +
      `Add these keys to src/app/panel-layout.ts WEB_PREMIUM_PANELS so anonymous/free users see the\n` +
      `"Sign In to Unlock" CTA instead of the panel's own internal loading/empty/error state.`,
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

  it('warns in dev when a hydrated panel exceeds its reserved deferred-shell footprint', () => {
    const mountPanelElement = panelLayoutSrc.match(/private\s+mountPanelElement[\s\S]*?\n {2}\}/);
    assert.ok(mountPanelElement, 'mountPanelElement method not found');
    assert.match(
      mountPanelElement[0],
      /if\s*\(import\.meta\.env\.DEV\)\s*warnOnDeferredFootprintDrift\(key, placeholder, el\);/,
      'mountPanelElement must surface deferred-shell footprint drift in dev builds',
    );
    assert.match(
      panelLayoutSrc,
      /function warnOnDeferredFootprintDrift\(/,
      'warnOnDeferredFootprintDrift helper must exist',
    );
  });

  it('warns in dev when the boot skeleton footprint drifts from the hydrated app shell', () => {
    const renderLayout = panelLayoutSrc.match(/async\s+renderLayout\(\):\s+Promise<void>\s+\{[\s\S]*?\n {2}\}/);
    assert.ok(renderLayout, 'renderLayout method not found');
    assert.match(
      renderLayout[0],
      /const\s+bootShellFootprint\s*=\s*import\.meta\.env\.DEV\s*\?\s*captureBootShellFootprint\(this\.ctx\.container\)\s*:\s*null;/,
      'renderLayout must snapshot the pre-hydration skeleton footprint in dev builds',
    );
    assert.match(
      renderLayout[0],
      /if\s*\(import\.meta\.env\.DEV\s*&&\s*bootShellFootprint\)\s*warnOnBootShellFootprintDrift\(bootShellFootprint\);/,
      'renderLayout must surface skeleton->app footprint drift after initial panels/tabs mount',
    );
    assert.match(
      panelLayoutSrc,
      /function warnOnBootShellFootprintDrift\(/,
      'warnOnBootShellFootprintDrift helper must exist',
    );
    for (const selector of ['.skeleton-header', '.skeleton-tabs', '.skeleton-main', '.skeleton-map', '.skeleton-grid']) {
      assert.match(
        panelLayoutSrc,
        new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `boot shell footprint guard must include ${selector}`,
      );
    }
  });

  it('keeps brace depth balanced across regex literals inside super() bodies', () => {
    // Regression: a regex literal containing braces or quotes must not desync
    // findMatchingBrace/superObjectBodies (which would silently drop or
    // over-capture a panel footprint).
    const src =
      "class P { constructor() { super({ id: 'p', re: /[{}]'\"/, defaultRowSpan: 2 }); this.x = {}; } }";
    const bodies = superObjectBodies(src);
    assert.equal(bodies.length, 1, 'exactly the super(...) object body should be captured');
    assert.match(bodies[0], /id: 'p'/);
    assert.match(bodies[0], /defaultRowSpan: 2/);
    assert.ok(!bodies[0].includes('this.x'), 'capture must stop at the super() object close brace');
  });

  it('does not mistake division for a regex literal in super() bodies', () => {
    const src = "class P { constructor() { super({ id: 'p', ratio: width / 2, defaultRowSpan: 3 }); } }";
    const bodies = superObjectBodies(src);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /defaultRowSpan: 3/);
  });

  it('flags a non-literal defaultRowSpan as unverifiable rather than skipping it', () => {
    // naturalDeferredPanelFootprints must surface values it cannot statically
    // resolve, so a footprint expressed via a constant/expression cannot
    // silently escape the registry-drift guard.
    const src = "super({ id: 'mystery', defaultRowSpan: ROW_SPAN_TALL });";
    const bodies = superObjectBodies(src);
    const body = bodies[0] ?? '';
    const rowSpanRaw = body.match(/defaultRowSpan:\s*([^,\n}]+)/);
    assert.ok(rowSpanRaw, 'expected a defaultRowSpan match');
    const value = rowSpanRaw[1].trim();
    assert.ok(!/^[2-4]$/.test(value) && value !== '1', 'value should be treated as unverifiable');
  });

  it('includes TSX sources and flags non-literal className as unverifiable', () => {
    assert.equal(COMPONENT_SOURCE_RE.test('FuturePanel.tsx'), true);

    const src = "super({ id: 'mystery-wide', className: panelClassName });";
    const bodies = superObjectBodies(src);
    const body = bodies[0] ?? '';
    const classNameRaw = body.match(/className:\s*([^,\n}]+)/);
    assert.ok(classNameRaw, 'expected a className match');
    assert.equal(staticStringLiteralValue(classNameRaw[1]), null);
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
