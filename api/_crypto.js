export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function keyFingerprint(key) {
  return (await sha256Hex(key)).slice(0, 16);
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

export async function timingSafeIncludes(candidate, validKeys) {
  if (!candidate || !validKeys.length) return false;
  const enc = new TextEncoder();
  const candidateHash = await crypto.subtle.digest('SHA-256', enc.encode(candidate));
  const candidateBytes = new Uint8Array(candidateHash);
  let found = false;
  for (const k of validKeys) {
    const kHash = await crypto.subtle.digest('SHA-256', enc.encode(k));
    const kBytes = new Uint8Array(kHash);
    let diff = 0;
    for (let i = 0; i < kBytes.length; i++) diff |= candidateBytes[i] ^ kBytes[i];
    if (diff === 0) found = true;
  }
  return found;
}
