// Builds a minimal BIFF8 workbook inside an OLE2 compound file, shaped like
// AAII's sentiment.xls: a group-label row above the real header, ~2,100
// weekly rows (more than the old 2,000-row cap), MULRK/NUMBER/FORMULA cells,
// a shared string split across a CONTINUE record, footer summary rows, and the
// Workbook stream's sectors stored out of order in the file.

const SECTOR = 512;
const END_OF_CHAIN = 0xFFFFFFFE;
const FREE = 0xFFFFFFFF;
const FAT_SECT = 0xFFFFFFFD;

function record(type, payload) {
  const out = new Uint8Array(4 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, type, true);
  dv.setUint16(2, payload.length, true);
  out.set(payload, 4);
  return out;
}

function bytes(len, fill) {
  const out = new Uint8Array(len);
  fill(new DataView(out.buffer));
  return out;
}

const bof = (dt) => record(0x0809, bytes(16, (dv) => { dv.setUint16(0, 0x0600, true); dv.setUint16(2, dt, true); }));
const eof = () => record(0x000A, new Uint8Array(0));
const number = (row, col, val) => record(0x0203, bytes(14, (dv) => { dv.setUint16(0, row, true); dv.setUint16(2, col, true); dv.setFloat64(6, val, true); }));
const labelSst = (row, col, idx) => record(0x00FD, bytes(10, (dv) => { dv.setUint16(0, row, true); dv.setUint16(2, col, true); dv.setUint32(6, idx, true); }));
const formula = (row, col, val) => record(0x0006, bytes(22, (dv) => { dv.setUint16(0, row, true); dv.setUint16(2, col, true); dv.setFloat64(6, val, true); }));
// RK with the x100 flag and integer flag: encodes `hundredths / 100` exactly.
const rkHundredths = (hundredths) => ((hundredths << 2) | 0x03) >>> 0;
const mulrk = (row, firstCol, hundredthsList) => record(0x00BD, bytes(6 + hundredthsList.length * 6, (dv) => {
  dv.setUint16(0, row, true);
  dv.setUint16(2, firstCol, true);
  hundredthsList.forEach((h, k) => { dv.setUint16(4 + k * 6, 0, true); dv.setUint32(4 + k * 6 + 2, rkHundredths(h), true); });
  dv.setUint16(4 + hundredthsList.length * 6, firstCol + hundredthsList.length - 1, true);
}));

function sstRecords(strings, splitIndex) {
  // Compressed (8-bit) strings; the string at splitIndex is split mid-way into a
  // CONTINUE record whose first byte repeats the option flags.
  const head = [];
  const tail = [];
  const push = (arr, ...vals) => arr.push(...vals);
  const counts = bytes(8, (dv) => { dv.setUint32(0, strings.length, true); dv.setUint32(4, strings.length, true); });
  push(head, ...counts);
  strings.forEach((s, i) => {
    const target = i > splitIndex ? tail : head;
    const chars = [...s].map((ch) => ch.charCodeAt(0));
    if (i === splitIndex) {
      const cut = Math.floor(chars.length / 2);
      push(head, chars.length & 0xFF, chars.length >> 8, 0x00, ...chars.slice(0, cut));
      push(tail, 0x00, ...chars.slice(cut));
    } else {
      push(target, chars.length & 0xFF, chars.length >> 8, 0x00, ...chars);
    }
  });
  return [record(0x00FC, Uint8Array.from(head)), record(0x003C, Uint8Array.from(tail))];
}

export const FIXTURE_FIRST_SERIAL = 31982; // 1987-07-24
export const FIXTURE_WEEKS = 2100;

export function buildAaiiXlsFixture() {
  const strings = ['Bullish', 'Reported', 'Date', 'Neutral', 'Bearish', 'Bull-Bear', "Count '25", 'Notes'];
  const S = Object.fromEntries(strings.map((s, i) => [s, i]));

  const parts = [bof(0x0005), ...sstRecords(strings, S.Bearish), eof()];

  // Decoy worksheet without the sentiment header.
  parts.push(bof(0x0010), labelSst(0, 0, S.Notes), number(1, 0, 1), number(1, 3, 2), eof());

  parts.push(bof(0x0010));
  parts.push(labelSst(0, 5, S.Bullish)); // group label row, no Bearish beside it
  parts.push(labelSst(1, 0, S.Reported), labelSst(1, 6, S['Bull-Bear']));
  parts.push(labelSst(2, 0, S.Date), labelSst(2, 1, S.Bullish), labelSst(2, 2, S.Neutral), labelSst(2, 3, S.Bearish));
  for (let w = 0; w < FIXTURE_WEEKS; w++) {
    const row = 3 + w;
    const bull = 20 + (w % 40);
    const bear = 15 + (w % 30);
    const neutral = 100 - bull - bear;
    parts.push(number(row, 0, FIXTURE_FIRST_SERIAL + 7 * w));
    parts.push(mulrk(row, 1, [bull, neutral, bear]));
    parts.push(formula(row, 6, (bull - bear) / 100));
  }
  const footer = 3 + FIXTURE_WEEKS + 2;
  parts.push(labelSst(footer, 0, S["Count '25"]), mulrk(footer, 1, [5200, 5200, 5200]));
  parts.push(eof());

  const streamLen = parts.reduce((n, p) => n + p.length, 0);
  const stream = new Uint8Array(streamLen);
  let off = 0;
  for (const p of parts) { stream.set(p, off); off += p.length; }

  const streamSectors = Math.ceil(streamLen / SECTOR);
  let fatSectors = 1;
  while (fatSectors * (SECTOR / 4) < fatSectors + 1 + streamSectors) fatSectors++;
  const total = fatSectors + 1 + streamSectors;
  const dirSector = fatSectors;
  // Stream chunk k lives at sector ids assigned in reverse order.
  const chunkSector = (k) => fatSectors + 1 + (streamSectors - 1 - k);

  const fat = new Uint32Array(fatSectors * (SECTOR / 4)).fill(FREE);
  for (let f = 0; f < fatSectors; f++) fat[f] = FAT_SECT;
  fat[dirSector] = END_OF_CHAIN;
  for (let k = 0; k < streamSectors; k++) fat[chunkSector(k)] = k + 1 < streamSectors ? chunkSector(k + 1) : END_OF_CHAIN;

  const file = new Uint8Array(SECTOR * (1 + total));
  const dv = new DataView(file.buffer);
  [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1].forEach((b, j) => { file[j] = b; });
  dv.setUint16(0x18, 0x003E, true);
  dv.setUint16(0x1A, 0x0003, true);
  dv.setUint16(0x1C, 0xFFFE, true);
  dv.setUint16(0x1E, 9, true);
  dv.setUint16(0x20, 6, true);
  dv.setUint32(0x2C, fatSectors, true);
  dv.setUint32(0x30, dirSector, true);
  dv.setUint32(0x38, 4096, true);
  dv.setUint32(0x3C, END_OF_CHAIN, true);
  dv.setUint32(0x44, END_OF_CHAIN, true);
  for (let j = 0; j < 109; j++) dv.setUint32(0x4C + j * 4, j < fatSectors ? j : FREE, true);

  const sectorOff = (n) => (n + 1) * SECTOR;
  for (let f = 0; f < fatSectors; f++) {
    for (let j = 0; j < SECTOR / 4; j++) dv.setUint32(sectorOff(f) + j * 4, fat[f * (SECTOR / 4) + j], true);
  }

  const writeDirEntry = (idx, name, type, child, start, size) => {
    const base = sectorOff(dirSector) + idx * 128;
    for (let j = 0; j < name.length; j++) dv.setUint16(base + j * 2, name.charCodeAt(j), true);
    dv.setUint16(base + 0x40, (name.length + 1) * 2, true);
    file[base + 0x42] = type;
    dv.setUint32(base + 0x44, FREE, true);
    dv.setUint32(base + 0x48, FREE, true);
    dv.setUint32(base + 0x4C, child, true);
    dv.setUint32(base + 0x74, start, true);
    dv.setUint32(base + 0x78, size, true);
  };
  writeDirEntry(0, 'Root Entry', 5, 1, END_OF_CHAIN, 0);
  writeDirEntry(1, 'Workbook', 2, FREE, chunkSector(0), streamLen);

  for (let k = 0; k < streamSectors; k++) {
    file.set(stream.subarray(k * SECTOR, Math.min((k + 1) * SECTOR, streamLen)), sectorOff(chunkSector(k)));
  }
  return file.buffer;
}
