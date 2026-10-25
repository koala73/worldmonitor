// Minimal PNG decoder for satellite imagery tiles: 8-bit, non-interlaced,
// colour types gray / RGB / palette / gray+alpha / RGBA. Returns RGBA bytes.
// The dashboard only needs to turn a few-kilobyte tile into cell colours, so
// this stays dependency-free instead of pulling in a full image library.
import { inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_SIDE = 4096;

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  for (let i = 0; i < 8; i++) if (buf[i] !== SIGNATURE[i]) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!width || !height) throw new Error('PNG without IHDR');
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace) throw new Error('interlaced PNG not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  // The map never asks for more than a couple of thousand pixels a side; refuse
  // anything bigger before allocating, and cap inflate at the size IHDR implies.
  if (width > MAX_SIDE || height > MAX_SIDE) throw new Error(`PNG too large (${width}x${height})`);
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let off = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[off++];
    const line = new Uint8Array(raw.subarray(off, off + stride));
    off += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const i = x * channels;
      if (colorType === 6) {
        out[o] = line[i];
        out[o + 1] = line[i + 1];
        out[o + 2] = line[i + 2];
        out[o + 3] = line[i + 3];
      } else if (colorType === 2) {
        out[o] = line[i];
        out[o + 1] = line[i + 1];
        out[o + 2] = line[i + 2];
        out[o + 3] = 255;
      } else if (colorType === 0) {
        out[o] = out[o + 1] = out[o + 2] = line[i];
        out[o + 3] = 255;
      } else if (colorType === 4) {
        out[o] = out[o + 1] = out[o + 2] = line[i];
        out[o + 3] = line[i + 1];
      } else {
        const p = line[i] * 3;
        out[o] = palette ? palette[p] : 0;
        out[o + 1] = palette ? palette[p + 1] : 0;
        out[o + 2] = palette ? palette[p + 2] : 0;
        out[o + 3] = trns && line[i] < trns.length ? trns[line[i]] : 255;
      }
    }
    prev = line;
  }
  return { width, height, data: out };
}

// Nearest-neighbour sample at normalised coordinates (0..1). Returns [r,g,b]
// or null when the pixel is transparent.
export function samplePixel(img, u, v) {
  const x = Math.max(0, Math.min(img.width - 1, Math.floor(u * img.width)));
  const y = Math.max(0, Math.min(img.height - 1, Math.floor(v * img.height)));
  const o = (y * img.width + x) * 4;
  if (img.data[o + 3] < 8) return null;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}
