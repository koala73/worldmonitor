export async function sha256Hex(str) {
  if (typeof str !== 'string') return null;

  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(str)
  );

  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function keyFingerprint(key) {
  const hash = await sha256Hex(key);
  return hash === null ? null : hash.slice(0, 16);
}

export async function verifyPkceS256(codeVerifier, codeChallenge) {
  if (
    typeof codeVerifier !== 'string' ||
    codeVerifier.length < 43 ||
    codeVerifier.length > 128 ||
    !/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)
  ) {
    return null;
  }

  if (
    typeof codeChallenge !== 'string' ||
    codeChallenge.length !== 43 ||
    !/^[A-Za-z0-9\-_]+$/.test(codeChallenge)
  ) {
    return null;
  }

  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier)
  );

  const computed = btoa(
    String.fromCharCode(...new Uint8Array(hash))
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const a = new TextEncoder().encode(computed);
  const b = new TextEncoder().encode(codeChallenge);

  let diff = a.length ^ b.length;

  const max = Math.max(a.length, b.length);

  for (let i = 0; i < max; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }

  return diff === 0;
}

export async function timingSafeIncludes(candidate, validKeys) {
  if (
    typeof candidate !== 'string' ||
    !candidate ||
    !Array.isArray(validKeys) ||
    !validKeys.length ||
    validKeys.some((key) => typeof key !== 'string')
  ) {
    return false;
  }

  const enc = new TextEncoder();

  const candidateHash = await crypto.subtle.digest(
    'SHA-256',
    enc.encode(candidate)
  );

  const candidateBytes = new Uint8Array(candidateHash);

  let found = false;

  for (const key of validKeys) {
    const keyHash = await crypto.subtle.digest(
      'SHA-256',
      enc.encode(key)
    );

    const keyBytes = new Uint8Array(keyHash);

    let diff = 0;

    for (let i = 0; i < candidateBytes.length; i++) {
      diff |= candidateBytes[i] ^ keyBytes[i];
    }

    if (diff === 0) {
      found = true;
    }
  }

  return found;
}


export async function timingSafeEqualSecret(candidate, expected) {
  if (
    typeof candidate !== 'string' ||
    typeof expected !== 'string' ||
    !candidate ||
    !expected
  ) {
    return false;
  }

  const enc = new TextEncoder();

  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(candidate)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);

  const a = new Uint8Array(candidateHash);
  const b = new Uint8Array(expectedHash);

  let diff = 0;

  // Fixed 32-byte SHA-256 digest comparison
  for (let i = 0; i < 32; i++) {
    diff |= a[i] ^ b[i];
  }

  return diff === 0;
}
