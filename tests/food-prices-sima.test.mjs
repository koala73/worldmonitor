import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collect, parseSima, simaBulletins, simaWeekEnd } from '../scripts/lib/food-prices-adapters/sima.mjs';

const pages = () => JSON.parse(readFileSync(new URL('./fixtures/food-prices/sima.json', import.meta.url), 'utf8'));
const find = (rows, item, market) => rows.find(row => row.item === item && row.market === market);
const TITLE = 'BULLETIN HEBDO des céréales N° 873 Semaine N°43 du Mercredi 21 au Mardi 27 octobre 2026';
const link = (id, title) => `https://simaniger.net/_api/publications/bulletins/${id}/download?titre=${encodeURIComponent(title)}&category_label=x`;

test('SIMA keeps national cereal averages and market bag prices in published units', () => {
  const rows = parseSima(pages(), '2026-10-27');
  assert.deepEqual(find(rows, 'Millet', 'National average'),
    { item: 'Millet', market: 'National average', marketType: 'wholesale', unit: '100 kg bag', currency: 'XOF', date: '2026-10-27', price: 21708, origin: '' });
  assert.equal(find(rows, 'Rice (imported)', 'National average').price, 11516);
  assert.equal(find(rows, 'Rice (imported)', 'National average').unit, '25 kg bag');
  assert.equal(find(rows, 'Sorghum', "Birni N'Gaoure").price, 20000);
  assert.equal(find(rows, 'Maize', 'Niamey Haro Banda').price, 17000);
  assert.equal(find(rows, 'Sorghum', 'Iferouane'), undefined);
  assert.ok(!rows.some(row => /moyenne/i.test(row.market)));
  assert.ok(rows.every(row => row.price > 0 && row.currency === 'XOF' && row.date === '2026-10-27'));
});

test('SIMA rejects mismatched dates and changed table layouts', () => {
  assert.throws(() => parseSima(pages(), '2026-10-20'), /sima report date mismatch/);
  const renamed = pages();
  renamed[4].find(item => item.text === 'SORGHO').text = 'NIEBE';
  assert.throws(() => parseSima(renamed), /sima cereal table columns changed/);
  const truncated = pages();
  truncated[5] = truncated[5].filter(item => !/MOYENNE NATIONALE/.test(item.text));
  assert.throws(() => parseSima(truncated), /national average row missing/);
  assert.throws(() => parseSima([[{ text: 'Erreur 500', x: 0, y: 0 }]]), /sima cereal bulletin format changed/);
  const shifted = pages();
  const localites = shifted[4].find(item => item.text === 'LOCALITES');
  shifted[4].push({ text: 'N°', x: localites.x - 20, y: localites.y });
  assert.throws(() => parseSima(shifted), /sima cereal table header missing/);
  assert.equal(simaWeekEnd('SEMAINE N°40 DU MERCREDI 30 SEPTEMBRE AU MARDI 06 FEV 2026'), '');
  assert.equal(simaWeekEnd('SEMAINE N°40 DU MERCREDI 30 SEPTEMBRE AU MARDI 06 OCTOBRE 2026'), '2026-10-06');
});

test('SIMA bulletin discovery keeps weekly cereal bulletins by week-ending date', () => {
  const reports = simaBulletins([
    { url: link(74, 'BULLETIN HEBDOMADAIRE FRUITS ET LEGUMES N°720 VOLET Semaine N°43 du Mercredi 21 au Mardi 27 octobre 2026') },
    { url: link(66, 'BULLETIN HEBDO des céréales N° 870 Semaine N°40 du Mercredi 30 Septembre au Mardi 06 octobre 2026') },
    { url: link(73, TITLE) },
  ]);
  assert.deepEqual(reports.map(report => [report.date, report.url]), [
    ['2026-10-27', 'https://simaniger.net/_api/publications/bulletins/73/download'],
    ['2026-10-06', 'https://simaniger.net/_api/publications/bulletins/66/download'],
  ]);
});

test('SIMA collect downloads one bulletin per run', async () => {
  const fetched = [];
  const result = await collect({
    now: new Date('2026-11-01T06:00:00Z'),
    dated: (date, offset) => new Date(date.getTime() + offset * 86400000).toISOString().slice(0, 10),
    links: () => [{ url: link(73, TITLE) }, { url: link(71, 'BULLETIN HEBDO des céréales N° 872 Semaine N°42 du Mercredi 14 au Mardi 20 octobre 2026') }],
    pdfPages: async () => pages(),
    warn: () => {},
    get: async url => { fetched.push(url); return ''; },
  });
  assert.equal(fetched.length, 2);
  assert.equal(fetched[1], 'https://simaniger.net/_api/publications/bulletins/73/download');
  assert.deepEqual(result.refreshedReports, [{ date: '2026-10-27' }]);
  assert.equal(result.observations.length, parseSima(pages()).length);
});
