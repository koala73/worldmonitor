// Stored encoding for seed payloads that outgrow MAX_PAYLOAD_BYTES as JSON.
// A seeder opts in with runSeed({ compressPayload: true }). The prefix makes
// the stored value invalid JSON, so a reader that predates the encoding throws
// instead of treating the key as empty and starting over.
import { gunzipSync, gzipSync } from 'node:zlib';

export const GZIP_PAYLOAD_PREFIX = 'gz64:';

export function encodeGzipPayload(json) {
  return GZIP_PAYLOAD_PREFIX + gzipSync(Buffer.from(json, 'utf8')).toString('base64');
}

export function parseStoredSeedJson(raw) {
  if (typeof raw === 'string' && raw.startsWith(GZIP_PAYLOAD_PREFIX)) {
    const gz = Buffer.from(raw.slice(GZIP_PAYLOAD_PREFIX.length), 'base64');
    return JSON.parse(gunzipSync(gz).toString('utf8'));
  }
  return JSON.parse(raw);
}
