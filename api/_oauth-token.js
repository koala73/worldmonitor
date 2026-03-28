// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash } from './_upstash-json.js';

export async function resolveApiKeyFromBearer(req) {
  const hdr = req.headers.get('Authorization') || '';
  if (!hdr.startsWith('Bearer ')) return null;
  const token = hdr.slice(7).trim();
  if (!token) return null;
  const apiKey = await readJsonFromUpstash(`oauth:token:${token}`);
  return typeof apiKey === 'string' && apiKey ? apiKey : null;
}
