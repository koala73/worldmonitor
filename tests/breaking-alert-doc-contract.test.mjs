import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const ALERT_SOURCE = read('src/services/breaking-news-alerts.ts');
const ARCHITECTURE_EN = read('docs/architecture.mdx');
const ARCHITECTURE_ZH = read('docs/zh/architecture.mdx');
const ALGORITHMS_EN = read('docs/algorithms.mdx');
const ALGORITHMS_ZH = read('docs/zh/algorithms.mdx');

function wiredOrigins(source) {
  return [...new Set(
    [...source.matchAll(/^\s+origin:\s*'([^']+)',\s*$/gm)].map((match) => match[1]),
  )].sort();
}

function documentedOrigins(document, sectionStart, sectionEnd, labels) {
  const section = document.slice(document.indexOf(sectionStart), document.indexOf(sectionEnd));
  return [...section.matchAll(/^\|\s+\*\*([^*]+)\*\*\s+\|/gm)]
    .map((match) => labels.get(match[1].trim()))
    .filter(Boolean)
    .sort();
}

describe('breaking-alert documentation contract', () => {
  const implementationOrigins = wiredOrigins(ALERT_SOURCE);

  it('documents exactly the wired English banner origins', () => {
    const labels = new Map([
      ['RSS alert', 'rss_alert'],
      ['Keyword spike', 'keyword_spike'],
      ['Hotspot escalation', 'hotspot_escalation'],
      ['Military surge', 'military_surge'],
      ['OREF siren', 'oref_siren'],
    ]);

    assert.deepEqual(
      documentedOrigins(
        ALGORITHMS_EN,
        '### Breaking News Alert Pipeline',
        '**Anti-noise safeguards**',
        labels,
      ),
      implementationOrigins,
    );
  });

  it('documents exactly the wired Chinese banner origins', () => {
    const labels = new Map([
      ['RSS 警报', 'rss_alert'],
      ['关键词飙升', 'keyword_spike'],
      ['热点升级', 'hotspot_escalation'],
      ['军事激增', 'military_surge'],
      ['OREF 警报', 'oref_siren'],
    ]);

    assert.deepEqual(
      documentedOrigins(
        ALGORITHMS_ZH,
        '### 突发新闻警报管道',
        '**反噪音保障**',
        labels,
      ),
      implementationOrigins,
    );
  });

  it('does not present the banner as a five-origin convergence system', () => {
    for (const architecture of [ARCHITECTURE_EN, ARCHITECTURE_ZH]) {
      assert.doesNotMatch(architecture, /No single data stream can drive a critical alert alone|Critical intelligence signals use multiple independent sources|5-origin design|关键情报信号使用多个独立来源|五个独立警报来源|5 来源设计/);
      assert.match(architecture, /`rss_alert`/);
      assert.match(architecture, /`oref_siren`/);
    }
  });
});
