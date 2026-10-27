import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildRegions, parseOverview, slug } from '../scripts/build-un-m49-regions.mjs';

const table = JSON.parse(readFileSync(new URL('../shared/un-m49-regions.json', import.meta.url), 'utf8'));
const outlets = JSON.parse(readFileSync(new URL('../shared/outlet-profile.json', import.meta.url), 'utf8'));

function overview(rows) {
  const header = ['Region Code', 'Region Name', 'Sub-region Code', 'Sub-region Name', 'Intermediate Region Code', 'Intermediate Region Name', 'ISO-alpha2 Code'];
  const tr = cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`;
  return `<table id = "downloadTableEN"><thead>${tr(header)}</thead><tbody>${rows.map(tr).join('')}</tbody></table>`;
}

describe('UN M49 region table', () => {
  it('puts Mexico in Latin America and the Caribbean and Central America', () => {
    assert.ok(table.regions['latin-america-and-the-caribbean'].countries.includes('MX'));
    assert.ok(table.regions['central-america'].countries.includes('MX'));
    assert.ok(!table.regions['northern-america'].countries.includes('MX'));
  });

  it('places the areas M49 omits through recorded supplements', () => {
    assert.ok(table.regions['eastern-asia'].countries.includes('TW'));
    assert.ok(table.regions['southern-europe'].countries.includes('XK'));
    assert.deepEqual(Object.keys(table.supplements).sort(), ['TW', 'XK']);
  });

  it('assigns every outlet home country to a sub-region', () => {
    const subRegions = Object.values(table.regions).filter(region => region.level === 'sub-region');
    const covered = new Set(subRegions.flatMap(region => region.countries));
    const homes = new Set(Object.values(outlets).map(profile => profile.country).filter(code => /^[A-Z]{2}$/.test(code) && code !== 'EU'));
    assert.deepEqual([...homes].filter(code => !covered.has(code)), []);
  });

  it('parses the UNSD table and keeps every level of grouping', () => {
    const regions = buildRegions(parseOverview(overview([
      ['019', 'Americas', '419', 'Latin America and the Caribbean', '013', 'Central America', 'MX'],
      ['002', 'Africa', '015', 'Northern Africa', '', '', 'EG'],
      ['142', 'Asia', '030', 'Eastern Asia', '', '', 'CN'],
      ['150', 'Europe', '039', 'Southern Europe', '', '', 'IT'],
    ])));
    assert.deepEqual(regions['central-america'], { code: '013', name: 'Central America', level: 'intermediate-region', countries: ['MX'] });
    assert.deepEqual(regions['northern-africa'].countries, ['EG']);
    assert.deepEqual(regions['eastern-asia'].countries, ['CN', 'TW']);
  });

  it('decodes each entity once and leaves no markup in names', () => {
    const [australia, fiji] = parseOverview(overview([
      ['009', 'Oceania', '053', 'Australia &amp;quot;and&amp;quot; New&nbsp;Zealand', '', '', 'AU'],
      ['009', 'Oceania', '054', 'Melanesia<script', '', '', 'FJ'],
    ]));
    assert.equal(australia.groups[1][1], 'Australia &quot;and&quot; New Zealand');
    assert.equal(fiji.groups[1][1], 'Melanesiascript');
  });

  it('fails loudly when the source page changes shape', () => {
    assert.throws(() => parseOverview('<html></html>'), /English download table/);
    assert.throws(() => parseOverview('<table id = "downloadTableEN"><tr><td>Country</td></tr></table>'), /Region Code/);
    assert.equal(slug("Côte d'Ivoire"), 'cote-d-ivoire');
  });
});
