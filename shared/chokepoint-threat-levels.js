/**
 * Geopolitical threat level per canonical chokepoint.
 *
 * Lives in `shared/` because the AIS relay needs it and the relay image copies
 * `shared/` but not `server/` (see Dockerfile.relay). The relay previously
 * carried a hand-maintained copy of this table.
 *
 * `CHOKEPOINTS` in server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts
 * still declares the same levels alongside their prose descriptions; the two
 * are held together by an executable parity test rather than a source scan.
 *
 * Levels are Lloyd's Joint War Committee Listed Areas plus OSINT — see
 * THREAT_CONFIG_LAST_REVIEWED in the handler for the review date.
 */
export const CHOKEPOINT_THREAT_LEVELS = Object.freeze({
  suez: 'high',
  malacca_strait: 'normal',
  hormuz_strait: 'war_zone',
  bab_el_mandeb: 'critical',
  panama: 'normal',
  taiwan_strait: 'elevated',
  cape_of_good_hope: 'normal',
  gibraltar: 'normal',
  bosphorus: 'elevated',
  korea_strait: 'normal',
  dover_strait: 'normal',
  kerch_strait: 'war_zone',
  lombok_strait: 'normal',
});
