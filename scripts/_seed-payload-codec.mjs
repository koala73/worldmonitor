// Stored encoding for seed payloads that outgrow MAX_PAYLOAD_BYTES as JSON.
// A seeder opts in with runSeed({ compressPayload: true }). The prefix makes
// the stored value invalid JSON, so a reader that predates the encoding throws
// instead of treating the key as empty and starting over.
import { gunzipSync, gzipSync } from 'node:zlib';

export const GZIP_PAYLOAD_PREFIX = 'gz64:';
// The publish cap measures encoded bytes, so bound the inflated size too. The
// resolution ledger inflates about 4x; this leaves room past the 8MiB budget.
export const MAX_DECODED_PAYLOAD_BYTES = 64 * 1024 * 1024;

export function encodeGzipPayload(json) {
  return GZIP_PAYLOAD_PREFIX + gzipSync(Buffer.from(json, 'utf8')).toString('base64');
}

export function parseStoredSeedJson(raw) {
  if (typeof raw === 'string' && raw.startsWith(GZIP_PAYLOAD_PREFIX)) {
    const gz = Buffer.from(raw.slice(GZIP_PAYLOAD_PREFIX.length), 'base64');
    return JSON.parse(gunzipSync(gz, { maxOutputLength: MAX_DECODED_PAYLOAD_BYTES }).toString('utf8'));
  }
  return JSON.parse(raw);
}
