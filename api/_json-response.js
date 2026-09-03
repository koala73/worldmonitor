export function jsonResponse(body, status, headers = {}) {
  const json = JSON.stringify(body, function replaceError(key, value) {
    // JSON.stringify calls toJSON before the replacer. Read the original value
    // from its holder so an Error cannot expose stack/cause through a custom
    // toJSON implementation. Plain JSON properties with those names remain
    // ordinary protocol data.
    const original = this[key];
    return original instanceof Error ? { error: original.message } : value;
  });

  return new Response(json, {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}
