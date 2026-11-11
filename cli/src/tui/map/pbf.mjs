// Mapbox Vector Tile (MVT) decoder: a minimal protobuf reader plus the tile
// schema. Produces plain features with tile-space geometry (0..extent) so the
// map can project them. Zero dependencies.
import { gunzipSync } from 'node:zlib';

class Pbf {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  varint() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.buf[this.pos++];
      if (shift < 28) result |= (b & 0x7f) << shift;
      else result += (b & 0x7f) * 2 ** shift; // beyond 32 bits: lose precision gracefully
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 63) throw new Error('varint too long');
    }
    return result >>> 0 === result ? result : result;
  }

  svarint() {
    const n = this.varint();
    return n % 2 === 1 ? -(n + 1) / 2 : n / 2;
  }

  bytes() {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string() {
    return Buffer.from(this.bytes()).toString('utf8');
  }

  fixed32() {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  float() {
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  double() {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const len = this.varint();
      this.pos += len;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }

  // Iterate fields until `end`; cb(field, wire, pbf).
  fields(end, cb) {
    while (this.pos < end) {
      const key = this.varint();
      const field = key >> 3;
      const wire = key & 7;
      const before = this.pos;
      cb(field, wire, this);
      if (this.pos === before) this.skip(wire);
    }
  }
}

export function readValue(pbf) {
  const len = pbf.varint();
  const end = pbf.pos + len;
  let value = null;
  pbf.fields(end, (f, _w, p) => {
    if (f === 1) value = p.string();
    else if (f === 2) value = p.float();
    else if (f === 3) value = p.double();
    else if (f === 4) value = p.varint();
    else if (f === 5) value = p.varint();
    else if (f === 6) value = p.svarint();
    else if (f === 7) value = Boolean(p.varint());
  });
  return value;
}

function readGeometry(data, type) {
  const p = new Pbf(data);
  const parts = [];
  let ring = null;
  let x = 0;
  let y = 0;
  while (p.pos < data.length) {
    const cmdInt = p.varint();
    const cmd = cmdInt & 7;
    let count = cmdInt >> 3;
    if (cmd === 1) {
      while (count-- > 0) {
        x += p.svarint();
        y += p.svarint();
        ring = [[x, y]];
        parts.push(ring);
      }
    } else if (cmd === 2) {
      while (count-- > 0) {
        x += p.svarint();
        y += p.svarint();
        if (ring) ring.push([x, y]);
      }
    } else if (cmd === 7) {
      if (ring && ring.length) ring.push(ring[0]);
    } else throw new Error(`bad geometry command ${cmd}`);
  }
  if (type === 1) return parts.map((r) => r[0]); // points
  return parts;
}

function readFeature(pbf, layer) {
  const len = pbf.varint();
  const end = pbf.pos + len;
  const feature = { id: null, type: 0, props: {}, geomRaw: null };
  pbf.fields(end, (f, _w, p) => {
    if (f === 1) feature.id = p.varint();
    else if (f === 2) {
      const tLen = p.varint();
      const tEnd = p.pos + tLen;
      while (p.pos < tEnd) {
        const k = p.varint();
        const v = p.varint();
        feature.props[layer.keys[k]] = layer.values[v];
      }
    } else if (f === 3) feature.type = p.varint();
    else if (f === 4) feature.geomRaw = p.bytes();
  });
  return feature;
}

export function readLayer(pbf) {
  const len = pbf.varint();
  const end = pbf.pos + len;
  const layer = { name: '', extent: 4096, keys: [], values: [], features: [] };
  const pending = [];
  pbf.fields(end, (f, _w, p) => {
    if (f === 1) layer.name = p.string();
    else if (f === 2) pending.push(p.pos); // not consumed here, so fields() skips the message
    else if (f === 3) layer.keys.push(p.string());
    else if (f === 4) layer.values.push(readValue(p));
    else if (f === 5) layer.extent = p.varint();
  });
  // Features reference keys/values, which may appear after them in the stream:
  // decode them in a second pass.
  for (const pos of pending) {
    const p2 = new Pbf(pbf.buf);
    p2.pos = pos;
    const feat = readFeature(p2, layer);
    feat.geometry = feat.geomRaw ? readGeometry(feat.geomRaw, feat.type) : [];
    delete feat.geomRaw;
    layer.features.push(feat);
  }
  return layer;
}

// Decode a tile buffer into { layers: { [name]: layer } }.
export function decodeTile(input) {
  let buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf); // tiles are usually served gzip-compressed
  const pbf = new Pbf(buf);
  const layers = {};
  pbf.fields(pbf.buf.length, (f, _w, p) => {
    if (f === 3) {
      const layer = readLayer(p);
      layers[layer.name] = layer;
    }
  });
  return { layers };
}

export { Pbf };
