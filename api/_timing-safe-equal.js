/**
 * Edge-safe constant-time string comparison for API helpers.
 *
 * Both strings are first hashed to fixed-size SHA-256 digests. The byte
 * comparison then runs over the digest length, so unequal raw input lengths do
 * not skip the fixed-cost crypto path.
 */
export async function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const aHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(a)));
  const bHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(b)));
  let diff = 0;
  for (let i = 0; i < aHash.length; i++) diff |= aHash[i] ^ bHash[i];
  return diff === 0;
}
