export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function keyFingerprint(key) {
  return (await sha256Hex(key)).slice(0, 16);
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
