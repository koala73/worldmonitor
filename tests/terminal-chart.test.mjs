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
    assert.match(svg, /LAST 20/);
  });

  it('combines labels that share an exact high, low, or flat-series baseline', () => {
    assert.match(terminalChart([1, 2]), /HI\/LAST 2/);
    assert.match(terminalChart([2, 1]), /LO\/LAST 1/);

    const flat = terminalChart([7, 7, 7]);
    assert.match(flat, /HI\/LO\/LAST 7/);
    assert.equal([...flat.matchAll(/<text /g)].length, 1);
    const flatPoints = flat.match(/<path d="([^"]+)" fill="none"/)?.[1];
    assert.match(flatPoints, /^M8\.0,99\.0 L[\d.]+,99\.0 L[\d.]+,99\.0$/);
  });

  it('keeps near-extreme axis labels on distinct baselines', () => {
    const svg = terminalChart([0, 100, 99]);
    const baselines = [...svg.matchAll(/<text x="[^"]+" y="([^"]+)"/g)]
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);

    assert.equal(baselines.length, 3);
    assert.ok(baselines[1] - baselines[0] >= 11);
    assert.ok(baselines[2] - baselines[1] >= 11);
  });

  it('honors width/height and a custom formatter', () => {
    const svg = terminalChart([1.111, 2.222], { width: 300, height: 120, formatValue: (v) => `$${v.toFixed(1)}` });
    assert.match(svg, /width="300"/);
    assert.match(svg, /height="120"/);
    assert.match(svg, /\$2\.2/);
  });

  it('reserves more plot space for longer labels without shortening their values', () => {
    const narrow = terminalChart([90, 110, 100]);
    const wide = terminalChart([1234567890120, 1234567890125, 1234567890123.4]);
    const lastX = (svg) => Number(svg.match(/<circle cx="([^"]+)"/)?.[1]);
    assert.ok(lastX(wide) < lastX(narrow), `Long label plot end ${lastX(wide)} must precede short label plot end ${lastX(narrow)}`);
    assert.match(wide, /LAST 1234567890123\.4/);
    assert.match(wide, /<text x="452"[^>]*text-anchor="end"/);
    assert.match(terminalChart([NaN, 85233, Infinity, 86789.9, 85233]), /LAST 85233/);
  });

  it('keeps a narrow chart plot inside its requested width with long labels', () => {
    const svg = terminalChart([1234567890120, 1234567890125, 1234567890123.4], { width: 120 });
    const path = svg.match(/<path d="([^"]+)" fill="none"/)?.[1];
    const coordinates = [...path.matchAll(/[ML]([\d.-]+),/g)].map((match) => Number(match[1]));
    assert.equal(coordinates.length, 3);
    assert.ok(coordinates.every((x) => x >= 8 && x <= 112), `Plot coordinates outside the SVG: ${coordinates}`);
    assert.ok(coordinates[2] > coordinates[0], 'The plot must retain a positive width');
    assert.match(svg, /width="120"/);
    assert.match(svg, /LAST 1234567890123\.4/);
  });

  it('writes an escaped aria-label onto the svg when provided', () => {
    const svg = terminalChart([1, 2], { ariaLabel: 'AAPL price chart' });
    assert.match(svg, /<svg[^>]*aria-label="AAPL price chart"/);
    // A hostile ticker string cannot break out of the attribute context.
    const evil = terminalChart([1, 2], { ariaLabel: 'A"><script>x' });
    assert.doesNotMatch(evil, /<script>/);
    assert.match(evil, /aria-label="A&quot;&gt;&lt;script&gt;x"/);
  });

  it('omits aria-label when none is given', () => {
    assert.doesNotMatch(terminalChart([1, 2]), /aria-label=/);
  });

  it('emits a unique gradient id per call to avoid cross-chart collisions', () => {
    const idOf = (svg) => svg.match(/id="(tc-grad-\d+)"/)?.[1];
    const a = idOf(terminalChart([1, 2]));
    const b = idOf(terminalChart([1, 2]));
    assert.ok(a && b && a !== b);
  });
});
