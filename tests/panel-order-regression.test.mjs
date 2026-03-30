import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const panelsSrc = readFileSync(resolve(root, 'src/config/panels.ts'), 'utf8');
const appSrc = readFileSync(resolve(root, 'src/App.ts'), 'utf8');

describe('panel order regressions', () => {
  it('puts watchlists and escalation panels ahead of raw feeds in the full variant defaults', () => {
    assert.match(
      panelsSrc,
      /const FULL_PANELS[\s\S]*?map:[\s\S]*?watchlist:[\s\S]*?'alert-center':[\s\S]*?'strategic-risk':[\s\S]*?'strategic-posture':[\s\S]*?insights:[\s\S]*?cii:[\s\S]*?'geo-hubs':[\s\S]*?'live-news':/,
      'full variant should lead with watchlists and escalation panels before live feeds',
    );
  });

  it('puts AI overview panels ahead of raw feeds in the tech variant defaults', () => {
    assert.match(
      panelsSrc,
      /const TECH_PANELS[\s\S]*?map:[\s\S]*?insights:[\s\S]*?regulation:[\s\S]*?'tech-readiness':[\s\S]*?ai:[\s\S]*?'tech-hubs':[\s\S]*?tech:[\s\S]*?policy:[\s\S]*?'live-news':/,
      'tech variant should lead with AI overview panels before headline feeds',
    );
  });

  it('promotes storm-specific panels when disaster mode is active', () => {
    assert.match(
      panelsSrc,
      /'tropical-cyclones': \{ name: 'Tropical Cyclones', enabled: true, priority: 2 \}/,
      'full variant should expose the tropical cyclones panel',
    );
    assert.match(
      readFileSync(resolve(root, 'src/app/panel-layout.ts'), 'utf8'),
      /private static readonly DISASTER_PRIORITY = \[[\s\S]*?'saved-places'[\s\S]*?'tropical-cyclones'[\s\S]*?'nws-alerts'[\s\S]*?'weather'/,
      'disaster mode should lift saved places and storm panels ahead of generic disaster feeds',
    );
  });

  it('migrates saved panel order so existing users also get the critical workflow up top', () => {
    assert.match(
      appSrc,
      /const CRITICAL_PRIORITY_PANELS: Record<string, string\[]> = \{/,
      'app startup should define per-variant critical priority panels',
    );
    assert.match(
      appSrc,
      /worldmonitor-critical-top-v2\.7\.5/,
      'app startup should migrate existing saved layouts to the critical-first ordering',
    );
    assert.match(
      appSrc,
      /\.\.\.criticalPriorityPanels\.filter\(panelKey => order\.includes\(panelKey\)\)/,
      'migration should explicitly lift critical panels to the front of saved layouts',
    );
  });
});
