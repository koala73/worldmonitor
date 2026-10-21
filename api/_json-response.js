export function jsonResponse(body, status, headers = {}) {
  const json = JSON.stringify(body, function replaceError(key, value) {
    // JSON.stringify calls toJSON before the replacer. Read the original value
    // from its holder so an Error cannot expose stack/cause through a custom
    // toJSON implementation. Plain JSON properties with those names remain
    // ordinary protocol data.
    const original = this[key];
    return original instanceof Error ? { error: original.message } : value;
  });

  // Advertise byte length so MCP/REST usage telemetry can record a real
  // res_bytes instead of nulling unknown chunked sizes (#8403). Callers that
  // already set Content-Length keep their value (spread wins).
  const byteLength = new TextEncoder().encode(json).byteLength;

  return new Response(json, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(byteLength),
      ...headers,
    },
  });
}
