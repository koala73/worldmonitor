import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const panelLayoutSrc = readFileSync(resolve(__dirname, '../src/app/panel-layout.ts'), 'utf-8');

const VARIANT_FILES = ['full', 'tech', 'finance', 'commodity', 'happy'];

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
