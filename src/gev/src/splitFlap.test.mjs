import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planSplitFlap,
  visibleGlyphs,
  FLAP_CHAR_MS,
  FLAP_STAGGER_MS,
  FLAP_MAX_TOTAL_MS,
  FLAP_TURN_RATIO,
  SPLIT_FLAP_ENABLED,
} from './splitFlap.js';

const settledText = (plan) => plan.cells.map((cell) => cell.to).join('');
const flapping = (plan) => plan.cells.filter((cell) => cell.changed);

test('identical text plans no work at all — the tickers must not restart it', () => {
  const plan = planSplitFlap('LOAD COMPLETE', 'LOAD COMPLETE');
  assert.equal(plan.changedCount, 0);
  assert.equal(plan.cells.length, 0);
  assert.equal(plan.durationMs, 0);
  assert.equal(plan.firstChanged, -1);
});

test('a settled cell keeps its glyph and never animates', () => {
  // "LOAD" survives the transition, so those four cells hold still — the way
  // a real split-flap cell that already shows the right letter does not move.
  const plan = planSplitFlap('LOADING LIVE DATA', 'LOAD COMPLETE');
  const held = plan.cells.slice(0, 4);
  assert.deepEqual(held.map((cell) => cell.to), ['L', 'O', 'A', 'D']);
  assert.ok(held.every((cell) => cell.changed === false));
  assert.ok(held.every((cell) => cell.delayMs === 0));
  // "LOADING" still has its I where "LOAD COMPLETE" has a space, so column 4
  // is the first that has to move.
  assert.equal(plan.firstChanged, 4);
  assert.equal(plan.cells[4].delayMs, 0);
});

test('the concatenated cells are exactly the target string — DOM text stays the truth', () => {
  const cases = [
    ['LOADING LIVE DATA', 'LOAD COMPLETE'],
    ['loading frames', 'camera grid ready'],
    ['', 'LOAD FAILED'],
    ['TURNING OFF LIVE DATA', ''],
    ['LIVE · TomTom flow · 87% cov', 'SIMULATED — add TomTom key for live'],
  ];
  for (const [from, to] of cases) {
    assert.equal(settledText(planSplitFlap(from, to)), to, `${from} -> ${to}`);
  }
});

test('the cascade sweeps left to right, rebased on the first changed column', () => {
  const plan = planSplitFlap('AAAA', 'BBBB');
  assert.deepEqual(plan.cells.map((cell) => cell.delayMs), [
    0,
    FLAP_STAGGER_MS,
    FLAP_STAGGER_MS * 2,
    FLAP_STAGGER_MS * 3,
  ]);
  // Rebasing matters: a stable head must not idle through untouched columns.
  const rebased = planSplitFlap('LOAD XX', 'LOAD YY');
  assert.equal(rebased.firstChanged, 5);
  assert.equal(rebased.cells[5].delayMs, 0);
  assert.equal(rebased.cells[6].delayMs, FLAP_STAGGER_MS);
});

test('every real chip transition finishes well under a second', () => {
  const transitions = [
    ['LOADING LIVE DATA', 'LOAD COMPLETE'],
    ['LOADING LIVE DATA', 'LOAD FAILED'],
    ['REFRESHING LIVE DATA', 'LOAD CANCELLED'],
    ['TURNING OFF LIVE DATA', 'LIVE DATA OFF'],
    ['loading frames', 'camera grid ready'],
    ['syncing road network', 'LIVE · TomTom flow · 100% cov'],
    ['SIMULATED — traffic service unreachable', 'LIVE · TomTom flow · 42% cov'],
  ];
  for (const [from, to] of transitions) {
    const plan = planSplitFlap(from, to);
    assert.ok(
      plan.durationMs <= FLAP_MAX_TOTAL_MS,
      `${from} -> ${to} ran ${plan.durationMs}ms, over the ${FLAP_MAX_TOTAL_MS}ms budget`,
    );
    assert.ok(plan.durationMs > 0);
  }
});

test('long labels compress their stagger instead of running past the budget', () => {
  const long = planSplitFlap('x'.repeat(80), 'y'.repeat(80));
  assert.ok(long.durationMs <= FLAP_MAX_TOTAL_MS);
  assert.ok(long.staggerMs < FLAP_STAGGER_MS, 'stagger should compress');
  // Still a cascade, not a single simultaneous snap.
  assert.ok(long.staggerMs > 0);
  assert.ok(long.cells.at(-1).delayMs > long.cells[0].delayMs);
});

test('a short label keeps the full, unhurried stagger', () => {
  const plan = planSplitFlap('AB', 'CD');
  assert.equal(plan.staggerMs, FLAP_STAGGER_MS);
  assert.equal(plan.durationMs, FLAP_STAGGER_MS + FLAP_CHAR_MS);
});

test('a single changed character has no stagger and takes exactly one char time', () => {
  const plan = planSplitFlap('LOAD COMPLETE', 'LOAD COMPLETEX');
  assert.equal(plan.changedCount, 1);
  assert.equal(plan.staggerMs, 0);
  assert.equal(plan.durationMs, FLAP_CHAR_MS);
});

test('a shrinking label marks its surplus columns vacating', () => {
  const plan = planSplitFlap('TURNING OFF LIVE DATA', 'LIVE DATA OFF');
  const vacating = plan.cells.filter((cell) => cell.vacating);
  assert.equal(vacating.length, 'TURNING OFF LIVE DATA'.length - 'LIVE DATA OFF'.length);
  // Vacating cells carry an outgoing glyph but contribute nothing to the text;
  // their width is zero, and the container width transition covers the shrink.
  assert.ok(vacating.every((cell) => cell.to === '' && cell.from !== ''));
  assert.equal(settledText(plan), 'LIVE DATA OFF');
});

test('a growing label flaps its new columns in with no outgoing glyph', () => {
  const plan = planSplitFlap('LOAD', 'LOAD COMPLETE');
  const grown = plan.cells.slice(4);
  assert.ok(grown.every((cell) => cell.from === '' && cell.changed));
  assert.ok(grown.every((cell) => cell.vacating === false));
  assert.equal(settledText(plan), 'LOAD COMPLETE');
});

test('cell width covers the longer of the two strings', () => {
  assert.equal(planSplitFlap('ABC', 'AB').cells.length, 3);
  assert.equal(planSplitFlap('AB', 'ABC').cells.length, 3);
});

test('multi-byte separators stay one cell, never split into surrogate halves', () => {
  const plan = planSplitFlap('A · B', 'A · C');
  assert.ok(plan.cells.every((cell) => Array.from(cell.to).length <= 1));
  assert.equal(settledText(plan), 'A · C');
  // An astral character must occupy exactly one flap cell.
  const astral = planSplitFlap('', '\u{1F6EB}');
  assert.equal(astral.cells.length, 1);
  assert.equal(astral.cells[0].to, '\u{1F6EB}');
});

test('null and undefined are treated as empty, never stringified into the chip', () => {
  assert.equal(settledText(planSplitFlap(null, 'READY')), 'READY');
  assert.equal(planSplitFlap(undefined, undefined).changedCount, 0);
  assert.equal(settledText(planSplitFlap('READY', null)), '');
});

test('option overrides drive both the stagger and the budget', () => {
  const plan = planSplitFlap('AAAA', 'BBBB', { charMs: 100, staggerMs: 10, maxTotalMs: 1000 });
  assert.deepEqual(plan.cells.map((cell) => cell.delayMs), [0, 10, 20, 30]);
  assert.equal(plan.durationMs, 130);
  // Invalid overrides fall back to the defaults rather than producing NaN.
  const guarded = planSplitFlap('AB', 'CD', { charMs: 0, staggerMs: -5, maxTotalMs: NaN });
  assert.equal(guarded.durationMs, FLAP_STAGGER_MS + FLAP_CHAR_MS);
});

test('delays are whole milliseconds so the CSS custom property stays clean', () => {
  const plan = planSplitFlap('x'.repeat(37), 'y'.repeat(37));
  assert.ok(plan.cells.every((cell) => Number.isInteger(cell.delayMs)));
  assert.ok(Number.isInteger(plan.durationMs));
});

test('no cell is ever scheduled to start after the cascade has ended', () => {
  const plan = planSplitFlap('syncing road network', 'LIVE · TomTom flow · 100% cov');
  for (const cell of flapping(plan)) {
    assert.ok(
      cell.delayMs + FLAP_CHAR_MS <= plan.durationMs + 1,
      `cell ${cell.index} lands after the reported duration`,
    );
  }
});

test('the feature ships enabled behind a single flippable constant', () => {
  assert.equal(typeof SPLIT_FLAP_ENABLED, 'boolean');
  assert.equal(SPLIT_FLAP_ENABLED, true);
});

// ── Interrupted cascades: only what was visible may flap away ──────────────

test('at the start of a cascade the board still reads the old label', () => {
  const plan = planSplitFlap('LOADING LIVE DATA', 'LOAD COMPLETE');
  assert.equal(visibleGlyphs(plan, 0), 'LOADING LIVE DATA');
});

test('once the cascade is over the board reads the new label', () => {
  const plan = planSplitFlap('LOADING LIVE DATA', 'LOAD COMPLETE');
  const landed = visibleGlyphs(plan, plan.durationMs + 1000);
  // The cleared columns are still ON the board as blanks until settlement
  // strips them — that is what stops columns renumbering mid-flight.
  assert.equal(landed.trimEnd(), 'LOAD COMPLETE');
  assert.equal(landed.length, 'LOADING LIVE DATA'.length);
});

test('a column turns over at its own delay, not the cascade start', () => {
  const plan = planSplitFlap('AAAA', 'BBBB');
  const turn = FLAP_CHAR_MS * FLAP_TURN_RATIO;
  // Just after column 0 turns, only column 0 has changed.
  assert.equal(visibleGlyphs(plan, turn + 1), 'BAAA');
  // Just after column 2's delay + turn, three columns have.
  assert.equal(visibleGlyphs(plan, FLAP_STAGGER_MS * 2 + turn + 1), 'BBBA');
});

test('an interrupted cascade never flaps away a glyph that was never on screen', () => {
  // A -> B interrupted mid-stagger by C. This is the ghost-glyph pin.
  const A = 'LOADING LIVE DATA';
  const B = 'LOAD COMPLETE';
  const C = 'LOAD FAILED';
  const first = planSplitFlap(A, B);
  const interruptAt = 150; // mid-stagger: some columns turned, others have not

  const displayed = visibleGlyphs(first, interruptAt);
  const aChars = Array.from(A);
  const bChars = Array.from(B);
  const shown = Array.from(displayed);

  // Every visible glyph is either the old label's or the new one's, per column.
  // A column the new label does not reach reads as a reserved blank.
  shown.forEach((glyph, index) => {
    const candidates = [aChars[index] || ' ', bChars[index] || ' '];
    assert.ok(
      candidates.includes(glyph),
      `column ${index} shows ${JSON.stringify(glyph)}, which is neither `
        + `${JSON.stringify(candidates[0])} nor ${JSON.stringify(candidates[1])}`,
    );
  });

  // The interrupting cascade flaps away exactly those visible glyphs.
  const second = planSplitFlap(displayed, C);
  second.cells.forEach((cell) => {
    assert.equal(
      cell.from,
      shown[cell.index] ?? '',
      `column ${cell.index} would flap away a glyph that was not on screen`,
    );
  });

  // And this genuinely differs from the naive "flap away the pending target"
  // approach — otherwise the pin would pass without the fix.
  const naive = planSplitFlap(B, C);
  const naiveFrom = naive.cells.map((cell) => cell.from).join('');
  const honestFrom = second.cells.map((cell) => cell.from).join('');
  assert.notEqual(honestFrom, naiveFrom);
  assert.equal(honestFrom, displayed);
});

test('interrupting before anything turned flaps away the ORIGINAL label', () => {
  const first = planSplitFlap('LOADING LIVE DATA', 'LOAD COMPLETE');
  // Nothing has reached its turn point yet.
  const displayed = visibleGlyphs(first, 0);
  const second = planSplitFlap(displayed, 'LOAD FAILED');
  assert.equal(second.cells.map((cell) => cell.from).join(''), 'LOADING LIVE DATA');
});

test('interrupting after the cascade landed flaps away the settled label', () => {
  const first = planSplitFlap('LOADING LIVE DATA', 'LOAD COMPLETE');
  const displayed = visibleGlyphs(first, 10_000);
  assert.equal(displayed.trimEnd(), 'LOAD COMPLETE');
  const second = planSplitFlap(displayed, 'LOAD FAILED');
  assert.equal(second.cells.map((cell) => cell.from).join(''), displayed);
});

test('a shrinking cascade shows its surplus glyphs until each column turns', () => {
  const plan = planSplitFlap('TURNING OFF LIVE DATA', 'LIVE DATA OFF');
  assert.equal(visibleGlyphs(plan, 0), 'TURNING OFF LIVE DATA');
  // Mid-cascade the tail columns still carry the old glyphs.
  assert.ok(visibleGlyphs(plan, 120).trimEnd().length > 'LIVE DATA OFF'.length);
  assert.equal(visibleGlyphs(plan, plan.durationMs + 100).trimEnd(), 'LIVE DATA OFF');
});

// ── Positional truth: columns never renumber mid-cascade ──────────────────

test('a cleared column holds its place instead of letting later glyphs slide left', () => {
  // The revert-proof pin. If a cleared column collapsed to nothing, this
  // sampling would catch "ABCD" -> "ABD" and D sitting in column 2.
  const plan = planSplitFlap('ABCD', 'AB');
  const samples = [];
  for (let t = 0; t <= plan.durationMs + 50; t += 5) samples.push(visibleGlyphs(plan, t));

  for (const sample of samples) {
    const columns = Array.from(sample);
    assert.equal(
      columns.length,
      plan.cells.length,
      `board width changed mid-cascade: ${JSON.stringify(sample)}`,
    );
    assert.notEqual(columns[2], 'D', `D slid into column 2: ${JSON.stringify(sample)}`);
    if (columns.includes('D')) {
      assert.equal(columns[3], 'D', `D left column 3: ${JSON.stringify(sample)}`);
    }
    if (columns.includes('C')) {
      assert.equal(columns[2], 'C', `C left column 2: ${JSON.stringify(sample)}`);
    }
  }

  assert.equal(samples[0], 'ABCD');
  assert.equal(samples.at(-1), 'AB  ');
});

test('every column keeps its index for the whole cascade, growing or shrinking', () => {
  for (const [from, to] of [
    ['LOADING LIVE DATA', 'LOAD COMPLETE'],
    ['LOAD', 'LOAD COMPLETE'],
    ['TURNING OFF LIVE DATA', 'LIVE DATA OFF'],
    ['', 'LOAD FAILED'],
  ]) {
    const plan = planSplitFlap(from, to);
    const widths = new Set();
    for (let t = 0; t <= plan.durationMs + 50; t += 7) {
      widths.add(Array.from(visibleGlyphs(plan, t)).length);
    }
    assert.deepEqual(
      [...widths],
      [plan.cells.length],
      `${from} -> ${to} changed column count mid-cascade`,
    );
  }
});

test('an interrupt mid-shrink flaps away the blanks and glyphs actually on screen', () => {
  const first = planSplitFlap('ABCD', 'AB');
  const turn = FLAP_CHAR_MS * FLAP_TURN_RATIO;
  // Sample after column 2 turns to a blank but before column 3 turns.
  const at = first.cells[2].delayMs + turn + 1;
  assert.ok(at < first.cells[3].delayMs + turn, 'sample must sit between the two turns');
  const displayed = visibleGlyphs(first, at);
  assert.equal(displayed, 'AB D');
  const second = planSplitFlap(displayed, 'ABXY');
  assert.equal(second.cells[2].from, ' ');
  assert.equal(second.cells[3].from, 'D');
});

test('visibleGlyphs is defensive about junk input', () => {
  assert.equal(visibleGlyphs(null, 100), '');
  assert.equal(visibleGlyphs({ cells: [] }, 100), '');
  const plan = planSplitFlap('AB', 'CD');
  // Negative and non-finite elapsed times read as "nothing has turned yet".
  assert.equal(visibleGlyphs(plan, -500), 'AB');
  assert.equal(visibleGlyphs(plan, NaN), 'AB');
});
