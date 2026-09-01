import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyMonitorHighlightsToNews,
  evaluateMonitorMatches,
  hasMonitorProAccess,
  mergeMonitorEdits,
  normalizeMonitor,
  normalizeMonitors,
  partitionMonitorsForAccess,
  prepareMonitorsForRuntime,
  sanitizeMonitorColor,
} from '../src/services/monitors.ts';
import type { Monitor } from '../src/types/index.ts';
import { getSecretState } from '../src/services/runtime-config.ts';

describe('normalizeMonitor', () => {
  it('migrates legacy keyword monitors into the richer rule shape', () => {
    const monitor = normalizeMonitor({
      id: 'legacy',
      keywords: ['Iran', ' Hormuz '],
      color: '#fff',
    } as Monitor);

    assert.deepEqual(monitor.keywords, ['iran', 'hormuz']);
    assert.deepEqual(monitor.includeKeywords, ['iran', 'hormuz']);
    assert.deepEqual(monitor.excludeKeywords, []);
    assert.deepEqual(monitor.sources, ['news']);
    assert.equal(monitor.matchMode, 'any');
    assert.ok(monitor.name);
  });
});

describe('prepareMonitorsForRuntime', () => {
  it('strips pro-only rule features for free runtime execution', () => {
    const runtime = prepareMonitorsForRuntime([{
      id: 'm1',
      name: 'Hormuz',
      keywords: ['hormuz'],
      includeKeywords: ['hormuz'],
      excludeKeywords: ['analysis'],
      sources: ['news', 'advisories', 'cross-source'],
      color: '#0f0',
    }], false);

    assert.equal(runtime.length, 1);
    assert.deepEqual(runtime[0]?.excludeKeywords, []);
    assert.deepEqual(runtime[0]?.sources, ['news']);
  });

  it('falls back to free sources when no free monitor sources remain', () => {
    const runtime = prepareMonitorsForRuntime([{
      id: 'm2',
      name: 'Advisories only',
      keywords: ['hormuz'],
      includeKeywords: ['hormuz'],
      sources: ['advisories'],
      color: '#0f0',
    }], false);

    assert.equal(runtime.length, 1);
    assert.deepEqual(runtime[0]?.sources, ['news', 'breaking']);
  });

  it('limits free runtime execution to the first three monitors', () => {
    const monitors = Array.from({ length: 4 }, (_, index) => ({
      id: `m${index}`,
      name: `Monitor ${index + 1}`,
      keywords: [`term${index}`],
      includeKeywords: [`term${index}`],
      sources: ['news'] as const,
      color: '#0f0',
    }));

    const runtime = prepareMonitorsForRuntime(monitors, false);
    assert.equal(runtime.length, 3);
    assert.deepEqual(runtime.map((monitor) => monitor.id), ['m0', 'm1', 'm2']);
  });
});

describe('evaluateMonitorMatches', () => {
  it('matches across news, advisories, and cross-source feeds when pro access is enabled', () => {
    const monitor: Monitor = {
      id: 'm1',
      name: 'Hormuz Watch',
      keywords: ['hormuz'],
      includeKeywords: ['hormuz'],
      sources: ['news', 'advisories', 'cross-source'],
      color: '#0f0',
    };

    const matches = evaluateMonitorMatches([monitor], {
      news: [{
        source: 'Reuters',
        title: 'Shipping insurance rises near Hormuz',
        link: 'https://example.com/hormuz-news',
        pubDate: new Date('2026-03-28T10:00:00Z'),
        isAlert: true,
      }],
      advisories: [{
        title: 'Travel advisory updated for Strait of Hormuz transits',
        link: 'https://example.com/hormuz-advisory',
        pubDate: new Date('2026-03-28T11:00:00Z'),
        source: 'UK FCDO',
        sourceCountry: 'GB',
        country: 'OM',
        level: 'reconsider',
      }],
      crossSourceSignals: [{
        id: 'sig-1',
        type: 'CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION',
        theater: 'Strait of Hormuz',
        summary: 'Composite shipping disruption detected around Hormuz traffic lanes.',
        severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH',
        severityScore: 82,
        detectedAt: Date.parse('2026-03-28T12:00:00Z'),
        contributingTypes: ['shipping_disruption', 'market_stress'],
        signalCount: 2,
      }],
    }, { proAccess: true });

    assert.equal(matches.length, 3);
    assert.deepEqual(matches.map((match) => match.sourceKind), ['cross-source', 'advisories', 'news']);
  });

  it('honors exclude keywords when pro access is enabled', () => {
    const monitor: Monitor = {
      id: 'm2',
      name: 'Iran hard match',
      keywords: ['iran'],
      includeKeywords: ['iran'],
      excludeKeywords: ['opinion'],
      sources: ['news'],
      color: '#f00',
    };

    const matches = evaluateMonitorMatches([monitor], {
      news: [{
        source: 'Example',
        title: 'Opinion: Iran strategy is shifting',
        link: 'https://example.com/opinion',
        pubDate: new Date('2026-03-28T10:00:00Z'),
        isAlert: false,
      }],
    }, { proAccess: true });

    assert.equal(matches.length, 0);
  });

  it('matches close word derivatives for broad monitor terms', () => {
    const monitor: Monitor = {
      id: 'm3',
      name: 'Korea broad',
      keywords: ['korea'],
      includeKeywords: ['korea'],
      sources: ['news'],
      color: '#00f',
    };

    const matches = evaluateMonitorMatches([monitor], {
      news: [{
        source: 'Example',
        title: 'Korean shipping patterns shift after new sanctions',
        link: 'https://example.com/korean-shipping',
        pubDate: new Date('2026-03-28T10:00:00Z'),
        isAlert: false,
      }],
    }, { proAccess: false });

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.matchedTerms[0], 'korea');
  });

  it('requires all include terms when matchMode is all', () => {
    const monitor: Monitor = {
      id: 'm-all',
      name: 'Dual watch',
      keywords: ['hormuz', 'insurance'],
      includeKeywords: ['hormuz', 'insurance'],
      matchMode: 'all',
      sources: ['news'],
      color: '#0f0',
    };

    const partial = evaluateMonitorMatches([monitor], {
      news: [{
        source: 'Example',
        title: 'Hormuz shipping lanes remain open',
        link: 'https://example.com/hormuz',
        pubDate: new Date('2026-03-28T10:00:00Z'),
        isAlert: false,
      }],
    }, { proAccess: false });
    assert.equal(partial.length, 0);

    const full = evaluateMonitorMatches([monitor], {
      news: [{
        source: 'Example',
        title: 'Hormuz insurance premiums rise sharply',
        link: 'https://example.com/hormuz-insurance',
        pubDate: new Date('2026-03-28T10:00:00Z'),
        isAlert: false,
      }],
    }, { proAccess: false });
    assert.equal(full.length, 1);
  });

  it('does not match breaking alerts from source or origin metadata alone', () => {
    const monitor: Monitor = {
      id: 'm-breaking-meta',
      name: 'Port watch',
      keywords: ['port'],
      includeKeywords: ['port'],
      sources: ['breaking'],
      color: '#0f0',
    };

    const matches = evaluateMonitorMatches([monitor], {
      breakingAlerts: [{
        id: 'alert-port',
        headline: 'Shipping disruption reported near Lisbon',
        source: 'Port Authority',
        threatLevel: 'high',
        timestamp: new Date('2026-03-28T10:05:00Z'),
        origin: 'port_monitor',
      }],
    }, { proAccess: true });

    assert.equal(matches.length, 0);
  });

  it('does not match advisories from source or level metadata alone', () => {
    const monitor: Monitor = {
      id: 'm-advisory-meta',
      name: 'Port watch',
      keywords: ['port'],
      includeKeywords: ['port'],
      sources: ['advisories'],
      color: '#0f0',
    };

    const matches = evaluateMonitorMatches([monitor], {
      advisories: [{
        title: 'Travel advisory updated for Lisbon region',
        link: 'https://example.com/lisbon-advisory',
        pubDate: new Date('2026-03-28T11:00:00Z'),
        source: 'Port Authority',
        sourceCountry: 'PT',
        country: 'PT',
        level: 'reconsider',
      }],
    }, { proAccess: true });

    assert.equal(matches.length, 0);
  });

  it('does not match cross-source enum labels without theater or summary hits', () => {
    const monitor: Monitor = {
      id: 'm-cross-meta',
      name: 'Shipping enum watch',
      keywords: ['shipping_disruption'],
      includeKeywords: ['shipping_disruption'],
      sources: ['cross-source'],
      color: '#0f0',
    };

    const matches = evaluateMonitorMatches([monitor], {
      crossSourceSignals: [{
        id: 'sig-enum',
        type: 'CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION',
        theater: 'Eastern Mediterranean',
        summary: 'Composite escalation detected around traffic lanes.',
        severity: 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH',
        severityScore: 82,
        detectedAt: Date.parse('2026-03-28T12:00:00Z'),
        contributingTypes: ['shipping_disruption', 'market_stress'],
        signalCount: 2,
      }],
    }, { proAccess: true });

    assert.equal(matches.length, 0);
  });

  it('does not match monitor keywords from URL slug text', () => {
    const monitor: Monitor = {
      id: 'm4',
      name: 'Iran watch',
      keywords: ['iran'],
      includeKeywords: ['iran'],
      sources: ['news'],
      color: '#00f',
    };

    const matches = evaluateMonitorMatches([monitor], {
      news: [{
        source: 'Example',
        title: 'Oil shipping patterns shift in the gulf',
        locationName: 'Strait of Hormuz',
        description: 'Insurers report no direct state attribution yet.',
        link: 'https://example.com/world/iran/oil-markets',
        pubDate: new Date('2026-03-28T10:00:00Z'),
        isAlert: false,
      }],
    }, { proAccess: false });

    assert.equal(matches.length, 0);
  });

  it('falls back to free feeds when pro-only sources are unavailable', () => {
    const monitor: Monitor = {
      id: 'm5',
      name: 'Advisories only',
      keywords: ['hormuz'],
      includeKeywords: ['hormuz'],
      sources: ['advisories'],
      color: '#0ff',
    };

    const matches = evaluateMonitorMatches([monitor], {
      news: [{
        source: 'Example',
        title: 'Hormuz shipping insurance rises',
        link: 'https://example.com/hormuz-news',
        pubDate: new Date('2026-03-28T10:00:00Z'),
        isAlert: false,
      }],
      breakingAlerts: [{
        id: 'alert-1',
        headline: 'Breaking: Hormuz transit disruption reported',
        source: 'World Monitor',
        threatLevel: 'high',
        timestamp: new Date('2026-03-28T10:05:00Z'),
        origin: 'keyword_spike',
      }],
    }, { proAccess: false });

    assert.equal(matches.length, 2);
    assert.deepEqual(matches.map((match) => match.sourceKind).sort(), ['breaking', 'news']);
  });
});

describe('applyMonitorHighlightsToNews', () => {
  it('annotates matched news items with monitor colors and clears unmatched colors', () => {
    const monitor: Monitor = {
      id: 'm4',
      name: 'China Watch',
      keywords: ['china'],
      includeKeywords: ['china'],
      sources: ['news'],
      color: '#abc',
    };

    const highlighted = applyMonitorHighlightsToNews([monitor], [
      {
        source: 'Example',
        title: 'China export controls tighten',
        link: 'https://example.com/china',
        pubDate: new Date('2026-03-28T10:00:00Z'),
        isAlert: false,
      },
      {
        source: 'Example',
        title: 'Brazil soybean crop outlook improves',
        link: 'https://example.com/brazil',
        pubDate: new Date('2026-03-28T10:00:00Z'),
        isAlert: false,
        monitorColor: '#stale',
      },
    ], { proAccess: false });

    assert.equal(highlighted[0]?.monitorColor, '#abc');
    assert.equal(highlighted[1]?.monitorColor, undefined);
  });
});

describe('hasMonitorProAccess', () => {
  it('requires exact cookie key matches', () => {
    if (getSecretState('WORLDMONITOR_API_KEY').present) {
      return;
    }

    const originalDocument = (globalThis as { document?: unknown }).document;
    const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

    try {
      (globalThis as { document?: unknown }).document = { cookie: 'x-wm-widget-key=abc; session=1' };
      (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null };
      assert.equal(hasMonitorProAccess(), false);

      (globalThis as { document?: unknown }).document = { cookie: 'wm-widget-key=abc; session=1' };
      assert.equal(hasMonitorProAccess(), true);
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = originalDocument;
      }

      if (originalLocalStorage === undefined) {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      } else {
        (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
      }
    }
  });

  it('requires non-empty cookie values and handles separators without spaces', () => {
    if (getSecretState('WORLDMONITOR_API_KEY').present) {
      return;
    }

    const originalDocument = (globalThis as { document?: unknown }).document;
    const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

    try {
      (globalThis as { document?: unknown }).document = { cookie: 'wm-widget-key=;wm-pro-key=' };
      (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null };
      assert.equal(hasMonitorProAccess(), false);

      (globalThis as { document?: unknown }).document = { cookie: 'wm-widget-key=abc;wm-pro-key=' };
      assert.equal(hasMonitorProAccess(), true);
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = originalDocument;
      }

      if (originalLocalStorage === undefined) {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      } else {
        (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
      }
    }
  });

  it('requires non-empty localStorage values', () => {
    if (getSecretState('WORLDMONITOR_API_KEY').present) {
      return;
    }

    const originalDocument = (globalThis as { document?: unknown }).document;
    const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

    try {
      (globalThis as { document?: unknown }).document = { cookie: '' };
      (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => '   ' };
      assert.equal(hasMonitorProAccess(), false);

      (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => 'abc' };
      assert.equal(hasMonitorProAccess(), true);
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = originalDocument;
      }

      if (originalLocalStorage === undefined) {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      } else {
        (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
      }
    }
  });
});

describe('normalizeMonitors', () => {
  it('returns an empty array for corrupt storage shapes', () => {
    assert.deepEqual(normalizeMonitors(null as unknown as Monitor[]), []);
    assert.deepEqual(normalizeMonitors(undefined as unknown as Monitor[]), []);
    assert.deepEqual(normalizeMonitors({} as unknown as Monitor[]), []);
  });
});

describe('partitionMonitorsForAccess', () => {
  it('splits active and inactive monitors for free users', () => {
    const monitors = Array.from({ length: 4 }, (_, index) => ({
      id: `m${index}`,
      name: `Monitor ${index + 1}`,
      keywords: [`term${index}`],
      includeKeywords: [`term${index}`],
      sources: ['news'] as const,
      color: '#0f0',
    }));

    const { active, inactive } = partitionMonitorsForAccess(monitors, false);
    assert.equal(active.length, 3);
    assert.equal(inactive.length, 1);
    assert.equal(inactive[0]?.id, 'm3');
  });
});

describe('sanitizeMonitorColor', () => {
  it('rejects unsafe CSS values', () => {
    assert.equal(sanitizeMonitorColor('red; background:url(javascript:alert(1))', '#abc'), '#abc');
    assert.equal(sanitizeMonitorColor('#abc', '#000'), '#abc');
    assert.equal(sanitizeMonitorColor('var(--status-live)', '#000'), 'var(--status-live)');
  });
});

describe('mergeMonitorEdits', () => {
  it('preserves locked pro fields when a free user edits an existing monitor', () => {
    const existing: Monitor = normalizeMonitor({
      id: 'm6',
      name: 'Locked monitor',
      keywords: ['hormuz'],
      includeKeywords: ['hormuz'],
      excludeKeywords: ['analysis'],
      sources: ['advisories'],
      color: '#0f0',
    });

    const edited = mergeMonitorEdits(existing, {
      id: '',
      name: 'Renamed monitor',
      keywords: ['hormuz'],
      includeKeywords: ['hormuz'],
      excludeKeywords: [],
      sources: [],
      color: existing.color,
      matchMode: 'any',
    }, false);

    assert.equal(edited.name, 'Renamed monitor');
    assert.deepEqual(edited.excludeKeywords, ['analysis']);
    assert.deepEqual(edited.sources, ['advisories']);
  });
});
