'use strict';

// Loaded with --require into a spawned relay. Sends every request for
// openrouter.ai (the cross-wording embeddings and "same incident?" judge) to
// the local stand-in at TEST_OPENROUTER_URL, keeping the path. Every other
// request is untouched.

const target = process.env.TEST_OPENROUTER_URL;
if (!target) throw new Error('TEST_OPENROUTER_URL is required');
const realFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' || input instanceof URL ? new URL(input) : null;
  if (url?.hostname !== 'openrouter.ai') return realFetch(input, init);
  return realFetch(new URL(url.pathname + url.search, target), init);
};
