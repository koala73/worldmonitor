import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { orderMacroSections } from '../scripts/_macro-bundle-order.mjs';
import { claimBundleTurn, acknowledgeBundleTurn } from '../scripts/_bundle-turn.mjs';
import { BUNDLE_PREFLIGHT_HEADROOM_MS, KILL_GRACE_MS } from '../scripts/_bundle-runner.mjs';
import { extractBundleSections, resolveExpr } from './helpers/bundle-section-parser.mjs';

const source = readFileSync(new URL('../scripts/seed-bundle-macro.mjs', import.meta.url), 'utf8');
const macro = extractBundleSections(source).filter(s => !['Physical-Premiums', 'Education-Attainment'].includes(s.label))
  .map(s => ({ label: s.label, timeoutMs: resolveExpr(source, s.timeoutMsExpr) }));
const physical = { label: 'Physical', timeoutMs: 480_000 };
const education = { label: 'Education', timeoutMs: 300_000 };
const retry = new Date('2026-11-05T09:00:00Z');

test('each macro source receives an admissible lead slot even if every earlier due job always times out', () => {
  const foodSources = JSON.parse(readFileSync(new URL('../shared/food-price-sources.json', import.meta.url)));
  assert.equal(macro.filter(s => s.label.startsWith('Food-')).length, foodSources.length);
  const admitted = new Set();
  for (let turn = 0; turn < macro.length; turn++) {
    const ordered = orderMacroSections(retry, education, physical, macro, turn);
    assert.equal(new Set(ordered).size, macro.length + 2);
    assert.equal(ordered[1], physical);
    assert.equal(ordered.at(-1), education);
    let elapsed = BUNDLE_PREFLIGHT_HEADROOM_MS;
    for (const section of ordered) {
      const worstCase = section.timeoutMs + KILL_GRACE_MS;
      if (elapsed + worstCase > 570_000) continue;
      elapsed += worstCase;
      admitted.add(section.label);
    }
    assert.ok(admitted.has(ordered[0].label), 'never-seeded lead fits the budget without relying on fetchedAt');
  }
  for (const section of macro) assert.ok(admitted.has(section.label), section.label);
  assert.equal(orderMacroSections(retry, education, physical, macro, macro.length)[0], macro[0]);
});

test('08:00 keeps daily Physical and Sunday Education priority independently of the retry cursor', () => {
  assert.equal(orderMacroSections(new Date('2026-11-05T08:00:00Z'), education, physical, macro)[0], physical);
  assert.equal(orderMacroSections(new Date('2026-11-08T08:00:00Z'), education, physical, macro)[0], education);
  for (const invalid of [-1, NaN, 0.5]) assert.throws(() => orderMacroSections(retry, education, physical, macro, invalid));
});

test('macro retries persist their turn and acknowledge completed failures through the runner hook', async () => {
  const commands = [];
  const options = { credentials: { restUrl: 'https://redis.example', token: 'fixture' }, token: 'macro-turn',
    fetchImpl: async (_url, init) => {
      commands.push(JSON.parse(init.body));
      return Response.json({ result: commands.length === 1 ? [1, '17'] : 1 });
    },
  };
  const claim = await claimBundleTurn('macro', options);
  assert.deepEqual(claim, { turn: 17, token: 'macro-turn' });
  assert.deepEqual(commands[0].slice(3, 5), ['bundle:turn:macro', 'bundle:turn:macro:lease']);
  assert.equal(await acknowledgeBundleTurn('macro', claim, options), true);
  assert.deepEqual(commands[1].slice(3, 5), commands[0].slice(3, 5));
  assert.match(source, /getUTCHours\(\) === 9/);
  assert.match(source, /onTerminalComplete:[\s\S]+acknowledgeBundleTurn\('macro', claim\)/);
});
