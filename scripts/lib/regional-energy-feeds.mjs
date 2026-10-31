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

// The PDF parsers match cells by position, which is quadratic in the item
// count. Real reports carry a few hundred items; reject anything far larger.
const PDF_ITEM_LIMIT = 5000;
async function pdfText(bytes, allPages) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    if (doc.numPages > 10) throw new Error('Energy PDF exceeds page budget');
    const items = [];
    for (let n = 1; n <= (allPages ? doc.numPages : 1); n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      for (const i of content.items) {
        if (!i.str?.trim()) continue;
        if (items.length >= PDF_ITEM_LIMIT) throw new Error('Energy PDF exceeds text item budget');
        items.push({ page: n, text: i.str, x: i.transform[4], y: i.transform[5], width: i.width });
      }
    }
    return items;
  } finally { await task.destroy(); }
}
export const pdfItems = bytes => pdfText(bytes, false);
export const pdfAllItems = bytes => pdfText(bytes, true);

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

const pad2 = n => String(n).padStart(2, '0');
const validDay = day => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) throw new Error('Invalid energy day');
  periodEnd(day);
  return day;
};
const ymd = (y, m, d) => validDay(`${y}-${pad2(m)}-${pad2(d)}`);
const addDays = (day, n) => new Date(Date.parse(`${validDay(day)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const EN_MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const EN_MONTH_RE = EN_MONTHS.join('|');

// Identical repeats collapse; conflicting repeats throw.
function addUnique(map, point) {
  const key = `${point.metric}|${point.area}|${point.period}`;
  const prior = map.get(key);
  if (prior && (prior.value !== point.value || prior.unit !== point.unit)) throw new Error(`Conflicting fuel observations for ${point.area}`);
  map.set(key, point);
}

// ---- Vietnam EVN: copy of the NSMO daily national system bulletin ----

const EVN_HOST = 'evn.com.vn';
const EVN_POST = /^\/d\/vi-VN\/news\/Thong-tin-chung-ve-van-hanh-he-thong-dien-Quoc-gia-ngay-(\d{2})(\d{2})(20\d{2})-60-2015-(\d{1,9})$/;

export function discoverEvnPost(html) {
  let best = null;
  for (const m of cleanHtml(String(html)).matchAll(/href=["']([^"'<>]{1,400})["']/g)) {
    const path = m[1].trim();
    const parts = path.match(EVN_POST);
    if (!parts) continue;
    const day = validDay(`${parts[3]}-${parts[2]}-${parts[1]}`);
    const id = Number(parts[4]);
    if (!best || day > best.day || (day === best.day && id > best.id)) best = { day, id, path };
  }
  if (!best) throw new Error('Missing EVN daily system bulletin');
  return publicUrl(new URL(best.path, `https://${EVN_HOST}/`).href, [EVN_HOST]);
}

// Decimal comma; dotted thousands with a decimal comma are also unambiguous.
function vnNumber(raw) {
  const s = String(raw).trim();
  if (/^\d+(?:,\d+)?$/.test(s)) return number(s, true);
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s)) return number(s.replace(/\./g, ''), true);
  throw new Error('Invalid EVN measurement');
}

const EVN_BASIS = { 'ước tính thương phẩm': 'rooftop solar sales estimate', 'ước tính đầu cực': 'rooftop solar terminal estimate' };
const EVN_SOURCES = {
  'Thủy điện': ['hydro', ''],
  'Nhiệt điện than': ['coal', ''],
  'Tuabin khí (Gas + Dầu DO)': ['gas_turbine', 'gas and diesel oil'],
  'Nhiệt điện dầu': ['oil', ''],
  'Điện gió': ['wind', ''],
  'ĐMT trang trại': ['solar_farm', ''],
  'ĐMT mái nhà (ước tính thương phẩm)': ['solar_rooftop', 'sales estimate'],
  'ĐMT mái nhà (ước tính đầu cực)': ['solar_rooftop', 'terminal estimate'],
  'Nhập khẩu điện': ['imports', ''],
  'Khác (Sinh khối, Diesel Nam, …)': ['other', 'biomass, southern diesel and other'],
};
const EVN_TOTALS = {
  'Quốc gia + ĐMT mái nhà (ước tính thương phẩm)': ['total', 'rooftop solar sales estimate'],
  'Quốc gia + ĐMT mái nhà (ước tính đầu cực)': ['total', 'rooftop solar terminal estimate'],
};

export function parseEvn(html) {
  const source = cleanHtml(String(html));
  const title = blocks(source, 'h3').map(h => text(h.inner)).find(t => t.startsWith('Thông tin chung về vận hành hệ thống điện Quốc gia ngày'));
  const date = title?.match(/ngày (\d{2})\/(\d{2})\/(20\d{2})$/);
  if (!date) throw new Error('Changed EVN bulletin title');
  const period = ymd(date[3], date[2], date[1]);
  const start = source.indexOf('chitiettinbai');
  const end = source.indexOf('id="contentdetails"', start);
  if (start < 0 || end < 0) throw new Error('Changed EVN bulletin body');
  const body = source.slice(start, end);
  const points = [];
  let summaries = 0;
  for (const para of blocks(body, 'p').map(p => text(p.inner))) {
    const head = para.match(/^Tính với số liệu ĐMT mái nhà \((ước tính thương phẩm|ước tính đầu cực)\):/);
    if (head) {
      const area = EVN_BASIS[head[1]];
      const peak = para.match(/Công suất lớn nhất trong ngày: ([\d.,]{1,12}) MW/);
      const energy = para.match(/Sản lượng điện sản xuất và nhập khẩu: ([\d.,]{1,12}) triệu kWh/);
      if (!peak || !energy) throw new Error('Changed EVN daily summary');
      points.push(observation('generation.peak', period, vnNumber(peak[1]), 'MW', area));
      points.push(observation('energy.generated_and_imported', period, vnNumber(energy[1]), 'mln kWh', area));
      summaries++;
      continue;
    }
    const line = para.match(/^- (.{1,80}?) ([\d.,]{1,12}) triệu kWh$/);
    if (!line) continue;
    if (!Object.hasOwn(EVN_SOURCES, line[1])) throw new Error(`Unknown EVN source ${line[1]}`);
    const [key, area] = EVN_SOURCES[line[1]];
    points.push(observation(`energy.${key}`, period, vnNumber(line[2]), 'mln kWh', area));
  }
  if (summaries !== 2) throw new Error('Changed EVN daily summary');
  for (const key of ['hydro', 'coal', 'imports']) {
    if (!points.some(p => p.metric === `energy.${key}`)) throw new Error('Changed EVN source mix');
  }
  // Dispatched capacity at the midday trough and the evening peak (MW).
  const table = blocks(body, 'table')[0]?.inner;
  if (!table) throw new Error('Missing EVN dispatch table');
  const [header, ...data] = rows(table);
  if (header?.join('|') !== 'Mục|Khi phụ tải vào thấp điểm trưa|Khi phụ tải vào cao điểm tối') throw new Error('Changed EVN dispatch table');
  for (const row of data) {
    if (row.length !== 3) throw new Error('Changed EVN dispatch row');
    const known = EVN_TOTALS[row[0]] ?? EVN_SOURCES[row[0]];
    if (!known) throw new Error(`Unknown EVN dispatch row ${row[0]}`);
    const [key, basis] = known;
    ['midday trough', 'evening peak'].forEach((moment, i) => points.push(observation(key === 'total' ? 'generation' : `generation.${key}`, period, vnNumber(row[i + 1]), 'MW', [moment, basis].filter(Boolean).join('; '))));
  }
  return required(points);
}

// ---- Kazakhstan KOREM: system energy and day-ahead auction ----

export const KOREM_ORIGIN = 'https://portal.korem.kz';
const koremUrl = (path, params) => publicUrl(`${KOREM_ORIGIN}${path}${params ? `?${new URLSearchParams(params)}` : ''}`, ['portal.korem.kz']);
export const KOREM_FIXED_URLS = {
  summary: koremUrl('/api/energy/summary'),
  maxConsumption: koremUrl('/api/energy/max-consumption'),
  torgNames: koremUrl('/api/ct/torg-names'),
  zones: koremUrl('/api/ct/zones'),
};

export function koremEnergySeriesUrl(summary) {
  const last = validDay(summary?.lastDate);
  return koremUrl('/api/energy/series', { from: addDays(last, -7), to: last });
}

function koremDayAheadId(torgNames) {
  const match = Array.isArray(torgNames) ? torgNames.filter(t => t?.name === 'ЦТ для ЭПО') : [];
  if (match.length !== 1 || !Number.isInteger(match[0].id)) throw new Error('Missing KOREM day-ahead auction');
  return match[0].id;
}
export const koremLastDateUrl = torgNames => koremUrl('/api/ct/last-date', { torgNameId: koremDayAheadId(torgNames) });

export function koremCtUrls(torgNames, zones, lastDate) {
  const torgNameId = koremDayAheadId(torgNames);
  if (!Array.isArray(zones) || !zones.length || zones.length > 10 || zones.some(z => !Number.isInteger(z?.id) || typeof z.name !== 'string' || !z.name)) throw new Error('Invalid KOREM zones');
  const to = validDay(lastDate);
  const range = { torgNameId, from: addDays(to, -7), to, granularity: 'day' };
  return zones.map(zone => ({
    zone: zone.name,
    prices: koremUrl('/api/ct/weighted-prices', { zoneId: zone.id, ...range }),
    volumes: koremUrl('/api/ct/series', { zoneId: zone.id, ...range }),
  }));
}

const koremDay = dt => {
  const m = String(dt ?? '').match(/^(\d{4}-\d{2}-\d{2})T00:00:00$/);
  if (!m) throw new Error('Invalid KOREM daily timestamp');
  return validDay(m[1]);
};

// ct: [{ zone, prices: weighted-prices JSON, volumes: ct/series JSON }]
export function parseKorem({ series, maxConsumption, ct }) {
  if (!Array.isArray(series) || !Array.isArray(ct) || !maxConsumption || typeof maxConsumption !== 'object') throw new Error('Invalid KOREM response');
  const points = [];
  for (const row of series) {
    const day = validDay(row?.date);
    if (row.gen != null) points.push(observation('energy.generated', day, row.gen, 'mln kWh'));
    if (row.cons != null) points.push(observation('energy.consumed', day, row.cons, 'mln kWh'));
  }
  if (maxConsumption.lastConsFact != null) points.push(observation('demand.peak', validDay(maxConsumption.lastDate), maxConsumption.lastConsFact, 'MW'));
  for (const { zone, prices, volumes } of ct) {
    if (!Array.isArray(prices) || !Array.isArray(volumes)) throw new Error('Invalid KOREM auction response');
    for (const row of prices) if (row?.price != null) points.push(observation('price.day_ahead', koremDay(row.dt), row.price, 'KZT/kWh', zone));
    for (const row of volumes) if (row?.deal != null) points.push(observation('trade.day_ahead.volume', koremDay(row.dt), row.deal, 'thousand kWh', zone));
  }
  if (!points.some(p => p.metric === 'energy.generated')) throw new Error('Missing KOREM generation');
  return required(points);
}

// ---- Peru COES: SEIN half-hourly demand ----

export const COES_DEMAND_URL = 'https://www.coes.org.pe/Portal/portalinformacion/Demanda';
const ddmmyyyy = day => validDay(day).split('-').reverse().join('/');

// Form body for the Lima-local window [yesterday, today]; Peru is UTC-05:00 with no DST.
export function coesDemandBody(nowMs = Date.now()) {
  const today = new Date(nowMs - 5 * 3600000).toISOString().slice(0, 10);
  return new URLSearchParams({ fechaInicial: ddmmyyyy(addDays(today, -1)), fechaFinal: ddmmyyyy(today) }).toString();
}

// Timestamps are half-hour interval ends in Lima time; "D 00:00" closes the previous day.
export function parseCoes(payload) {
  if (!Array.isArray(payload?.Data)) throw new Error('Invalid COES response');
  const points = [];
  const map = { ValorEjecutado: 'demand', ValorProgramacionDiaria: 'demand.scheduled', ValorProgramacionSemanal: 'demand.scheduled_weekly' };
  for (const row of payload.Data) {
    const m = String(row?.Fecha ?? '').match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/);
    if (!m) throw new Error('Invalid COES timestamp');
    const period = iso(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`, '-05:00');
    for (const [key, metric] of Object.entries(map)) {
      if (!Object.hasOwn(row, key)) throw new Error('Changed COES demand row');
      if (row[key] != null) points.push(observation(metric, period, row[key], 'MW', 'SEIN'));
    }
  }
  if (!points.some(p => p.metric === 'demand')) throw new Error('No executed COES demand');
  return required(points);
}

// ---- Papua New Guinea ICCC: monthly Port Moresby fuel price posts ----

const ICCC_HOST = 'iccc.gov.pg';
// Category 763309980 is "Fuel Prices" (https://iccc.gov.pg/category/fuel-prices/).
export const ICCC_INDEX_URL = `https://${ICCC_HOST}/wp-json/wp/v2/posts?categories=763309980&per_page=10&_fields=id,date,date_gmt,modified_gmt,link,title`;
const ICCC_TITLE = new RegExp(`FUEL PRICES\\s*[–-]\\s*(?:\\d{1,2}(?:st|nd|rd|th)?\\s+)?(${EN_MONTH_RE})\\s+(20\\d{2})\\s*$`, 'i');
const decodeTitle = s => text(s).replace(/&#8211;|&ndash;/g, '–').replace(/&#8217;|&rsquo;/g, '’').replace(/&amp;|&#038;/g, '&');

// Newest first.
export function discoverPngFuelPosts(index) {
  if (!Array.isArray(index)) throw new Error('Invalid ICCC post index');
  const posts = index
    .filter(p => Number.isSafeInteger(p?.id) && p.id > 0 && typeof p.date_gmt === 'string' && ICCC_TITLE.test(decodeTitle(p.title?.rendered ?? '')))
    .sort((a, b) => b.date_gmt.localeCompare(a.date_gmt));
  if (!posts.length) throw new Error('Missing ICCC fuel price post');
  return posts.map(p => {
    publicUrl(p.link, [ICCC_HOST]);
    return publicUrl(`https://${ICCC_HOST}/wp-json/wp/v2/posts/${p.id}?_fields=id,date,date_gmt,modified_gmt,link,title,content`, [ICCC_HOST]);
  });
}

const PNG_PRODUCTS = ['Petrol', 'Diesel', 'Kerosene'];
const pngProduct = cell => PNG_PRODUCTS.find(p => new RegExp(`^${p}\\b`, 'i').test(cell));

// "K5.90" is kina; a bare number ("-59.81") is toea per litre, per the table captions.
function pngKinaPerLitre(cell) {
  const m = String(cell).trim().match(/^([+-])?\s*(K)?\s*(\d{1,4}(?:\.\d{1,4})?)$/);
  if (!m) throw new Error(`Changed ICCC price cell: ${String(cell).slice(0, 40)}`);
  const magnitude = m[2] ? number(m[3]) : number(m[3]) / 100;
  return { sign: m[1] === '-' ? -1 : 1, value: Number(magnitude.toFixed(4)) };
}

function pngRowKind(label, monthName) {
  const l = label.toLowerCase();
  if (EN_MONTHS.some(m => m !== monthName && l.includes(m.toLowerCase()))) return null; // previous month's comparison row
  if (/\bchange\b/.test(l)) return null;
  if (/unsubsidi[sz]ed|without subsidy/.test(l)) return { metric: 'fuel.retail_price.unsubsidized' };
  if (/gst exemption/.test(l)) return { metric: 'fuel.subsidy', component: 'GST exemption' };
  if (/direct subsidy/.test(l)) return { metric: 'fuel.subsidy', component: 'Direct subsidy' };
  if (/combined subsidy|subsidi[sz]ed amount|to be subsidi[sz]ed/.test(l)) return { metric: 'fuel.subsidy', component: 'Total' };
  if (/retail price|\birp\b|subsidi[sz]ed price/.test(l)) return { metric: 'fuel.retail_price' };
  return null;
}

export function parsePngFuelPost(post) {
  const title = decodeTitle(post?.title?.rendered ?? '');
  const titleMatch = title.match(ICCC_TITLE);
  const html = post?.content?.rendered;
  if (!titleMatch || typeof html !== 'string' || typeof post.date !== 'string') throw new Error('Unknown ICCC fuel price post');
  const monthName = titleMatch[1].toUpperCase();
  const month = EN_MONTHS.indexOf(monthName) + 1;
  const year = Number(titleMatch[2]);
  const posted = post.date.match(/^(20\d{2})-(\d{2})-/);
  const lag = posted ? (year * 12 + month) - (Number(posted[1]) * 12 + Number(posted[2])) : NaN;
  if (!(lag === 0 || lag === 1)) throw new Error('ICCC title month does not match post date');
  const body = text(html);
  if (!/Port Moresby/i.test(body)) throw new Error('ICCC post no longer covers Port Moresby');
  const effective = [...body.matchAll(new RegExp(`(?:on|effective|from)\\s+(?:[A-Za-z]+day,?\\s+)?(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${EN_MONTH_RE})\\s+(20\\d{2})`, 'gi'))]
    .find(m => m[2].toUpperCase() === monthName && Number(m[3]) === year);
  // The effective day is the period; a month period would read as future-dated all month.
  if (!effective) throw new Error('Missing ICCC effective date');
  const period = ymd(year, month, effective[1]);
  const points = new Map();
  for (const table of blocks(cleanHtml(html), 'table')) {
    let columns = null;
    for (const row of rows(table.inner)) {
      if (row.length >= 4 && row.slice(1).every(c => /^(Petrol|Diesel|Kerosene)(?:\s*\(tpl\))?$/i.test(c))) {
        columns = row.slice(1).map(pngProduct);
        continue;
      }
      const kind = pngRowKind(row[0] ?? '', monthName);
      if (!kind) continue;
      // Single-row layout: "<Month> IRP | Petrol K4.39 | Diesel K4.44 | Kerosene K4.09"
      const pairs = row.slice(1).every(c => /^(Petrol|Diesel|Kerosene)\s+[+-]?K?\d/i.test(c))
        ? row.slice(1).map(c => [pngProduct(c), c.replace(/^\S+\s+/, '')])
        : columns && row.length === columns.length + 1 ? columns.map((p, i) => [p, row[i + 1]]) : null;
      if (!pairs) throw new Error('Changed ICCC price table');
      for (const [product, cell] of pairs) {
        const { sign, value } = pngKinaPerLitre(cell);
        if (kind.metric === 'fuel.subsidy') {
          if (value > 30) throw new Error('Implausible ICCC subsidy');
          // Deductions print as negatives ("-59.81") or amounts ("+K1.14"); keep the magnitude.
          addUnique(points, observation('fuel.subsidy', period, value, 'PGK/l', `${product}; Port Moresby; ${kind.component}`));
        } else {
          if (sign < 0 || value < 0.5 || value > 30) throw new Error('Implausible ICCC retail price');
          addUnique(points, observation(kind.metric, period, value, 'PGK/l', `${product}; Port Moresby`));
        }
      }
    }
  }
  const result = [...points.values()];
  for (const product of PNG_PRODUCTS) {
    if (!result.some(p => p.metric === 'fuel.retail_price' && p.area === `${product}; Port Moresby`)) throw new Error(`Missing ICCC ${product} retail price`);
  }
  return result;
}

// ---- Fiji FCCC: monthly fuel and LPG price schedules (PDF media release) ----

const FCCC_HOST = 'fccc.gov.fj';
export const FCCC_INDEX_URL = `https://${FCCC_HOST}/wp-json/wp/v2/posts?search=LPG%20prices&orderby=date&order=desc&per_page=10&_fields=id,date,date_gmt,link,title,content`;

// Newest first.
export function discoverFijiFuelPdfs(index) {
  if (!Array.isArray(index)) throw new Error('Invalid FCCC post index');
  const urls = index
    .filter(p => typeof p?.date_gmt === 'string' && /FUEL\s+(?:AND|&)\s+LPG\s+PRICES/i.test(decodeTitle(p.title?.rendered ?? '')) && typeof p.content?.rendered === 'string')
    .sort((a, b) => b.date_gmt.localeCompare(a.date_gmt))
    .map(p => p.content.rendered.match(/href="(https:\/\/fccc\.gov\.fj\/wp-content\/uploads\/[^"<>\s]{1,300}\.pdf)"/i)?.[1])
    .filter(Boolean)
    .map(u => publicUrl(u, [FCCC_HOST]));
  if (!urls.length) throw new Error('Missing FCCC fuel price PDF');
  return urls;
}

const FJ_FUEL = { 'Motor Spirit': 'FJD/l', Premix: 'FJD/l', Kerosene: 'FJD/l', Diesel: 'FJD/l' };
const FJ_LPG = { '4.5 Kg Cylinder': ['LPG 4.5 Kg Cylinder', 'FJD/4.5kg'], '12 Kg Cylinder': ['LPG 12 Kg Cylinder', 'FJD/12kg'], 'Bulk (Kg)': ['LPG Bulk', 'FJD/kg'], 'Autogas (Litre)': ['LPG Autogas', 'FJD/l'] };

// Items come from pdfAllItems: the release's tables span page breaks.
export function parseFijiFuel(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('Empty FCCC PDF');
  const ordered = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const headings = { fuel: null, lpg: null };
  const effectiveDates = [];
  for (const i of ordered) {
    const h = i.text.match(new RegExp(`NEW APPROVED RETAIL (FUEL|LPG) PRICES? FOR (${EN_MONTH_RE}) (20\\d{2})`, 'i'));
    if (h) headings[h[1].toLowerCase()] = `${h[3]}-${pad2(EN_MONTHS.indexOf(h[2].toUpperCase()) + 1)}`;
    const e = i.text.trim().match(new RegExp(`^\\(Effective\\s+(\\d{1,2})\\s+(${EN_MONTH_RE})(?:\\s+(20\\d{2}))?\\)?$`, 'i'));
    if (e) effectiveDates.push({ day: Number(e[1]), month: EN_MONTHS.indexOf(e[2].toUpperCase()) + 1, year: e[3] ? Number(e[3]) : null });
  }
  if (!headings.fuel || !headings.lpg) throw new Error('Unknown FCCC price release');
  const withYear = effectiveDates.find(d => d.year);
  if (!withYear || effectiveDates.some(d => d.day !== withYear.day || d.month !== withYear.month || (d.year && d.year !== withYear.year))) throw new Error('Inconsistent FCCC effective dates');
  const period = ymd(withYear.year, withYear.month, withYear.day);
  if (period.slice(0, 7) !== headings.fuel || period.slice(0, 7) !== headings.lpg) throw new Error('FCCC heading month does not match effective date');
  let section = null, schedule = null;
  const seen = { fuel: new Map(), lpg: new Map() };
  const points = new Map();
  for (const i of ordered) {
    if (/^NEW APPROVED RETAIL FUEL PRICE/i.test(i.text)) { section = 'fuel'; schedule = null; continue; }
    if (/^NEW APPROVED RETAIL LPG PRICE/i.test(i.text)) { section = 'lpg'; schedule = null; continue; }
    const s = i.text.trim().match(/^Schedule\s*(\d)\s*:?$/);
    if (s && section) { schedule = Number(s[1]); continue; }
    const label = i.text.replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
    const isFuel = Object.hasOwn(FJ_FUEL, label), isLpg = Object.hasOwn(FJ_LPG, label);
    if (!isFuel && !isLpg) continue;
    if (!schedule || (section === 'fuel') !== isFuel) throw new Error(`FCCC ${label} row outside its schedule`);
    const bySchedule = seen[section];
    if (!bySchedule.has(schedule)) bySchedule.set(schedule, new Set());
    if (bySchedule.get(schedule).has(label)) throw new Error(`Duplicate FCCC ${label} row`);
    bySchedule.get(schedule).add(label);
    // Labels and values can sit 1-2pt apart; rows are about 16pt apart.
    const line = items
      .filter(o => o !== i && o.page === i.page && Math.abs(o.y - i.y) <= 4 && o.x >= i.x + i.width - 1)
      .sort((a, b) => a.x - b.x).map(o => o.text).join(' ');
    const money = [...line.matchAll(/(\()?\s*\$\s*(\d{1,3}\.\d{2})/g)].map(m => (m[1] ? -1 : 1) * number(m[2]));
    if (money.length !== 3) throw new Error(`Changed FCCC ${label} row`);
    const [current, approved, change] = money;
    if (current <= 0 || approved <= 0 || Math.abs(approved - current - change) > 0.0151) throw new Error(`FCCC ${label} price columns do not reconcile`);
    const [area, unit] = isFuel ? [`${label}; Schedule ${schedule}`, FJ_FUEL[label]] : [`${FJ_LPG[label][0]}; LPG Schedule ${schedule}`, FJ_LPG[label][1]];
    addUnique(points, observation('fuel.retail_price', period, approved, unit, area));
  }
  const complete = (bySchedule, count, products) => bySchedule.size === count
    && [...bySchedule.keys()].every(n => n >= 1 && n <= count)
    && [...bySchedule.values()].every(set => set.size === products.length);
  if (!complete(seen.fuel, 6, Object.keys(FJ_FUEL)) || !complete(seen.lpg, 4, Object.keys(FJ_LPG))) throw new Error('Changed FCCC schedule layout');
  return [...points.values()];
}

// Feeds flagged publishesAhead in the registry post schedules, day-ahead
// auction results or price releases before the period they describe. The
// snapshot keeps only what is already in effect; every other feed treats a
// future period as a parser fault.
//
// Date and month periods are the provider's calendar. A feed's registry
// utcOffsetMin moves their boundary to the provider's local midnight for these
// future checks; timestamps are already absolute. Published periods keep the
// source date.
export const effectiveAt = (period, utcOffsetMin = 0) => periodEnd(period) - (period.includes('T') ? 0 : utcOffsetMin * 60000);
// Timestamp schedules may lead by an hour; a calendar day or month is not in effect before it starts.
export const inEffect = (points, nowMs, utcOffsetMin = 0) => points.filter(p => effectiveAt(p.period, utcOffsetMin) <= nowMs + (p.period.includes('T') ? 3600000 : 0));

export function buildFeedSnapshot(sourceId, observations, dataUrl, nowMs = Date.now()) {
  const feed = feeds.find(f => f.id === sourceId);
  if (!feed) throw new Error('Unknown regional energy feed');
  required(observations);
  const series = new Map();
  for (const p of observations) {
    if (!p.metric || !p.unit || typeof p.area !== 'string' || !Number.isFinite(p.value) || effectiveAt(p.period, feed.utcOffsetMin) > nowMs + 3600000) throw new Error('Invalid regional energy observation');
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
