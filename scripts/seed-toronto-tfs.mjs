#!/usr/bin/env node
// Toronto Fire Services live CAD (#6682). World Monitor has confirmed direct
// redistribution and public-display rights for this feed.
// Own key — do not append to canadaAlerts / canadaRoads / torontoRoads.

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import {
  TFS_KEY,
  TFS_MAX_STALE_MIN,
  TFS_SOURCE_VERSION,
  TFS_TTL_SECONDS,
  declareTfsRecords,
  fetchTorontoTfs,
  torontoTfsContentMeta,
  validateTfsEnvelope,
} from './lib/toronto-official-cad.mjs';

loadEnvFile(import.meta.url);

export const TFS_ACTIVATION_KEY = 'seed-activated:safety:toronto-tfs';

async function markTfsActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', TFS_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: activation marker write failed: ${err?.message || err}`);
  }
}

runSeed('safety', 'toronto-tfs', TFS_KEY, () => (
  fetchTorontoTfs({ userAgent: CHROME_UA })
), {
  validateFn: validateTfsEnvelope,
  ttlSeconds: TFS_TTL_SECONDS,
  sourceVersion: TFS_SOURCE_VERSION,
  declareRecords: declareTfsRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: TFS_MAX_STALE_MIN,
  contentMeta: torontoTfsContentMeta,
  maxContentAgeMin: TFS_MAX_STALE_MIN,
  fetchPhaseTimeoutMs: 45_000,
  afterPublish: markTfsActivated,
}).catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
