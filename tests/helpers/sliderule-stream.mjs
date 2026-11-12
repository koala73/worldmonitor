// Test helpers that build SlideRule native record streams (the inverse of the parser in
// scripts/_reservoir-levels.mjs): 8-byte big-endian header (int16 version 2, int16
// typeSize, int32 dataSize), NUL-terminated type string, little-endian payload.

export function encodeRecord(type, payload) {
  const typeBuf = Buffer.from(`${type}\0`, 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt16BE(2, 0);
  header.writeInt16BE(typeBuf.length, 2);
  header.writeInt32BE(payload.length, 4);
  return Buffer.concat([header, typeBuf, payload]);
}

function nameField(name = 'atl13.csv') {
  const b = Buffer.alloc(128);
  b.write(name, 'utf8');
  return b;
}

export function arrowMeta(size) {
  const s = Buffer.alloc(8);
  s.writeBigInt64LE(BigInt(size));
  return encodeRecord('arrowrec.meta', Buffer.concat([nameField(), s]));
}

export function arrowData(bytes) {
  return encodeRecord('arrowrec.data', Buffer.concat([nameField(), Buffer.from(bytes)]));
}

export function arrowEof() {
  return encodeRecord('arrowrec.eof', Buffer.concat([nameField(), Buffer.alloc(8)]));
}

export function eventRecord(message, level = 1) {
  const b = Buffer.alloc(60);
  b.writeBigInt64LE(0n, 0);
  b.writeUInt32LE(level, 8);
  return encodeRecord('eventrec', Buffer.concat([b, Buffer.from(`${message}\0`, 'utf8')]));
}

export function exceptRecord(message, code = -1, level = 3) {
  const b = Buffer.alloc(8 + 256);
  b.writeInt32LE(code, 0);
  b.writeUInt32LE(level, 4);
  b.write(message, 8, 'utf8');
  return encodeRecord('exceptrec', b);
}

/** A complete CSV file delivered as arrowrec records, split into data chunks of chunkBytes. */
export function csvFileRecords(csvText, chunkBytes = 64) {
  const bytes = Buffer.from(csvText, 'utf8');
  const out = [arrowMeta(bytes.length)];
  for (let i = 0; i < bytes.length; i += chunkBytes) out.push(arrowData(bytes.subarray(i, i + chunkBytes)));
  out.push(arrowEof());
  return out;
}

/** Split a buffer into chunks of the given sizes (cycled), to exercise every boundary. */
export function splitEvery(buf, sizes) {
  const out = [];
  let i = 0;
  let k = 0;
  while (i < buf.length) {
    const n = sizes[k++ % sizes.length];
    out.push(buf.subarray(i, i + n));
    i += n;
  }
  return out;
}

/** A fetch Response-like object whose body yields the given chunks. */
export function streamResponse(chunks, { status = 200, contentType = 'application/octet-stream' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    body: (async function* gen() { for (const c of chunks) yield new Uint8Array(c); })(),
    text: async () => Buffer.concat(chunks).toString('utf8'),
  };
}

export const CSV_HEADER = 'time_ns,gt,segment_id_beg,longitude,rgt,stdev_water_surf,spot,water_depth,ht_water_surf,ht_ortho,srcid,cycle,latitude,atl13refid';

/** Build CSV text from simple row objects { t: isoString, rgt, gt, h, lat?, lon?, refid? }. */
export function csvFromRows(rows) {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    const ns = BigInt(Date.parse(r.t)) * 1000000n;
    lines.push([ns, r.gt ?? 10, 1, r.lon ?? 0, r.rgt, 0.01, 1, 0, r.h, r.h, 0, 1, r.lat ?? 0, r.refid ?? 1].join(','));
  }
  return `${lines.join('\n')}\n`;
}

// Columns of a SlideRule atl06x CSV with atl06_fields ["dem/geoid_h"] (subset of the real
// 26-column file, same names).
export const ATL06_CSV_HEADER = 'time_ns,gt,longitude,atl06_quality_summary,rgt,dh_fit_dx,dem/geoid_h,cycle,h_li,latitude';

/**
 * Build atl06x CSV text from rows { t: isoString, rgt, gt, h (orthometric), geoid?, q?, dx? }.
 * h_li is written as h + geoid, so h_li - geoid_h gives back h.
 */
export function csvFromAtl06Rows(rows) {
  const lines = [ATL06_CSV_HEADER];
  for (const r of rows) {
    const ns = BigInt(Date.parse(r.t)) * 1000000n;
    const geoid = r.geoid ?? -30;
    lines.push([ns, r.gt ?? 10, r.lon ?? 0, r.q ?? 0, r.rgt, r.dx ?? 0, geoid, 1, r.h + geoid, r.lat ?? 0].join(','));
  }
  return `${lines.join('\n')}\n`;
}
