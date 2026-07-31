export async function sha256Hex(str) {
  if (typeof str !== 'string') return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function keyFingerprint(key) {
  const hash = await sha256Hex(key);
  return hash === null ? null : hash.slice(0, 16);
}

export async function verifyPkceS256(codeVerifier, codeChallenge) {
  // Validate code_verifier: 43-128 chars, URL-safe charset [A-Za-z0-9-._~] (RFC 7636 §4.1)
  if (typeof codeVerifier !== 'string' ||
      codeVerifier.length < 43 || codeVerifier.length > 128 ||
      !/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) {
    return null; // null = invalid_request (malformed input)
  }
  // Validate code_challenge: base64url-encoded SHA-256 = exactly 43 chars, no padding
  if (typeof codeChallenge !== 'string' ||
      codeChallenge.length !== 43 ||
      !/^[A-Za-z0-9\-_]+$/.test(codeChallenge)) {
    return null;
  }
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const computed = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const enc = new TextEncoder();
  const a = enc.encode(computed), b = enc.encode(codeChallenge);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0; // true = match, false = wrong verifier; null = invalid_request
}

const MIN_TIMING_KEYS = 16;
const DUMMY_KEY_PREFIX = '__wm_timing_safe_dummy_key_constant_pad_';

export async function timingSafeIncludes(candidate, validKeys) {
  if (typeof candidate !== 'string' ||
      !candidate ||
      !Array.isArray(validKeys) ||
      !validKeys.length ||
      validKeys.some((key) => typeof key !== 'string')) {
    return false;
  }
  const enc = new TextEncoder();
  const candidateHash = await crypto.subtle.digest('SHA-256', enc.encode(candidate));
  const candidateBytes = new Uint8Array(candidateHash);

  // Pad the keys array to a constant block size (e.g. 16 or multiple of 16)
  // so that the total SHA-256 computation count and loop duration do not leak
  // the number of keys in the allowlist.
  const targetLength = Math.max(MIN_TIMING_KEYS, Math.ceil(validKeys.length / MIN_TIMING_KEYS) * MIN_TIMING_KEYS);
  const paddedKeys = validKeys.slice();
  while (paddedKeys.length < targetLength) {
    paddedKeys.push(`${DUMMY_KEY_PREFIX}${paddedKeys.length}`);
  }

  let matchBits = 0;
  for (const k of paddedKeys) {
    const kHash = await crypto.subtle.digest('SHA-256', enc.encode(k));
    const kBytes = new Uint8Array(kHash);
    let diff = 0;
    for (let i = 0; i < kBytes.length; i++) diff |= candidateBytes[i] ^ kBytes[i];
    // Constant-time bitwise conversion: diff === 0 -> 1, diff !== 0 -> 0.
    // Avoids data-dependent branching (if (diff === 0) found = true) which leaks
    // position/timing information via branch prediction and JIT deoptimization.
    const isMatch = ((diff - 1) >>> 31) & 1;
    matchBits |= isMatch;
  }
  return matchBits === 1;
}


export async function timingSafeEqualSecret(candidate, expected) {
  if (!candidate || !expected) return false;
  return timingSafeIncludes(candidate, [expected]);
}
