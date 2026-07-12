// Shared Redis keys for the shadow bet-engine (#5233), so the WRITER
// (seed-forecast-bets.mjs) and the READER (seed-forecast-resolutions.mjs) can
// never drift. A drift would be silent: readBetsHistory swallows errors and
// returns [], so the bet_engine Gate-1 evidence would vanish from the scorecard
// with no error signal. No dependencies — safe to import from either seeder.
export const BETS_HISTORY_KEY = 'forecast:bets:history:v1';
