/**
 * Unit guard for the Bloomberg-terminal-style price chart util
 * (src/utils/terminal-chart.ts). It is a pure number[] -> SVG-string
 * function, so we assert on structure and on the direction-color contract
 * rather than pixels. Real math (green when rising, red when falling; HI/LO
 * labels reflect the actual extremes) so a regression in the mapping fails
 * here rather than only being caught by eye.
 *
 * Run: node --import tsx/esm --test tests/terminal-chart.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { terminalChart } from '../src/utils/terminal-chart.ts';

describe('terminalChart', () => {
  it('returns empty string for fewer than 2 finite points', () => {
    assert.equal(terminalChart(undefined), '');
    assert.equal(terminalChart([]), '');
    assert.equal(terminalChart([42]), '');
    assert.equal(terminalChart([Number.NaN, Number.POSITIVE_INFINITY]), '');
  });

  it('renders a well-formed svg for a valid series', () => {
    const svg = terminalChart([1, 2, 3, 4]);
    assert.match(svg, /^<svg /);
    assert.match(svg, /<\/svg>$/);
    assert.match(svg, /class="terminal-chart"/);
    assert.match(svg, /<path /); // area + line
    assert.match(svg, /<linearGradient /);
    // No NaN/undefined leaked into coordinates.
    assert.doesNotMatch(svg, /NaN|undefined/);
  });

  it('uses green when the series rises and red when it falls', () => {
    assert.match(terminalChart([1, 5]), /var\(--green\)/);
    assert.doesNotMatch(terminalChart([1, 5]), /var\(--red\)/);
    assert.match(terminalChart([5, 1]), /var\(--red\)/);
    assert.doesNotMatch(terminalChart([5, 1]), /var\(--green\)/);
  });

  it('lets an explicit change override the derived direction', () => {
    // Series rises but change is negative -> red wins.
    assert.match(terminalChart([1, 5], { change: -0.3 }), /var\(--red\)/);
  });

  it('labels the real high, low and last values', () => {
    const svg = terminalChart([10, 30, 20]);
    assert.match(svg, /HI 30/);
    assert.match(svg, /LO 10/);
    assert.match(svg, />20</); // last value is the closing point
  });

  it('honors width/height and a custom formatter', () => {
    const svg = terminalChart([1.111, 2.222], { width: 300, height: 120, formatValue: (v) => `$${v.toFixed(1)}` });
    assert.match(svg, /width="300"/);
    assert.match(svg, /height="120"/);
    assert.match(svg, /\$2\.2/);
  });

  it('emits a unique gradient id per call to avoid cross-chart collisions', () => {
    const idOf = (svg) => svg.match(/id="(tc-grad-\d+)"/)?.[1];
    const a = idOf(terminalChart([1, 2]));
    const b = idOf(terminalChart([1, 2]));
    assert.ok(a && b && a !== b);
  });
});
