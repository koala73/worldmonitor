// Baseline JPEG decoder (Huffman, 8-bit, YCbCr / grayscale, any chroma
// subsampling, restart intervals). Satellite tiles are baseline JPEGs; this
// turns them into RGBA like png.mjs so the imagery path stays dependency-free.
// Progressive and arithmetic-coded files throw.

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

// Separable float IDCT with a precomputed cosine table.
const COS = new Float32Array(64);
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);

function buildHuffman(counts, symbols) {
  // Canonical Huffman: lookup by (length, code) using maxcode/valptr tables.
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    valptr[len] = k;
    mincode[len] = code;
    code += counts[len - 1];
    k += counts[len - 1];
    maxcode[len] = counts[len - 1] ? code - 1 : -1;
    code <<= 1;
  }
  // Fast 9-bit lookup for short codes.
  const fast = new Int16Array(512).fill(-1);
  code = 0;
  k = 0;
  for (let len = 1; len <= 9; len++) {
    for (let i = 0; i < counts[len - 1]; i++) {
      const base = code << (9 - len);
      for (let j = 0; j < 1 << (9 - len); j++) fast[base + j] = (len << 8) | symbols[k];
      code++;
      k++;
    }
    code <<= 1;
  }
  return { maxcode, valptr, mincode, symbols, fast };
}

class BitReader {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos;
    this.bits = 0;
    this.nbits = 0;
    this.marker = false;
  }

  fill() {
    while (this.nbits <= 24) {
      let b = 0;
      if (!this.marker && this.pos < this.buf.length) {
        b = this.buf[this.pos];
        if (b === 0xff) {
          const next = this.buf[this.pos + 1];
          if (next === 0) this.pos += 2;
          else {
            this.marker = true; // a real marker: feed zeros from here on
            b = 0;
          }
        } else this.pos++;
      }
      this.bits |= b << (24 - this.nbits);
      this.nbits += 8;
    }
  }

  peek(n) {
    if (this.nbits < n) this.fill();
    return (this.bits >>> (32 - n)) & ((1 << n) - 1);
  }

  skip(n) {
    this.bits <<= n;
    this.nbits -= n;
  }

  bit() {
    const v = this.peek(1);
    this.skip(1);
    return v;
  }

  receive(n) {
    if (!n) return 0;
    const v = this.peek(n);
    this.skip(n);
    return v;
  }

  receiveExtend(n) {
    if (!n) return 0;
    const v = this.receive(n);
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  }

  decode(table) {
    const look = this.peek(9);
    const hit = table.fast[look];
    if (hit >= 0) {
      this.skip(hit >> 8);
      return hit & 0xff;
    }
    let code = this.receive(9);
    for (let len = 10; len <= 16; len++) {
      code = (code << 1) | this.bit();
      if (table.maxcode[len] >= 0 && code <= table.maxcode[len]) return table.symbols[table.valptr[len] + code - table.mincode[len]];
    }
    throw new Error('bad Huffman code');
  }

  // Byte-align and consume a restart marker (FFD0..FFD7).
  restart() {
    this.bits = 0;
    this.nbits = 0;
    this.marker = false;
    while (this.pos + 1 < this.buf.length) {
      if (this.buf[this.pos] === 0xff && this.buf[this.pos + 1] >= 0xd0 && this.buf[this.pos + 1] <= 0xd7) {
        this.pos += 2;
        return;
      }
      this.pos++;
    }
  }
}

function idctBlock(coef, out) {
  const tmp = new Float32Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += COS[x * 8 + u] * coef[y * 8 + u];
      tmp[y * 8 + x] = s / 2;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += COS[y * 8 + v] * tmp[v * 8 + x];
      const val = Math.round(s / 2 + 128);
      out[y * 8 + x] = val < 0 ? 0 : val > 255 ? 255 : val;
    }
  }
}

export function decodeJpeg(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  const qt = [];
  const dcTables = [];
  const acTables = [];
  let frame = null;
  let restartInterval = 0;
  let adobe = null;
  let pos = 2;
  let pixels = null;
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = buf[pos + 1];
    pos += 2;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) continue;
    if (marker === 0xd9) break;
    const len = buf.readUInt16BE(pos);
    const segEnd = pos + len;
    const p = pos + 2;
    if (marker === 0xdb) {
      let q = p;
      while (q < segEnd) {
        const pq = buf[q] >> 4;
        const tq = buf[q] & 15;
        q++;
        const table = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          table[ZIGZAG[i]] = pq ? buf.readUInt16BE(q + i * 2) : buf[q + i];
        }
        q += pq ? 128 : 64;
        qt[tq] = table;
      }
    } else if (marker === 0xc4) {
      let q = p;
      while (q < segEnd) {
        const tc = buf[q] >> 4;
        const th = buf[q] & 15;
        q++;
        const counts = Array.from(buf.subarray(q, q + 16));
        q += 16;
        const total = counts.reduce((a, b) => a + b, 0);
        const symbols = Array.from(buf.subarray(q, q + total));
        q += total;
        (tc === 0 ? dcTables : acTables)[th] = buildHuffman(counts, symbols);
      }
    } else if (marker === 0xdd) {
      restartInterval = buf.readUInt16BE(p);
    } else if (marker === 0xee) {
      if (buf.toString('latin1', p, p + 5) === 'Adobe') adobe = { transform: buf[p + 11] };
    } else if (marker === 0xc0 || marker === 0xc1) {
      const precision = buf[p];
      if (precision !== 8) throw new Error(`unsupported JPEG precision ${precision}`);
      const height = buf.readUInt16BE(p + 1);
      const width = buf.readUInt16BE(p + 3);
      const n = buf[p + 5];
      const components = [];
      for (let i = 0; i < n; i++) {
        const id = buf[p + 6 + i * 3];
        const h = buf[p + 7 + i * 3] >> 4;
        const v = buf[p + 7 + i * 3] & 15;
        const tq = buf[p + 8 + i * 3];
        components.push({ id, h, v, tq });
      }
      const hmax = Math.max(...components.map((c) => c.h));
      const vmax = Math.max(...components.map((c) => c.v));
      const mcusX = Math.ceil(width / (8 * hmax));
      const mcusY = Math.ceil(height / (8 * vmax));
      for (const c of components) {
        c.blocksW = mcusX * c.h;
        c.blocksH = mcusY * c.v;
        c.data = new Uint8Array(c.blocksW * 8 * c.blocksH * 8);
        c.stride = c.blocksW * 8;
        c.pred = 0;
      }
      frame = { width, height, components, hmax, vmax, mcusX, mcusY };
    } else if (marker === 0xc2 || marker === 0xc3 || (marker >= 0xc5 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc)) {
      throw new Error('progressive or lossless JPEG not supported');
    } else if (marker === 0xda) {
      if (!frame) throw new Error('SOS before SOF');
      const ns = buf[p];
      const scan = [];
      for (let i = 0; i < ns; i++) {
        const id = buf[p + 1 + i * 2];
        const tables = buf[p + 2 + i * 2];
        const comp = frame.components.find((c) => c.id === id);
        comp.dc = dcTables[tables >> 4];
        comp.ac = acTables[tables & 15];
        scan.push(comp);
      }
      const reader = new BitReader(buf, segEnd);
      decodeScan(reader, frame, scan, qt, restartInterval);
      pos = reader.pos;
      // Find the next marker.
      while (pos < buf.length && !(buf[pos] === 0xff && buf[pos + 1] !== 0 && !(buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7))) pos++;
      continue;
    }
    pos = segEnd;
  }
  if (!frame) throw new Error('JPEG without frame');
  pixels = toRgba(frame, adobe);
  return { width: frame.width, height: frame.height, data: pixels };
}

function decodeScan(reader, frame, scan, qt, restartInterval) {
  const coef = new Float32Array(64);
  const block = new Uint8Array(64);
  const single = scan.length === 1;
  const decodeBlock = (c, bx, by) => {
    coef.fill(0);
    const t = reader.decode(c.dc);
    const diff = t === 0 ? 0 : reader.receiveExtend(t);
    c.pred += diff;
    const q = qt[c.tq];
    coef[0] = c.pred * q[0];
    let k = 1;
    while (k < 64) {
      const rs = reader.decode(c.ac);
      const s = rs & 15;
      const r = rs >> 4;
      if (s === 0) {
        if (r < 15) break;
        k += 16;
        continue;
      }
      k += r;
      if (k > 63) break;
      const z = ZIGZAG[k];
      coef[z] = reader.receiveExtend(s) * q[z];
      k++;
    }
    idctBlock(coef, block);
    const x0 = bx * 8;
    const y0 = by * 8;
    if (x0 + 8 > c.stride || y0 + 8 > c.blocksH * 8) return;
    for (let y = 0; y < 8; y++) {
      const row = (y0 + y) * c.stride + x0;
      for (let x = 0; x < 8; x++) c.data[row + x] = block[y * 8 + x];
    }
  };
  let mcu = 0;
  const total = single ? Math.ceil(frame.width / 8 / (frame.hmax / scan[0].h)) * Math.ceil(frame.height / 8 / (frame.vmax / scan[0].v)) : frame.mcusX * frame.mcusY;
  const perRow = single ? Math.ceil(frame.width / 8 / (frame.hmax / scan[0].h)) : frame.mcusX;
  while (mcu < total) {
    if (restartInterval && mcu > 0 && mcu % restartInterval === 0) {
      reader.restart();
      for (const c of scan) c.pred = 0;
    }
    const mx = mcu % perRow;
    const my = Math.floor(mcu / perRow);
    if (single) decodeBlock(scan[0], mx, my);
    else {
      for (const c of scan) {
        for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) decodeBlock(c, mx * c.h + h, my * c.v + v);
      }
    }
    mcu++;
    if (reader.marker && reader.nbits <= 0) break;
  }
}

function toRgba(frame, adobe) {
  const { width, height, components, hmax, vmax } = frame;
  const out = new Uint8Array(width * height * 4);
  const sample = (c, x, y) => {
    const sx = Math.min(c.stride - 1, Math.floor((x * c.h) / hmax));
    const sy = Math.min(c.blocksH * 8 - 1, Math.floor((y * c.v) / vmax));
    return c.data[sy * c.stride + sx];
  };
  const transform = components.length === 3 && (!adobe || adobe.transform !== 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (components.length === 1) {
        const g = sample(components[0], x, y);
        out[o] = out[o + 1] = out[o + 2] = g;
      } else if (transform) {
        const Y = sample(components[0], x, y);
        const cb = sample(components[1], x, y) - 128;
        const cr = sample(components[2], x, y) - 128;
        out[o] = clamp(Y + 1.402 * cr);
        out[o + 1] = clamp(Y - 0.344136 * cb - 0.714136 * cr);
        out[o + 2] = clamp(Y + 1.772 * cb);
      } else {
        out[o] = sample(components[0], x, y);
        out[o + 1] = sample(components[1], x, y);
        out[o + 2] = sample(components[2], x, y);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
