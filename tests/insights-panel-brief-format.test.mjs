import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const insightsPanelSrc = readFileSync(
  path.join(repoRoot, 'src/components/InsightsPanel.ts'),
  'utf8',
);

it('keeps world-brief caching and cooldown safeguards wired', () => {
  assert.match(
    insightsPanelSrc,
    /BRIEF_COOLDOWN_MS = 120000/,
    'world-brief generation should retain a defensive cooldown to avoid rapid re-runs',
  );
  assert.match(
    insightsPanelSrc,
    /BRIEF_CACHE_KEY = 'summary:world-brief'/,
    'world-brief cache key should stay stable for persistence/hydration consistency',
  );
  assert.match(
    insightsPanelSrc,
    /getPersistentCache<\{ summary: string \}>\(InsightsPanel\.BRIEF_CACHE_KEY\)/,
    'world-brief should load from persistent cache when available',
  );
  assert.match(
    insightsPanelSrc,
    /setPersistentCache\(InsightsPanel\.BRIEF_CACHE_KEY, \{ summary: worldBrief \}\)/,
    'world-brief should persist fresh summaries back into persistent cache',
  );
});
