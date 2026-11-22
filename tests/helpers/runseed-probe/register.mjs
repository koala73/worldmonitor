import { register } from 'node:module';

globalThis.fetch = () => Promise.reject(new Error('runseed-probe: network disabled'));
register('./hooks.mjs', import.meta.url);
