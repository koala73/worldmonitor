/**
 * FNV-1a 52-bit hash — fast, non-cryptographic.
 *
 * WARNING: Do NOT use for cache keys derived from attacker-controlled input.
 * Use sha256Hex() instead for any server-side cache key with user input.
 * Retained for client-side non-security contexts (e.g. vector-db dedup).
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
 * SHA-256 hex digest via Web Crypto (available in Edge/Vercel/Node 18+).
 * Use for all server-side cache keys derived from user-controlled input.
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
