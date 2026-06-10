import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildThreatTimelineState,
  normalizeClusterStories,
  normalizeServerInsightStories,
  normalizeThreatLevel,
} from '../src/components/threat-timeline-utils.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const NOW_MS = Date.UTC(2026, 5, 10, 12, 0, 0);

function isoDaysAgo(days: number): string {
  return new Date(NOW_MS - days * 24 * 60 * 60 * 1000).toISOString();
}

function serverStory(overrides = {}) {
  return {
    primaryTitle: 'Border clashes intensify near capital',
    primarySource: 'ACLED',
    primaryLink: 'https://example.com/story',
    pubDate: isoDaysAgo(0),
    sourceCount: 2,
    importanceScore: 42,
    velocity: { level: 'normal', sourcesPerHour: 1 },
    isAlert: false,
    category: 'conflict',
    threatLevel: 'high',
    countryCode: 'SD',
    ...overrides,
  };
}

describe('ThreatTimelinePanel utilities', () => {
  it('normalizes the threat taxonomy into the panel lanes', () => {
    assert.equal(normalizeThreatLevel('critical'), 'critical');
    assert.equal(normalizeThreatLevel('elevated'), 'medium');
    assert.equal(normalizeThreatLevel('moderate'), 'medium');
    assert.equal(normalizeThreatLevel('unknown'), 'info');
    assert.equal(normalizeThreatLevel(undefined), 'info');
  });

  it('buckets server insight stories into a 7-day severity distribution', () => {
    const items = normalizeServerInsightStories({
      generatedAt: new Date(NOW_MS).toISOString(),
      topStories: [
        serverStory({ threatLevel: 'critical', pubDate: isoDaysAgo(0), primaryTitle: 'Critical item' }),
        serverStory({ threatLevel: 'high', pubDate: isoDaysAgo(1), primaryTitle: 'High item' }),
        serverStory({ threatLevel: 'medium', pubDate: isoDaysAgo(2), primaryTitle: 'Medium item' }),
        serverStory({ threatLevel: 'low', pubDate: isoDaysAgo(6), primaryTitle: 'Low item' }),
        serverStory({ threatLevel: 'info', pubDate: isoDaysAgo(8), primaryTitle: 'Old item' }),
      ],
    });

    const state = buildThreatTimelineState(items, { nowMs: NOW_MS });

    assert.equal(state.days.length, 7);
    assert.equal(state.totals.critical, 1);
    assert.equal(state.totals.high, 1);
    assert.equal(state.totals.medium, 1);
    assert.equal(state.totals.low, 1);
    assert.equal(state.totals.info, 0, 'items older than 7 days are excluded');
    assert.equal(state.hasData, true);
  });

  it('sorts grouped current alerts by threat severity before recency', () => {
    const items = normalizeServerInsightStories({
      generatedAt: new Date(NOW_MS).toISOString(),
      topStories: [
        serverStory({ threatLevel: 'low', pubDate: isoDaysAgo(0), primaryTitle: 'Fresh low' }),
        serverStory({ threatLevel: 'critical', pubDate: isoDaysAgo(1), primaryTitle: 'Older critical' }),
        serverStory({ threatLevel: 'high', pubDate: isoDaysAgo(0), primaryTitle: 'Fresh high' }),
      ],
    });

    const state = buildThreatTimelineState(items, { nowMs: NOW_MS });

    assert.deepEqual(state.groups.map(group => group.level), ['critical', 'high', 'low']);
    assert.equal(state.items[0]?.title, 'Older critical');
    assert.equal(state.items[1]?.title, 'Fresh high');
  });

  it('surfaces empty and degraded states without throwing away the 7-day scaffold', () => {
    const state = buildThreatTimelineState([], {
      nowMs: NOW_MS,
      status: 'degraded',
      statusMessage: 'Server insight snapshot unavailable',
    });

    assert.equal(state.hasData, false);
    assert.equal(state.status, 'degraded');
    assert.equal(state.days.length, 7);
    assert.deepEqual(state.groups, []);
    assert.match(state.degradedReasons.join('\n'), /Server insight snapshot unavailable/);
  });

  it('normalizes cluster fallback provenance from keyword-classified items', () => {
    const items = normalizeClusterStories([{
      id: 'cluster-1',
      primaryTitle: 'Protests spread after blackout',
      primarySource: 'Regional RSS',
      primaryLink: 'https://example.com/cluster',
      sourceCount: 1,
      topSources: [{ name: 'Regional RSS', tier: 2, url: 'https://example.com/source' }],
      allItems: [],
      firstSeen: new Date(isoDaysAgo(1)),
      lastUpdated: new Date(isoDaysAgo(0)),
      isAlert: true,
      threat: { level: 'high', category: 'protest', confidence: 0.8, source: 'keyword' },
    }]);

    assert.equal(items[0]?.provenance, 'Keyword fallback');
    assert.equal(items[0]?.threatLevel, 'high');
  });
});

describe('ThreatTimelinePanel registration', () => {
  it('is registered in the full variant, layout, data loader, command palette, and intelligence category', () => {
    const panelsSrc = readFileSync(resolve(root, 'src/config/panels.ts'), 'utf-8');
    const layoutSrc = readFileSync(resolve(root, 'src/app/panel-layout.ts'), 'utf-8');
    const dataLoaderSrc = readFileSync(resolve(root, 'src/app/data-loader.ts'), 'utf-8');
    const commandsSrc = readFileSync(resolve(root, 'src/config/commands.ts'), 'utf-8');

    assert.match(panelsSrc, /'threat-timeline':\s*\{\s*name:\s*'Threat Timeline'/);
    assert.match(panelsSrc, /intelligence:\s*\{[\s\S]*panelKeys:\s*\[[^\]]*'threat-timeline'/);
    assert.match(layoutSrc, /isPanelInVariantDefaults\('threat-timeline'\)[\s\S]*createPanel\('threat-timeline',\s*\(\)\s*=>\s*new ThreatTimelinePanel\(\)\)/);
    assert.match(dataLoaderSrc, /isPanelInVariantDefaults\('threat-timeline'\)[\s\S]*panels\['threat-timeline'\]\s+as ThreatTimelinePanel/);
    assert.match(commandsSrc, /id:\s*'panel:threat-timeline'[\s\S]*keywords:\s*\[[^\]]*'threat trend'/);
  });
});
