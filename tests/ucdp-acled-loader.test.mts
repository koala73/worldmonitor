import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDuplicatedByAcled, deduplicateUcdpProjectionAggregates } from '../src/services/conflict/ucdp-dedupe.ts';

const source = readFileSync(new URL('../src/app/data-loader.ts', import.meta.url), 'utf8');
const start = source.lastIndexOf('tasks.push((async () => {', source.indexOf('const wantsFullUcdpSet'));
const end = source.indexOf('})());', start) + '})());'.length;
const closure = source.slice(start, end)
  .replace('(this.ctx.panels[\'ucdp-events\'] as UcdpEventsPanel)', "this.ctx.panels['ucdp-events']");
const run = new Function('tasks', 'conflictsTask', 'protestsTask', 'fetchUcdpEvents', 'hydratedUcdp', 'deduplicateAgainstAcled', 'deduplicateUcdpProjectionAggregates', 'dataFreshness', closure);
const dateMs = Date.parse('2026-09-16T00:00:00Z');
const row = { latitude: 12, longitude: 24, dateMs, deathsBest: 0 };
const comparison = { lat: 12, lon: 24, time: new Date(dateMs), fatalities: 0 };
const type = 'UCDP_VIOLENCE_TYPE_STATE_BASED';

for (const conflictMatch of [false, true]) {
  test(`UCDP loader uses conflict events for rows and aggregate counts: conflict match=${conflictMatch}`, async () => {
    let rendered: unknown[] = [];
    const tasks: Promise<void>[] = [];
    run.call({ctx: { mapLayers: {ucdpEvents: false}, panels: {'ucdp-events': {setEvents: (...args: unknown[]) => {rendered = args;}}}}},
      tasks, Promise.resolve(conflictMatch ? [comparison] : []), Promise.resolve(conflictMatch ? [] : [comparison]),
      async () => ({success: true, data: [row]}),
      {aggregates: {[type]: {count: 1, totalDeaths: 0}}, dedupeIndex: [[0, dateMs, 12, 24, 0]]},
      (rows: typeof row[], comparisons: Parameters<typeof isDuplicatedByAcled>[1]) => rows.filter(r => !isDuplicatedByAcled(r, comparisons)),
      deduplicateUcdpProjectionAggregates, {recordUpdate() {}, recordError() {throw new Error('unexpected loader failure');}});
    await Promise.all(tasks);
    assert.deepEqual(rendered, [conflictMatch ? [] : [row], {[type]: {count: conflictMatch ? 0 : 1, totalDeaths: 0}}]);
  });
}
