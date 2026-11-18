import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';

import { computeImportanceScore } from '../server/worldmonitor/news/v1/list-feed-digest.ts';

const require = createRequire(import.meta.url);

process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.CONVEX_NOTIFICATION_RELAY_SECRET ??= 'stub-secret';
const ModuleWithLoad = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = ModuleWithLoad._load;
ModuleWithLoad._load = function patchedLoad(this: unknown, request: string, ...rest: unknown[]) {
  if (request === 'resend') return { Resend: class {} };
  if (request === 'convex/browser') return { ConvexHttpClient: class { async query() {} } };
  return originalLoad.call(this, request, ...rest);
};
const { shouldNotify } = require('../scripts/notification-relay.cjs');

interface Wording {
  source: string;
  title: string;
  label: 'critical' | 'high' | 'medium' | 'low' | 'info';
  publishedAt: string;
  seenAt: string;
  corroboration: number;
  observedScore: number;
  scoreNow?: number;
}
interface Incident { id: string; expected: 'alert' | 'none'; knownMiss?: string; wordings: Wording[] }

const { incidents } = JSON.parse(
  readFileSync(new URL('./fixtures/alert-replays.json', import.meta.url), 'utf8'),
) as { incidents: Incident[] };

const CRITICAL_REALTIME_RULE = { sensitivity: 'critical', digestMode: 'realtime', eventTypes: [] };

function replay(wording: Wording) {
  const now = mock.method(Date, 'now', () => Date.parse(wording.seenAt));
  try {
    const score = computeImportanceScore(wording.label, wording.source, wording.corroboration, Date.parse(wording.publishedAt), { title: wording.title });
    const event = { eventType: 'rss_alert', severity: wording.label, payload: { title: wording.title, source: wording.source, importanceScore: score } };
    return { score, alerts: shouldNotify(CRITICAL_REALTIME_RULE, event) as boolean };
  } finally {
    now.mock.restore();
  }
}

describe('alert replay set (#10976)', () => {
  const previous = process.env.IMPORTANCE_SCORE_LIVE;
  process.env.IMPORTANCE_SCORE_LIVE = '1';

  for (const incident of incidents) {
    describe(incident.id, () => {
      const results = incident.wordings.map((w) => ({ wording: w, ...replay(w) }));

      for (const { wording, score } of results) {
        it(`scores the ${wording.source} copy as production did`, () => {
          assert.equal(score, wording.scoreNow ?? wording.observedScore);
        });
      }

      const alerted = results.some((r) => r.alerts);
      if (incident.knownMiss) {
        it(`still misses until ${incident.knownMiss} lands (update expected/knownMiss when this fails)`, () => {
          assert.equal(alerted, incident.expected !== 'alert');
        });
      } else {
        it(`outcome is ${incident.expected}`, () => {
          assert.equal(alerted, incident.expected === 'alert');
        });
      }
    });
  }

  process.env.IMPORTANCE_SCORE_LIVE = previous;
});
