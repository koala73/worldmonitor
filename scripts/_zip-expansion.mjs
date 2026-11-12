import { inflateRawSync } from 'node:zlib';

/**
 * Throws unless every entry of the ZIP inflates to at most `maxBytes` in
 * total. Entries are inflated with a bounded output, so the sizes the archive
 * declares are not trusted. Run before JSZip inflates anything.
 */
export function assertZipExpansionWithin(buf, maxBytes) {
  const bad = (why) => new Error(`not a readable ZIP (${why})`);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('no end of central directory');
  // Walk records by signature, as JSZip does: the declared entry count can
  // understate the directory and leave entries unmeasured.
  const declared = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  let total = 0;
  let seen = 0;
  while (at + 46 <= buf.length && buf.readUInt32LE(at) === 0x02014b50) {
    seen++;
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const local = buf.readUInt32LE(at + 42);
    at += 46 + buf.readUInt16LE(at + 28) + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    if (compressed === 0xffffffff || local === 0xffffffff) throw bad('ZIP64');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad('local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + compressed > buf.length) throw bad('truncated entry');
    const data = buf.subarray(start, start + compressed);
    const left = maxBytes - total;
    if (method === 0) {
      total += data.length;
    } else if (method === 8) {
      try {
        total += inflateRawSync(data, { maxOutputLength: left + 1 }).length;
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE') total = maxBytes + 1;
        else throw bad(err.message);
      }
    } else {
      throw bad(`compression method ${method}`);
    }
    if (total > maxBytes) throw new Error(`document expands past ${maxBytes} bytes`);
  }
  if (seen === 0 || seen < declared) throw bad('central directory');
}
