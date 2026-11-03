import { isoDate } from '../food-prices.mjs';

const INDEX = 'https://stat.gov.kg/ru/daily-prices/';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ITEMS = {
  'Пшеница': ['Wheat', 'kg'],
  'Рис среднезерный': ['Rice (medium-grain)', 'kg'],
  'Рис длиннозерный': ['Rice (long-grain)', 'kg'],
  'Мука пшеничная высшего сорта': ['Wheat flour (premium grade)', 'kg'],
  'Мука пшеничная первого сорта': ['Wheat flour (first grade)', 'kg'],
  'Хлеб из пшеничной муки 1 сорта': ['Bread (first-grade wheat flour)', 'kg'],
  'Лепешка': ['Flatbread (lepyoshka)', 'kg'],
  'Говядина': ['Beef', 'kg'],
  'Баранина': ['Mutton', 'kg'],
  'Конина': ['Horse meat', 'kg'],
  'Молоко цельное разливное непастеризованное': ['Milk (whole, unpasteurized, loose)', 'litre'],
  'Яйца куриные': ['Eggs (chicken)', '10 pieces'],
  'Подсолнечное масло, 1 кг': ['Sunflower oil', 'kg'],
  'Картофель': ['Potatoes', 'kg'],
  'Сахар-песок': ['Sugar (granulated)', 'kg'],
  'Чай черный байховый, 100 гр.': ['Black tea', '100 g'],
  'Чай зеленый, 100 гр.': ['Green tea', '100 g'],
};
const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const market = value => {
  const name = text(value);
  return /^Kyrgyz Republic$/i.test(name) ? 'National average' : name.split(',')[0].replace(/\s+city$/i, '').trim();
};

// Monthly sheet of the daily food-price workbook: rows 0-4 carry the trilingual title and date headers,
// then one block per product (KY, EN, RU name row) followed by the national row and 19 settlements.
export function parseNsckg(rows) {
  const title = /in\s+([A-Za-z]+)\s+(\d{4})\s*$/.exec(text(rows[0]?.[1]));
  const month = MONTHS.indexOf(title?.[1]?.toLowerCase()) + 1;
  if (!month || !/soms per kilogram/i.test(text(rows[1]?.[1]))) throw new Error('nsckg daily price sheet format changed');
  const dates = (rows[3] ?? []).map(value => {
    const match = /^([A-Za-z]+)\s+(\d{1,2})$/.exec(text(value));
    if (!match) return '';
    if (MONTHS.indexOf(match[1].toLowerCase()) + 1 !== month) throw new Error('nsckg date header month mismatch (format changed)');
    return isoDate(title[2], month, match[2]);
  });
  if (!dates.some(Boolean)) throw new Error('nsckg date header missing (format changed)');
  const result = [];
  let product = null;
  for (const [i, row] of rows.entries()) {
    if (i < 5 || !row) continue;
    if (/^- -/.test(text(row[2]))) break;
    const numbers = dates.some((date, column) => date && typeof row[column] === 'number');
    if (!numbers && text(row[2]) && market(rows[i + 1]?.[1]) === 'National average') {
      product = ITEMS[text(row[2])] ?? null;
      continue;
    }
    if (!product || !numbers) continue;
    const place = market(row[1]);
    if (!place) throw new Error('nsckg settlement name missing (format changed)');
    for (const [column, date] of dates.entries()) {
      const value = row[column];
      if (!date || typeof value !== 'number' || !(value > 0)) continue;
      result.push({ item: product[0], market: place, marketType: 'retail', unit: product[1], currency: 'KGS', date, price: Math.round(value * 100) / 100, origin: '' });
    }
  }
  if (!result.length) throw new Error('nsckg sheet has no dated food prices');
  return result;
}

// Minimal BIFF8 reader over a compound-file byte source, so only the sectors that hold the workbook
// globals and the requested month sheets are fetched from the 19 MB legacy .xls.
const END = 0xFFFFFFFA;
const xlsError = message => new Error(`nsckg ${message} (format changed)`);

const MAX_FAT_SECTORS = 4096;

async function compoundStream(read, wanted) {
  const header = await read(0, 512);
  if (header.length < 512 || header.readUInt32LE(0) !== 0xE011CFD0 || header.readUInt32LE(4) !== 0xE11AB1A1) throw xlsError('workbook is not a legacy XLS file');
  const size = 1 << header.readUInt16LE(30);
  if (size !== 512 && size !== 4096) throw xlsError('unexpected compound sector size');
  const sector = async index => {
    const bytes = await read((index + 1) * size, size);
    if (bytes.length !== size) throw xlsError('truncated compound sector');
    return bytes;
  };
  if (header.readUInt32LE(44) > MAX_FAT_SECTORS) throw xlsError('compound FAT table is malformed or too large');
  const difat = Array.from({ length: 109 }, (_, i) => header.readUInt32LE(76 + i * 4));
  for (let next = header.readUInt32LE(68), guard = 0; next < END; guard++) {
    if (guard > 64) throw xlsError('DIFAT chain too long');
    const bytes = await sector(next);
    for (let i = 0; i < size / 4 - 1; i++) difat.push(bytes.readUInt32LE(i * 4));
    next = bytes.readUInt32LE(size - 4);
  }
  // The declared FAT size and the DIFAT entries come from the file. A valid file never repeats a FAT
  // sector, and 4096 of them map a file of over 268 MB, so refuse anything else before reading (CWE-770).
  const fatSectors = difat.filter(index => index < END).slice(0, header.readUInt32LE(44));
  if (fatSectors.length > MAX_FAT_SECTORS || new Set(fatSectors).size !== fatSectors.length) throw xlsError('compound FAT table is malformed or too large');
  const fat = [];
  for (const index of fatSectors) {
    const bytes = await sector(index);
    for (let i = 0; i < size / 4; i++) fat.push(bytes.readUInt32LE(i * 4));
  }
  const chain = start => {
    const out = [];
    for (let index = start; index < END; index = fat[index]) {
      if (index === undefined || out.length > fat.length) throw xlsError('broken sector chain');
      out.push(index);
    }
    return out;
  };
  let entry = null;
  for (const index of chain(header.readUInt32LE(48))) {
    const bytes = await sector(index);
    for (let offset = 0; offset < size && !entry; offset += 128) {
      const length = bytes.readUInt16LE(offset + 64);
      if (bytes[offset + 66] === 2 && length >= 2 && wanted.includes(bytes.toString('utf16le', offset, offset + length - 2))) {
        entry = { start: bytes.readUInt32LE(offset + 116), size: bytes.readUInt32LE(offset + 120) };
      }
    }
    if (entry) break;
  }
  if (!entry || entry.size < 4096) throw xlsError('Workbook stream missing');
  const sectors = chain(entry.start);
  if (sectors.length * size < entry.size) throw xlsError('Workbook stream truncated');
  return {
    size: entry.size,
    async read(offset, length) {
      if (offset + length > entry.size) throw xlsError('record beyond Workbook stream');
      const parts = [];
      for (let at = offset; at < offset + length;) {
        const index = Math.floor(at / size);
        const from = at - index * size;
        const take = Math.min(size - from, offset + length - at);
        parts.push((await sector(sectors[index])).subarray(from, from + take));
        at += take;
      }
      return Buffer.concat(parts);
    },
  };
}

async function* records(stream, offset) {
  while (offset + 4 <= stream.size) {
    const head = await stream.read(offset, 4);
    const length = head.readUInt16LE(2);
    const body = length ? await stream.read(offset + 4, length) : Buffer.alloc(0);
    yield { type: head.readUInt16LE(0), body };
    offset += 4 + length;
  }
}

const chars = (bytes, at, count, wide) => wide ? bytes.toString('utf16le', at, at + count * 2) : bytes.toString('latin1', at, at + count);

export function readSst(chunks) {
  const strings = [];
  const total = chunks[0].readUInt32LE(4);
  let block = 0;
  let data = chunks[0];
  let pos = 8;
  while (strings.length < total) {
    if (!data || pos + 3 > data.length) throw xlsError('shared string table truncated');
    const count = data.readUInt16LE(pos);
    const flags = data[pos + 2];
    pos += 3;
    const runs = flags & 8 ? data.readUInt16LE(pos) : 0;
    if (flags & 8) pos += 2;
    const ext = flags & 4 ? data.readUInt32LE(pos) : 0;
    if (flags & 4) pos += 4;
    let wide = flags & 1;
    let value = '';
    for (let left = count; ;) {
      const take = Math.min(left, wide ? (data.length - pos) >> 1 : data.length - pos);
      value += chars(data, pos, take, wide);
      pos += take * (wide ? 2 : 1);
      left -= take;
      if (!left) break;
      data = chunks[++block];
      if (!data) throw xlsError('shared string truncated');
      wide = data[0] & 1;
      pos = 1;
    }
    pos += runs * 4 + ext;
    while (pos >= data.length && strings.length + 1 < total) {
      pos -= data.length;
      data = chunks[++block];
      if (!data) throw xlsError('shared string table truncated');
    }
    strings.push(value);
  }
  return strings;
}

const rk = value => {
  let number;
  if (value & 2) number = value >> 2;
  else {
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32LE(value & 0xFFFFFFFC, 4);
    number = bytes.readDoubleLE(0);
  }
  return value & 1 ? number / 100 : number;
};

const MAX_SHEET_ROWS = 5000;
const MAX_SHEET_COLUMNS = 256;

export async function readXls(read) {
  const stream = await compoundStream(read, ['Workbook', 'Book']);
  const sheets = [];
  let sst = [];
  let inSst = false;
  let first = true;
  for await (const { type, body } of records(stream, 0)) {
    if (first && (type !== 0x0809 || body.readUInt16LE(0) !== 0x0600)) throw xlsError('workbook is not BIFF8');
    first = false;
    if (type === 0x000A) break;
    if (type === 0x0085) sheets.push({ offset: body.readUInt32LE(0), kind: body[5], name: chars(body, 8, body[6], body[7] & 1) });
    if (type === 0x00FC) sst = [body];
    else if (type !== 0x003C || !inSst) { inSst = false; continue; }
    else sst.push(body);
    inSst = true;
  }
  const strings = sst.length ? readSst(sst) : [];
  return {
    names: sheets.filter(sheet => sheet.kind === 0).map(sheet => sheet.name),
    async rows(name) {
      const sheet = sheets.find(sheet => sheet.kind === 0 && sheet.name === name);
      if (!sheet) throw xlsError(`sheet ${name} missing`);
      const rows = [];
      // Record indices size the dense output, so bound them: the real sheets are a few hundred rows by ~35 columns.
      const put = (r, c, value) => {
        if (r >= MAX_SHEET_ROWS || c >= MAX_SHEET_COLUMNS) throw xlsError('cell index out of range');
        (rows[r] ??= [])[c] = value;
      };
      let pending = null;
      let start = true;
      for await (const { type, body } of records(stream, sheet.offset)) {
        if (start && type !== 0x0809) throw xlsError('sheet BOF missing');
        start = false;
        if (type === 0x000A) return Array.from(rows, row => Array.from(row ?? [], value => value ?? ''));
        if (type === 0x00FD) put(body.readUInt16LE(0), body.readUInt16LE(2), strings[body.readUInt32LE(6)] ?? '');
        else if (type === 0x0203) put(body.readUInt16LE(0), body.readUInt16LE(2), body.readDoubleLE(6));
        else if (type === 0x027E) put(body.readUInt16LE(0), body.readUInt16LE(2), rk(body.readInt32LE(6)));
        else if (type === 0x00BD) {
          const last = body.readUInt16LE(body.length - 2);
          for (let c = body.readUInt16LE(2), at = 4; c <= last; c++, at += 6) put(body.readUInt16LE(0), c, rk(body.readInt32LE(at + 2)));
        } else if (type === 0x0204) put(body.readUInt16LE(0), body.readUInt16LE(2), chars(body, 9, body.readUInt16LE(6), body[8] & 1));
        else if (type === 0x0006) {
          if (body.readUInt16LE(12) !== 0xFFFF) put(body.readUInt16LE(0), body.readUInt16LE(2), body.readDoubleLE(6));
          else if (body[6] === 0) pending = [body.readUInt16LE(0), body.readUInt16LE(2)];
        } else if (type === 0x0207 && pending) {
          put(...pending, chars(body, 3, body.readUInt16LE(0), body[2] & 1));
          pending = null;
        }
      }
      throw xlsError('sheet EOF missing');
    },
  };
}

function rangeReader(ctx, url, block = 1 << 19) {
  const cache = new Map();
  const load = async index => {
    if (!cache.has(index)) {
      if (cache.size >= 12) throw new Error('nsckg workbook needs too many range requests');
      const bytes = await ctx.get(url, { binary: true, headers: { Range: `bytes=${index * block}-${(index + 1) * block - 1}` } });
      if (bytes.length > block) throw new Error('nsckg server ignored the byte range');
      cache.set(index, bytes);
    }
    return cache.get(index);
  };
  return async (offset, length) => {
    const parts = [];
    for (let at = offset; at < offset + length;) {
      const index = Math.floor(at / block);
      const bytes = await load(index);
      const from = at - index * block;
      if (from >= bytes.length) break;
      const take = Math.min(bytes.length - from, offset + length - at);
      parts.push(bytes.subarray(from, from + take));
      at += take;
    }
    return Buffer.concat(parts);
  };
}

export async function collect(ctx) {
  const link = ctx.links(await ctx.get(INDEX), INDEX).find(link => /Продовольственные товары/i.test(link.text) && /\/media\/files\/[\w-]+\.xls$/i.test(new URL(link.url).pathname));
  if (!link) throw new Error('nsckg food workbook link missing');
  const book = await readXls(rangeReader(ctx, link.url));
  if (!book.names.length) throw new Error('nsckg workbook has no sheets');
  const today = ctx.dated(ctx.now, 0);
  const latestOf = rows => rows.reduce((max, row) => row.date > max ? row.date : max, '');
  const priorOf = date => ctx.dated(new Date(`${date}T00:00:00Z`), -7);
  let rows = [];
  // Newest month first; a freshly opened month can still be empty, and the prior week can sit in the previous month.
  for (const name of book.names.slice(0, 3)) {
    const latest = latestOf(rows);
    if (latest && rows.some(row => row.date <= priorOf(latest))) break;
    try {
      rows = rows.concat(parseNsckg(await book.rows(name)).filter(row => row.date <= today));
    } catch (error) {
      if (!latest && !/no dated food prices/.test(error.message)) throw error;
      ctx.warn(`sheet ${name} unavailable: ${error.message}`);
      if (latest) break;
    }
  }
  const latest = latestOf(rows);
  if (!latest) throw new Error('nsckg has no current daily prices');
  const prior = priorOf(latest);
  const refreshedReports = [{ date: latest }];
  if (rows.some(row => row.date === prior)) refreshedReports.push({ date: prior });
  else ctx.warn(`no daily prices for ${prior}, weekly comparison unavailable`);
  return { observations: rows.filter(row => row.date === latest || row.date === prior), refreshedReports, reportUrl: link.url };
}
