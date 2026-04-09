#!/usr/bin/env node

import { loadEnvFile, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'energy:chokepoint-baselines:v1';
export const CHOKEPOINT_TTL_SECONDS = 34_560_000;

export const CHOKEPOINTS = [
  { id: 'hormuz',  relayId: 'hormuz_strait',  name: 'Strait of Hormuz',   mbd: 21.0, lat: 26.6, lon: 56.3  },
  { id: 'malacca', relayId: 'malacca_strait', name: 'Strait of Malacca',  mbd: 17.2, lat: 1.3,  lon: 103.8 },
  { id: 'suez',    relayId: 'suez',           name: 'Suez Canal / SUMED', mbd: 7.6,  lat: 30.7, lon: 32.3  },
  { id: 'babelm',  relayId: 'bab_el_mandeb',  name: 'Bab el-Mandeb',      mbd: 6.2,  lat: 12.6, lon: 43.4  },
  { id: 'danish',  relayId: 'dover_strait',   name: 'Danish Straits',      mbd: 3.0,  lat: 57.5, lon: 10.5  },
  { id: 'turkish', relayId: 'bosphorus',      name: 'Turkish Straits',     mbd: 2.9,  lat: 41.1, lon: 29.0  },
  { id: 'panama',  relayId: 'panama',         name: 'Panama Canal',        mbd: 0.9,  lat: 9.1,  lon: -79.7 },
];

export function buildPayload() {
  return {
    source: 'EIA World Oil Transit Chokepoints',
    referenceYear: 2023,
    updatedAt: new Date().toISOString(),
    chokepoints: CHOKEPOINTS,
  };
}

export function validateFn(data) {
  return Array.isArray(data?.chokepoints) && data.chokepoints.length === 7;
}

const isMain = process.argv[1]?.endsWith('seed-chokepoint-baselines.mjs');
if (isMain) {
  runSeed('energy', 'chokepoint-baselines', CANONICAL_KEY, buildPayload, {
    validateFn,
    ttlSeconds: CHOKEPOINT_TTL_SECONDS,
    sourceVersion: 'eia-chokepoint-baselines-v1',
    recordCount: (data) => data?.chokepoints?.length || 0,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
