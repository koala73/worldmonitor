import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/app/data-loader.ts', import.meta.url), 'utf8');
const start = source.lastIndexOf('tasks.push((async () => {', source.indexOf('const wantsFullUcdpSet'));
const end = source.indexOf('})());', start) + '})());'.length;
const closure = source.slice(start, end)
  .replace('(this.ctx.panels[\'ucdp-events\'] as UcdpEventsPanel)', "this.ctx.panels['ucdp-events']");
const conflictStart = source.indexOf('const conflictsTask = (async () => {');
const conflictEnd = source.indexOf('tasks.push(conflictsTask.then(() => undefined));', conflictStart)
  + 'tasks.push(conflictsTask.then(() => undefined));'.length;
const run = new Function('tasks', 'fetchConflictEvents', 'ingestConflictsForCountryData', 'fetchUcdpEvents', 'hydratedUcdp', 'dataFreshness',
  source.slice(conflictStart, conflictEnd) + '\n' + closure);
const dateMs = Date.parse('2026-09-16T00:00:00Z');
const type = 'UCDP_VIOLENCE_TYPE_STATE_BASED';

for (const mapEnabled of [false, true]) {
  for (const deaths of [0, 10]) {
    test(`overlapping ACLED and UCDP claims retain attribution and totals: map=${mapEnabled}, deaths=${deaths}`, async () => {
      const row = { id: 'ucdp-1', source_original: 'UCDP source report', latitude: 12, longitude: 24,
        date_start: '2026-09-16', deaths_best: deaths };
      const comparison = { id: 'acled-1', source: 'ACLED source report', lat: 12, lon: 24,
        time: new Date(dateMs), fatalities: deaths ? 12 : 0 };
      // Counts include rows beyond the capped panel projection; overlap must not subtract from them.
      const aggregates = {[type]: {count: 80, totalDeaths: deaths * 80}};
      const hydrated = {events: [row], aggregates, dedupeIndex: [[0, dateMs, 12, 24, deaths]]};
      const intelligenceCache = {conflicts: [] as unknown[]};
      let rendered: unknown[] = [];
      let mapped: unknown[] = [];
      let ingested: unknown[] = [];
      const tasks: Promise<void>[] = [];
      run.call({ctx: {intelligenceCache, mapLayers: {ucdpEvents: mapEnabled},
        panels: {'ucdp-events': {setEvents: (...args: unknown[]) => {rendered = args;}}},
        map: {setUcdpEvents: (events: unknown[]) => {mapped = events;}}}, callbacks: {}},
      tasks, async () => ({events: [comparison], count: 1}), (events: unknown[]) => {ingested = events;},
      async (payload: unknown) => {
        assert.equal(payload, mapEnabled ? undefined : hydrated);
        return {success: true, data: [row]};
      }, hydrated, {recordUpdate() {}, recordError() {assert.fail('unexpected loader failure');}});
      await Promise.all(tasks);
      assert.deepEqual(intelligenceCache.conflicts, [comparison]);
      assert.deepEqual(ingested, [comparison]);
      assert.deepEqual(rendered, [[row], mapEnabled ? undefined : aggregates]);
      assert.deepEqual(mapped, mapEnabled ? [row] : []);
    });
  }
}

test('UCDP loading does not wait for ACLED', async () => {
  let rendered = false;
  const tasks: Promise<void>[] = [];
  run.call({ctx: {intelligenceCache: {}, mapLayers: {ucdpEvents: false},
    panels: {'ucdp-events': {setEvents: () => {rendered = true;}}}}, callbacks: {}},
  tasks, () => new Promise(() => {}), () => {}, async () => ({success: true, data: []}),
  {aggregates: {[type]: {count: 0, totalDeaths: 0}}},
  {recordUpdate() {}, recordError() {assert.fail('unexpected loader failure');}});
  await tasks[1];
  assert.equal(rendered, true);
});
