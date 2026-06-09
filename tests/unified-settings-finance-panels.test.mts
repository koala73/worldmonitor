import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const unifiedSettingsSource = fs.readFileSync('/Users/lab2/AI/AI_1/worldmonitor/src/components/UnifiedSettings.ts', 'utf8');
const mainCss = fs.readFileSync('/Users/lab2/AI/AI_1/worldmonitor/src/styles/main.css', 'utf8');

test('settings explain core optional and external panels', () => {
  assert.match(unifiedSettingsSource, /private renderPanelTierGuide\(\): string/);
  assert.match(unifiedSettingsSource, /<strong>Core<\/strong> opens on first load and is tuned for daily use\./);
  assert.match(unifiedSettingsSource, /<strong>Optional<\/strong> stays available in settings for satellite data and unstable upstream feeds\./);
  assert.match(unifiedSettingsSource, /<strong>External<\/strong> relies on third-party providers and may temporarily degrade without breaking the rest of the dashboard\./);
  assert.match(unifiedSettingsSource, /<strong>Tip<\/strong> combine a category and panel tier to isolate external panels inside one workflow\./);
});

test('settings tag panels as core optional or external', () => {
  assert.match(unifiedSettingsSource, /private getPanelTier\(key: string\): 'Core' \| 'Optional' \| 'External'/);
  assert.match(unifiedSettingsSource, /panel-toggle-tier-badge panel-toggle-tier-\$\{panelTier\.toLowerCase\(\)\}/);
});

test('settings support all core optional external scope filters', () => {
  assert.match(unifiedSettingsSource, /type PanelTierScope = 'all' \| 'core' \| 'optional' \| 'external'/);
  assert.match(unifiedSettingsSource, /private activePanelScope: PanelTierScope = \['finance', 'full', 'tech', 'energy', 'commodity'\]\.includes\(SITE_VARIANT\) \? 'core' : 'all';/);
  assert.match(unifiedSettingsSource, /All \(\$\{counts\.all\}\)/);
  assert.match(unifiedSettingsSource, /Core only \(\$\{counts\.core\}\)/);
  assert.match(unifiedSettingsSource, /Optional \(\$\{counts\.optional\}\)/);
  assert.match(unifiedSettingsSource, /External \(\$\{counts\.external\}\)/);
  assert.match(unifiedSettingsSource, /data-panel-scope="\$\{scope\.key\}"/);
  assert.match(unifiedSettingsSource, /No panels match this panel tier filter\./);
  assert.match(unifiedSettingsSource, /No panels match this category and panel tier filter\./);
  assert.match(unifiedSettingsSource, /No panels match this category filter\./);
});

test('panel categories stay visible even when all panels in a finance category are disabled', () => {
  assert.match(unifiedSettingsSource, /const count = catDef\.panelKeys\.filter\(pk => settings\[pk\]\)\.length;/);
  assert.match(unifiedSettingsSource, /if \(count > 0\) \{/);
  assert.match(unifiedSettingsSource, /escapeHtml\(`\$\{c\.label\} \(\$\{c\.count\}\)`\)/);
});

test('settings sort core optional and external panels by tier rank', () => {
  assert.match(unifiedSettingsSource, /const tierRank: Record<'Core' \| 'Optional' \| 'External', number>/);
  assert.match(unifiedSettingsSource, /if \(aTier !== bTier\) return tierRank\[aTier\] - tierRank\[bTier\];/);
});

test('core optional and external panel badges have dedicated styles', () => {
  assert.match(mainCss, /\.panel-toggle-tier-badge \{/);
  assert.match(mainCss, /\.panel-toggle-tier-core \{/);
  assert.match(mainCss, /\.panel-toggle-tier-optional \{/);
  assert.match(mainCss, /\.panel-toggle-tier-external \{/);
  assert.match(mainCss, /\.panels-guide-brief \{/);
  assert.match(mainCss, /\.panel-toggle-empty \{/);
});
