/**
 * FNV-1a 52-bit hash — fast, non-cryptographic.
 *
 * WARNING: Do NOT use for cache keys derived from attacker-controlled input.
 * The state is only 52 bits and every step is invertible (XOR is its own
 * inverse, and multiplying by the odd FNV prime modulo 2^52 is a bijection),
 * so a meet-in-the-middle second-preimage search costs seconds of CPU rather
 * than the 2^52 a digest of this width suggests. An attacker who can pick the
 * input can therefore force two different values onto one key. Use sha256Hex()
 * for anything where a collision is a security event.
 *
 * Retained for non-security contexts: dedup, bucketing, change detection.
 */
export function hashString(input: string): string {
  let h = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK_52 = (1n << 52n) - 1n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK_52;
  }
  return Number(h).toString(36);
}

/**
 * SHA-256 hex digest over Web Crypto, which is present in browsers, on Vercel
 * Edge and in Node 18+. One implementation therefore covers every runtime that
 * mints a cache key, which matters because client and server must derive the
 * same key byte-for-byte.
 *
 * Mirrors server/_shared/hash.ts::sha256Hex. Keep the two identical.
 */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
