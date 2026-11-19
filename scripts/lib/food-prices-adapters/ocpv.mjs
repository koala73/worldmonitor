import { firstIndex, isoDate, nearest } from '../food-prices.mjs';

const BASE = 'https://www.ocpv-ci.com/';
const FR_MONTHS = ['JANVIER', 'FEVRIER', 'MARS', 'AVRIL', 'MAI', 'JUIN', 'JUILLET', 'AOUT', 'SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE', 'DECEMBRE'];
const ITEMS = {
  'mais grain': 'Maize (grain)', mil: 'Millet',
  'riz importe de grande consommation': 'Rice (imported, ordinary)', 'riz local blanchi': 'Rice (local, milled)',
  'banane plantain': 'Plantain', 'igname assawa': 'Yam (assawa)', 'igname kponan': 'Yam (kponan)',
  'igname bete-bete': 'Yam (bêtê-bêtê)', 'igname klingle': 'Yam (klinglè)', 'gombo frais "baoule"': 'Okra (fresh, baoulé)',
  'manioc doux': 'Cassava (sweet)', 'pomme de terre': 'Potato',
  "aubergine n'drowa": "Eggplant (n'drowa)", 'aubergine violette': 'Eggplant (purple)', carotte: 'Carrot',
  'chou vert': 'Cabbage (green)', 'gombo frais "dioula"': 'Okra (fresh, dioula)',
  'oignon "violet de galmi"': 'Onion (Galmi purple)', 'oignon hollande': 'Onion (Dutch)',
  'piment frais ordinaire': 'Chili pepper (fresh)', 'tomate sodefel': 'Tomato (SODEFEL)',
  'arachide decortiquee': 'Groundnut (shelled)', 'graine de palme ordinaire': 'Palm nut (ordinary)',
  'viande de boeuf avec os': 'Beef (bone-in)', 'viande de boeuf sans os': 'Beef (boneless)',
  'poisson congele carpe noire': 'Frozen fish (black carp)', 'poisson congele chinchard': 'Frozen fish (horse mackerel)',
  'poisson congele maquereau': 'Frozen fish (mackerel)', 'poisson congele thon': 'Frozen fish (tuna)',
};

const fold = text => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/g, 'oe').replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
const tidy = text => text.replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();
const itemName = label => ITEMS[fold(tidy(label)).toLowerCase()] ?? tidy(label);
const titleWord = (word, index) => {
  if (word !== word.toUpperCase() || word.length < 2) return word;
  const lower = word.toLowerCase();
  if (index > 0 && lower === 'de') return lower;
  const cased = lower.replace(/(^|['’-])(\p{L})/gu, (_, before, letter) => before + letter.toUpperCase());
  return index > 0 && /^d['’]/.test(lower) ? `d${cased.slice(1)}` : cased;
};
const regionName = text => tidy(text).replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+/g, ' ').trim()
  .split(' ').map(titleWord).join(' ');

export function ocpvRows(items) {
  const rows = [];
  for (const item of [...items].filter(item => item.text.trim()).sort((a, b) => b.y - a.y || a.x - b.x)) {
    // Items arrive by descending y and rows sit more than 1.5 apart, so only the newest row can match.
    let row = rows.at(-1);
    if (!row || Math.abs(row.y - item.y) >= 1.5) rows.push(row = { y: item.y, items: [] });
    row.items.push(item);
  }
  return rows.map(row => ({ ...row, items: row.items.sort((a, b) => a.x - b.x) }));
}

function weekEnds(text) {
  const pattern = /SEMAINE ALLANT DU\s+([\d\s]{1,5}?)\s*(?:([A-Z]+)\s+(?:(\d{4})\s+)?)?AU\s+([\d\s]{1,5}?)\s*([A-Z]+)\s+(\d{4})/g;
  return [...fold(text).toUpperCase().matchAll(pattern)].map(match =>
    isoDate(match[6], FR_MONTHS.indexOf(match[5]) + 1, match[4].replace(/\s/g, '')));
}

export function ocpvReportDate(pages) {
  const dates = weekEnds(pages.flat().map(item => item.text).join(' '));
  if (!dates.length || dates.some(date => !date)) throw new Error('ocpv report date missing');
  if (dates.some(date => date !== dates[0])) throw new Error('ocpv report date mismatch');
  return dates[0];
}

export function parseOcpv(pages) {
  const text = fold(pages.flat().map(item => item.text).join(' ')).toUpperCase();
  if (!text.includes('PRIX A LA CONSOMMATION') || !/UNITE\s*:\s*F CFA\/KG/.test(text) || !text.includes('SPECULATIONS')) throw new Error('ocpv food PDF format changed');
  const date = ocpvReportDate(pages);
  const result = [];
  for (const items of pages) {
    const rows = ocpvRows(items);
    const headers = rows.filter(row => row.items.some(item => item.text === 'moy'));
    // Region names sorted once by height; rows already run top to bottom. Each header then takes its
    // band by binary search instead of rescanning the page.
    const nameItems = items.filter(item => item.x >= 200 && !/^(?:Prix|SPECULATIONS)$/.test(item.text)).sort((a, b) => a.y - b.y);
    for (const [index, header] of headers.entries()) {
      const labels = header.items.map(item => item.text);
      if (labels.length % 3 || labels.some((label, i) => label !== ['mini', 'maxi', 'moy'][i % 3])) throw new Error('ocpv food PDF column layout changed');
      const triples = [];
      for (let i = 0; i < header.items.length; i += 3) triples.push({ columns: header.items.slice(i, i + 3), names: [] });
      const tripleCenter = triple => (triple.columns[0].x + triple.columns[2].x) / 2;
      for (let i = firstIndex(nameItems, item => item.y > header.y + 15); i < nameItems.length && nameItems[i].y < header.y + 55; i++) {
        const item = nameItems[i];
        nearest(triples, tripleCenter, item.x + item.text.length * 2.4).names.push(item);
      }
      if (triples.some(triple => !triple.names.length)) throw new Error('ocpv food PDF region header changed');
      for (const triple of triples) triple.market = regionName(triple.names.sort((a, b) => b.y - a.y || a.x - b.x).map(item => item.text).join(' '));
      const columns = triples.flatMap(triple => triple.columns.map((column, i) => ({ x: column.x, triple, moy: i === 2 })));
      const next = headers[index + 1];
      for (let r = firstIndex(rows, row => row.y < header.y - 5); r < rows.length && (!next || rows[r].y > next.y + 55); r++) {
        const row = rows[r];
        const label = row.items.filter(item => item.x < 200).map(item => item.text).join(' ').trim();
        const numbers = row.items.filter(item => item.x >= 200).reduce((merged, item) => {
          const last = merged.at(-1);
          // Word sometimes splits one figure into adjacent text runs ("300" + "0").
          if (last && /^\d+$/.test(last.text + item.text) && item.x - last.x < last.text.length * 4.6 + 2) merged[merged.length - 1] = { ...last, text: last.text + item.text };
          else merged.push(item);
          return merged;
        }, []);
        if (!label || !numbers.length || numbers.some(number => !/^\d+$/.test(number.text))) continue;
        for (const number of numbers) {
          const column = nearest(columns, column => column.x, number.x);
          if (Math.abs(column.x - number.x) > 12) throw new Error('ocpv food PDF column layout changed');
          const price = Number(number.text);
          if (column.moy && price > 0) result.push({ item: itemName(label), market: column.triple.market, marketType: 'retail', unit: 'kg', currency: 'XOF', date, price, origin: '' });
        }
      }
    }
  }
  if (!result.length) throw new Error('ocpv food PDF has no prices');
  return result;
}

export const sameTable = (a, b) => {
  const prices = rows => new Map(rows.map(row => [`${row.item}|${row.market}`, row.price]));
  const left = prices(a);
  const right = prices(b);
  return left.size === right.size && [...left].every(([key, price]) => right.get(key) === price);
};

export function ocpvFolderReports(html, base) {
  return [...html.matchAll(/href=["']([^"'?]+\.pdf)["']/gi)].flatMap(match => {
    const parts = /(\d{2})_(\d{2})_AU_(\d{2})_(\d{2})_(\d{4})\.pdf$/i.exec(match[1]);
    return parts ? [{ url: new URL(match[1], base).href, start: [parts[2], parts[1]], end: [parts[5], parts[4], parts[3]] }] : [];
  });
}

export async function collect(ctx) {
  const latestLink = ctx.links(await ctx.get(BASE), BASE).find(link => /\/doc\/prix_consomation\/\d{4}\/[^/]+\.pdf$/i.test(new URL(link.url).pathname));
  if (!latestLink) throw new Error('ocpv weekly price PDF link missing');
  const read = async url => parseOcpv(await ctx.pdfPages(await ctx.get(url, { binary: true })));
  const folders = new Map();
  const reportFor = async date => {
    const year = date.slice(0, 4);
    const folder = `${BASE}doc/prix_consomation/${year}/`;
    if (!folders.has(year)) folders.set(year, ocpvFolderReports(await ctx.get(folder), folder));
    const start = ctx.dated(new Date(`${date}T00:00:00Z`), -6);
    const exact = report => report.end.join('-') === date && report.start.join('-') === start.slice(5);
    const days = report => report.end[2] === date.slice(8) && report.start[1] === start.slice(8) && report.end[0] === year;
    for (const report of [...folders.get(year).filter(exact), ...folders.get(year).filter(report => !exact(report) && days(report))].slice(0, 2)) {
      const rows = await read(report.url);
      if (rows[0].date === date) return { url: report.url, rows };
    }
    throw new Error(`ocpv report for ${date} not found`);
  };
  const latest = { url: latestLink.url, rows: await read(latestLink.url) };
  const latestDate = latest.rows[0].date;
  if (latestDate > ctx.dated(ctx.now, 0)) throw new Error('ocpv report date is in the future');
  const optional = async date => {
    try { return await reportFor(date); } catch (error) {
      ctx.warn(`prior-week report unavailable: ${error.message}`);
      return null;
    }
  };
  let reports = [latest];
  const prior = await optional(ctx.dated(new Date(`${latestDate}T00:00:00Z`), -7));
  if (prior && sameTable(latest.rows, prior.rows)) {
    ctx.warn(`report ${latestDate} repeats the ${prior.rows[0].date} table; publishing ${prior.rows[0].date} only`);
    const baseline = await optional(ctx.dated(new Date(`${prior.rows[0].date}T00:00:00Z`), -7));
    reports = [prior, baseline].filter(Boolean);
  } else if (prior) reports.push(prior);
  return {
    observations: reports.flatMap(report => report.rows),
    refreshedReports: reports.map(report => ({ date: report.rows[0].date })),
    reportUrl: reports[0].url,
  };
}
