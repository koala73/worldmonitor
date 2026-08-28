// Shared publisher/serving handshake for bootstrap KV envelopes.
// The Railway publisher writes this version; classifyKvEnvelope requires it
// so a freshly deployed Worker cannot serve a legacy `{ tier, generatedAt, payload }`
// envelope still sitting in KV.
export const KV_ENVELOPE_SCHEMA_VERSION = 1;
