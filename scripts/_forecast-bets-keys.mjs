// Shared Redis keys for the shadow bet-engine (#5233), so the WRITER
// (seed-forecast-bets.mjs) and the READER (seed-forecast-resolutions.mjs) can
// never drift. A drift would be silent: readBetsHistory swallows errors and
// returns [], so the bet_engine Gate-1 evidence would vanish from the scorecard
// with no error signal. No dependencies — safe to import from either seeder.
export const BETS_HISTORY_KEY = 'forecast:bets:history:v1';

// Per-run bet-engine input snapshot (#9058): the feeds, rolling series and
// ensemble context one seed-forecast-bets run read. Written privately to the
// forecast trace bucket under the same dated run layout as the detector
// deep-snapshot.json, so one retention rule covers both.
export const BETS_INPUT_SNAPSHOT_FILE = 'bets-input-snapshot.json';

export function buildBetsRunId(nowMs) {
  return `${nowMs}-bets`;
}

export function buildBetsInputSnapshotKey(runId, generatedAt, basePrefix) {
  const [year, month, day] = new Date(generatedAt).toISOString().slice(0, 10).split('-');
  return `${basePrefix}/${year}/${month}/${day}/${runId}/${BETS_INPUT_SNAPSHOT_FILE}`;
}
