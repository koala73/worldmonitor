const TEXT_ENCODER = new TextEncoder();

function replaceError(key, value) {
  // JSON.stringify calls toJSON before the replacer. Read the original value
  // from its holder so an Error cannot expose stack/cause through a custom
  // toJSON implementation. Plain JSON properties with those names remain
  // ordinary protocol data.
  const original = this[key];
  return original instanceof Error ? { error: original.message } : value;
}

export function jsonResponse(body, status, headers = {}) {
  const json = JSON.stringify(body, replaceError);

  // Encode once: the same bytes give the exact Content-Length (#8403) and
  // go straight into the Response without a second encode.
  // Callers that already set Content-Length keep their value (spread wins).
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
