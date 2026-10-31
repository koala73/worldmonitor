import feeds from '../shared/regional-energy-feeds.json' with { type: 'json' };
import Papa from 'papaparse';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const PT_MONTHS = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
function cleanHtml(source) {
  const parts = [];
  let at = 0;
  for (;;) {
    const open = source.indexOf('<!--', at);
    if (open < 0) { parts.push(source.slice(at)); break; }
    parts.push(source.slice(at, open));
    const close = source.indexOf('-->', open + 4);
    if (close < 0) break;
    at = close + 3;
  }
  return parts.join('');
}
const text = s => cleanHtml(String(s)).replace(/<[^<>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();

// Consume tag tokens once so missing closing tags cannot restart a body scan.
function blocks(source, names) {
  const tags = new RegExp(`<(/?)(${names})\\b([^<>]*)>`, 'gi');
  const result = [];
  let opened = null;
  for (const tag of source.matchAll(tags)) {
    const name = tag[2].toLowerCase();
    if (!opened && !tag[1]) opened = { name, attrs: tag[3], at: tag.index + tag[0].length };
    else if (opened && tag[1] && name === opened.name) {
      result.push({ attrs: opened.attrs, inner: source.slice(opened.at, tag.index) });
      opened = null;
    }
  }
  return result;
}
const cells = s => blocks(s, 'td|th').map(cell => text(cell.inner));
const rows = s => blocks(cleanHtml(s), 'tr').map(row => cells(row.inner));

function number(raw, commaDecimal = false) {
  if (typeof raw === 'number') {
    if (Number.isFinite(raw)) return raw;
    throw new Error('Non-finite energy measurement');
  }
  const s = String(raw ?? '').trim().replace(/\s/g, '');
  const normalized = commaDecimal ? s.replace(',', '.') : s.replace(/,/g, '');
  if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(normalized)) throw new Error('Invalid energy measurement');
  const n = Number(normalized);
  if (!Number.isFinite(n)) throw new Error('Non-finite energy measurement');
  return n;
}

export function periodEnd(period) {
  if (/^\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.split('-').map(Number);
    if (m < 1 || m > 12) throw new Error('Invalid energy month');
    return Date.UTC(y, m, 0, 23, 59, 59, 999);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    const ms = Date.parse(`${period}T00:00:00Z`);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== period) throw new Error('Invalid energy day');
    return ms;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(period)) throw new Error('Invalid energy timestamp');
  const ms = Date.parse(period);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== period) throw new Error('Invalid energy timestamp');
  return ms;
}

const iso = (s, offset) => {
  const value = s.includes('T') ? s : s.replace(' ', 'T');
  const result = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : value + offset);
  if (!Number.isFinite(result.getTime())) throw new Error('Invalid provider timestamp');
  return result.toISOString();
};
const observation = (metric, period, value, unit, area = '') => ({ metric, period, value: number(value), unit, area });
const required = points => {
  if (!points.length) throw new Error('No observed energy measurements');
  return points;
};

function csv(source, delimiter = ',') {
  const parsed = Papa.parse(source.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n'), { delimiter, newline: '\n', skipEmptyLines: 'greedy' });
  if (parsed.errors.length || !parsed.data.length) throw new Error('Invalid energy CSV');
  const records = parsed.data.map(row => row.map(cell => cell.trim()));
  const header = records.shift();
  if (new Set(header).size !== header.length) throw new Error('Duplicate energy CSV columns');
  return { header, records: records.map(row => {
    if (row.length !== header.length) throw new Error('Changed energy CSV columns');
    return Object.fromEntries(header.map((key, i) => [key, row[i]]));
  }) };
}

function columns(header, names) {
  if (names.some(name => !header.includes(name))) throw new Error('Missing energy source columns');
}

export function parsePgcb(html) {
  const table = blocks(cleanHtml(html), 'table').find(table => /Generation\(MW\)/.test(table.inner))?.inner;
  if (!table) throw new Error('Changed PGCB fuel table');
  let headerAt = 0;
  for (const heading of ['Gas', 'Liquid Fuel', 'Coal', 'Hydro', 'Solar', 'Wind', 'India', 'Nepal']) {
    const at = table.indexOf(heading, headerAt);
    if (at < 0) throw new Error('Changed PGCB fuel table');
    headerAt = at + heading.length;
  }
  const points = [];
  for (const row of rows(table)) {
    if (!/^\d{2}-\d{2}-\d{4}$/.test(row[0] ?? '')) continue;
    if (row.length !== 14) throw new Error('Changed PGCB row');
    const [d, m, y] = row[0].split('-');
    const period = iso(`${y}-${m}-${d}T${row[1]}`, '+06:00');
    const metrics = ['generation', 'generation.gas', 'generation.liquid_fuel', 'generation.coal', 'generation.hydro', 'generation.solar', 'generation.wind'];
    metrics.forEach((metric, i) => points.push(observation(metric, period, row[i + 2], 'MW')));
    points.push(observation('imports.india', period, number(row[9]) + number(row[10]) + number(row[11]), 'MW'));
    points.push(observation('imports.nepal', period, row[12], 'MW'));
  }
  return required(points);
}

export function parseNiso(html) {
  const spans = blocks(cleanHtml(html), 'span');
  const span = id => {
    const match = spans.find(span => new RegExp(`\\bid="MainContent_${id}"`).test(span.attrs));
    if (!match) throw new Error(`Missing NISO ${id}`);
    return text(match.inner);
  };
  const [d, m, y] = span('lblCurrentDay').split('/');
  const period = `${y}-${m}-${d}`;
  periodEnd(period);
  return [
    observation('generation.peak', period, span('lblPeakGenMostRecentDay'), 'MW'),
    observation('energy.generated', period, span('lblEnergyGeneratedMostRecentDay'), 'MWh'),
    observation('energy.sent_out', period, span('lblEnergySentOutMostRecentDay'), 'MWh'),
    observation('frequency.at_peak', period, span('lblPeakGenMostRecentFreq'), 'Hz'),
  ];
}

export function parseCammesa(demand, generation) {
  if (!Array.isArray(demand) || !Array.isArray(generation)) throw new Error('Invalid CAMMESA response');
  const points = [];
  for (const row of demand) {
    if (row.demHoy == null) continue;
    points.push(observation('demand', iso(row.fecha, '-03:00'), row.demHoy, 'MW', 'SADI'));
  }
  const map = { sumTotal: 'supply.total', hidraulico: 'generation.hydro', termico: 'generation.thermal', nuclear: 'generation.nuclear', renovable: 'generation.renewable', importacion: 'imports' };
  for (const row of generation) {
    for (const [key, metric] of Object.entries(map)) {
      if (row[key] != null) points.push(observation(metric, iso(row.fecha, '-03:00'), row[key], 'MW', 'SADI'));
    }
  }
  return required(points);
}

export function parseEskom(demandCsv, outageCsv, renewableCsv) {
  const points = [];
  const demand = csv(demandCsv);
  columns(demand.header, ['DateTimeKey', 'RSA Contracted Demand']);
  for (const row of demand.records) {
    if (!row['RSA Contracted Demand'] || number(row['RSA Contracted Demand']) === 0) continue;
    points.push(observation('demand', iso(row.DateTimeKey, '+02:00'), row['RSA Contracted Demand'], 'MW', 'RSA contracted demand'));
  }
  const outage = csv(outageCsv);
  columns(outage.header, ['Week_min_DateKey', 'Average of UCLF+OCLF']);
  for (const row of outage.records) {
    if (row['Average of UCLF+OCLF'] === '') continue;
    points.push(observation('outages.unplanned.average', row.Week_min_DateKey, row['Average of UCLF+OCLF'], 'MW', 'Eskom; week starting'));
  }
  const renew = csv(renewableCsv);
  columns(renew.header, ['Date Time Hour Beginning', 'Wind', 'PV', 'CSP', 'Other RE']);
  for (const row of renew.records) {
    if (['Wind', 'PV', 'CSP', 'Other RE'].every(k => !row[k] || number(row[k]) === 0)) continue;
    for (const [key, metric] of Object.entries({ Wind: 'wind', PV: 'solar_pv', CSP: 'solar_csp', 'Other RE': 'other_renewable' })) {
      if (row[key] !== '') points.push(observation(`generation.${metric}`, iso(row['Date Time Hour Beginning'], '+02:00'), row[key], 'MW'));
    }
  }
  return required(points);
}

export function parseOns(source) {
  const { header, records } = csv(source, ';');
  const map = { val_gerhidraulica: 'generation.hydro', val_gertermica: 'generation.thermal', val_gereolica: 'generation.wind', val_gersolar: 'generation.solar', val_carga: 'demand', val_intercambio: 'exchange.net' };
  columns(header, ['id_subsistema', 'din_instante', ...Object.keys(map)]);
  return required(records.filter(row => row.id_subsistema === 'SIN').flatMap(row => Object.entries(map).map(([key, metric]) => observation(metric, iso(row.din_instante, '-03:00'), row[key], 'MW', 'SIN'))));
}

export function parseAnpTrade(source) {
  const { header, records } = csv(source, ';');
  columns(header, ['ANO', 'MÊS', 'PRODUTO', 'OPERAÇÃO COMERCIAL', 'IMPORTADO / EXPORTADO']);
  return required(records.map(row => {
    const month = PT_MONTHS.indexOf(row['MÊS']);
    const operation = { 'IMPORTAÇÃO': 'imports', 'EXPORTAÇÃO': 'exports' }[row['OPERAÇÃO COMERCIAL']];
    if (month < 0 || !operation || !/^20\d{2}$/.test(row.ANO) || !row.PRODUTO) throw new Error('Invalid ANP trade row');
    return observation(`fuel.${operation}`, `${row.ANO}-${String(month + 1).padStart(2, '0')}`, number(row['IMPORTADO / EXPORTADO'], true), 'm3', row.PRODUTO);
  }));
}

export function parseAnpPriceRows(sheetRows) {
  const headerIndex = sheetRows.findIndex(row => row.includes('PREÇO MÉDIO REVENDA') && row.includes('PRODUTO'));
  if (headerIndex < 0) throw new Error('Missing ANP price header');
  const header = sheetRows[headerIndex];
  const cell = (row, key) => row[header.indexOf(key)];
  columns(header, ['DATA FINAL', 'BRASIL', 'PRODUTO', 'UNIDADE DE MEDIDA', 'PREÇO MÉDIO REVENDA']);
  return required(sheetRows.slice(headerIndex + 1).filter(row => cell(row, 'BRASIL') === 'BRASIL').map(row => {
    const date = cell(row, 'DATA FINAL');
    const period = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
    periodEnd(period);
    const unit = String(cell(row, 'UNIDADE DE MEDIDA')).replace('R$', 'BRL');
    if (!['BRL/l', 'BRL/13kg', 'BRL/m³'].includes(unit)) throw new Error('Unknown ANP price unit');
    return observation('fuel.retail_price', period, cell(row, 'PREÇO MÉDIO REVENDA'), unit, cell(row, 'PRODUTO'));
  }));
}

export async function pdfItems(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    if (doc.numPages > 10) throw new Error('Energy PDF exceeds page budget');
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    return content.items.filter(i => i.str?.trim()).map(i => ({ text: i.str, x: i.transform[4], y: i.transform[5], width: i.width }));
  } finally { await task.destroy(); }
}

const lineItems = (items, y) => items.filter(i => Math.abs(i.y - y) < 1).sort((a, b) => a.x - b.x);

export function parsePetrobangla(items) {
  const fullText = [...items].sort((a, b) => b.y - a.y || a.x - b.x).map(i => i.text).join(' ');
  const date = fullText.match(/Date\s*:\s*\d{1,2}\s*-\s*(\d{1,2})\s+([A-Za-z]{3}),?\s*(20\d{2})/);
  const month = MONTHS.indexOf(date?.[2].toUpperCase());
  if (!date || month < 0 || !/Gas in MMCFD/.test(fullText)) throw new Error('Unknown Petrobangla report');
  const period = `${date[3]}-${String(month + 1).padStart(2, '0')}-${date[1].padStart(2, '0')}`;
  const lngLabel = items.find(i => /RPGCL \(R-LNG\)/.test(i.text));
  const totalLabel = items.find(i => /^Grand Total \(1\+2\+3\+4\+5\):?$/.test(i.text));
  if (!lngLabel || !totalLabel) throw new Error('Missing Petrobangla supply totals');
  const totalCells = lineItems(items, totalLabel.y).filter(i => i.x > totalLabel.x + totalLabel.width && /^\d[\d,.]*$/.test(i.text.trim()));
  if (totalCells.length !== 6) throw new Error('Changed Petrobangla total columns');
  const gasColumn = totalCells[2];
  const lngCells = lineItems(items, lngLabel.y).filter(i => i.x > lngLabel.x + lngLabel.width && /^\d[\d,.]*$/.test(i.text.trim()));
  const lngCell = lngCells.find(i => Math.abs((i.x + i.width) - (gasColumn.x + gasColumn.width)) < 4);
  if (!lngCell) throw new Error('Missing Petrobangla LNG gas column');
  const total = number(gasColumn.text), lng = number(lngCell.text);
  if (total <= 0 || lng < 0 || lng > total) throw new Error('Invalid Petrobangla gas supply');
  return [observation('gas.supply', period, total, 'MMcfd'), observation('gas.lng_supply', period, lng, 'MMcfd'), observation('gas.lng_share_of_supply', period, lng / total * 100, '%')];
}

export function parseGse(items) {
  const title = items.find(i => /ELECTRICITY BALANCE OF GEORGIA 20\d{2}/.test(i.text));
  const year = title?.text.match(/20\d{2}/)?.[0];
  const january = items.find(i => i.text === 'January');
  if (!year || !january || !items.some(i => /Mln.kWh/.test(i.text))) throw new Error('Unknown GSE balance');
  const monthHeaders = lineItems(items, january.y).filter(i => MONTHS.includes(i.text.slice(0, 3).toUpperCase()));
  if (monthHeaders.length !== 12) throw new Error('Changed GSE month columns');
  const centers = monthHeaders.map(i => i.x + i.width / 2);
  const step = centers[1] - centers[0];
  const labels = {
    'Total Generation': 'energy.generated', 'Thermal Power Plants': 'energy.thermal',
    'Hydro Power Plants': 'energy.hydro', 'Wind Power Plants': 'energy.wind',
    'Solar Power Plants': 'energy.solar', 'Total Consumption': 'energy.consumed',
    'Net Import/Export': 'energy.exchange.net',
    'Net Import/Export Russia': 'energy.exchange.net', 'Net Import/Export Azerbaijan': 'energy.exchange.net',
    'Net Import/Export Armenia': 'energy.exchange.net', 'Net Import/Export Turkey': 'energy.exchange.net',
  };
  const points = [];
  const labelItems = items.filter(i => Object.hasOwn(labels, i.text));
  // Each balance row appears once. Rejecting repeats also bounds the row scans
  // below to one per known label, whatever the page's text-item count.
  if (new Set(labelItems.map(i => i.text)).size !== labelItems.length) throw new Error('Changed GSE balance rows');
  for (const label of labelItems) {
    const line = lineItems(items, label.y);
    for (let m = 0; m < 12; m++) {
      const cell = line.filter(i => i.x + i.width / 2 >= centers[m] - step / 2 && i.x + i.width / 2 < centers[m] + step / 2).map(i => i.text).join('');
      if (!cell.trim()) continue;
      const area = label.text.startsWith('Net Import/Export ') ? label.text.slice('Net Import/Export '.length) : '';
      points.push(observation(labels[label.text], `${year}-${String(m + 1).padStart(2, '0')}`, number(cell, true), 'GWh', area));
    }
  }
  if (!points.some(p => p.metric === 'energy.generated')) throw new Error('Missing GSE generation');
  return required(points);
}

function publicUrl(value, hosts) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) throw new Error('Unapproved energy download URL');
  return url.href;
}

export function discoverEskomCsv(media, title) {
  const item = Array.isArray(media) && media.find(x => x.title?.rendered === title && /\.csv$/i.test(x.source_url));
  if (!item) throw new Error(`Missing Eskom ${title} CSV`);
  return publicUrl(item.source_url, ['www.eskom.co.za']);
}

export function discoverGsePdf(payload) {
  const files = payload?.data?.contents?.flatMap(c => c.files ?? []) ?? [];
  const file = files.filter(f => /^\s*20\d{2}\s*$/.test(f.name) && /\.pdf$/i.test(f.path)).sort((a, b) => Number(b.name) - Number(a.name))[0];
  if (!file) throw new Error('Missing GSE balance PDF');
  return publicUrl(file.path, ['admin.gse.com.ge']);
}

export function discoverPetrobanglaPdf(html) {
  const report = blocks(cleanHtml(html), 'tr').find(row => /দৈনিক-গ্যাস-ইনটেক-অফটেক-প্রতিবেদন/.test(row.inner));
  const url = report?.inner.match(/href="(https:[^"]+office-petrobangla[^"<>]+\.pdf)"/i)?.[1];
  if (!url) throw new Error('Missing Petrobangla daily gas PDF');
  return publicUrl(url, ['objectstorage.ap-dcc-gazipur-1.oraclecloud15.com']);
}

export function buildFeedSnapshot(sourceId, observations, dataUrl, nowMs = Date.now()) {
  if (!feeds.some(f => f.id === sourceId)) throw new Error('Unknown regional energy feed');
  required(observations);
  const series = new Map();
  for (const p of observations) {
    if (!p.metric || !p.unit || typeof p.area !== 'string' || !Number.isFinite(p.value) || periodEnd(p.period) > nowMs + 3600000) throw new Error('Invalid regional energy observation');
    const key = `${p.metric}|${p.area}`;
    if (!series.has(key)) series.set(key, new Map());
    const points = series.get(key);
    if (points.has(p.period) && points.get(p.period).value !== p.value) throw new Error('Conflicting energy observations');
    points.set(p.period, p);
  }
  const retained = [...series.values()].flatMap(points => [...points.values()].sort((a, b) => periodEnd(b.period) - periodEnd(a.period)).slice(0, 8));
  if (retained.length > 2000) throw new Error('Regional energy payload exceeds observation budget');
  const observedAt = new Date(Math.max(...retained.map(p => periodEnd(p.period)))).toISOString();
  return { sourceId, dataUrl, fetchedAt: new Date(nowMs).toISOString(), observedAt, observations: retained };
}
