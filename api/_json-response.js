const TEXT_ENCODER = new TextEncoder();

function replaceError(key, value) {
  // JSON.stringify calls toJSON before the replacer. Read the original value
  // from its holder so an Error cannot expose stack/cause through a custom
  // toJSON implementation. Plain JSON properties with those names remain
  // ordinary protocol data.
  const original = this[key];
  return original instanceof Error ? { error: original.message } : value;
}

/**
 * Fast iterative check for Error instances or cyclic references.
 * When false (99.9%+ of API payloads), JSON.stringify(body) can take V8's C++
 * fast path without per-property JS replacer callbacks.
 */
function needsErrorReplacer(root) {
  if (root === null || typeof root !== 'object') return false;
  if (root instanceof Error) return true;
  const seen = new Set();
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (seen.has(cur)) return true; // let JSON.stringify throw native circular error
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i += 1) {
        const v = cur[i];
        if (v !== null && typeof v === 'object') {
          if (v instanceof Error) return true;
          stack.push(v);
        }
      }
    } else {
      for (const k in cur) {
        if (!Object.prototype.hasOwnProperty.call(cur, k)) continue;
        const v = cur[k];
        if (v !== null && typeof v === 'object') {
          if (v instanceof Error) return true;
          stack.push(v);
        }
      }
    }
  }
  return false;
}

export function jsonResponse(body, status, headers = {}) {
  const json = needsErrorReplacer(body)
    ? JSON.stringify(body, replaceError)
    : JSON.stringify(body);

  // Encode once to UTF-8 bytes so we both measure exact Content-Length (#8403)
  // and pass the encoded Uint8Array directly to Response without re-encoding.
  const bytes = TEXT_ENCODER.encode(json);

  return new Response(bytes, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(bytes.byteLength),
      ...headers,
    },
  });
}
