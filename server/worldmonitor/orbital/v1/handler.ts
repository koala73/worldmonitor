import type { OrbitalServiceHandler } from '../../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { getCountryImageryEvidence } from './get-country-imagery-evidence';
import { getPointPasses } from './get-point-passes';
import { listImagingSatellites } from './list-imaging-satellites';
import { listSatelliteManeuvers } from './list-satellite-maneuvers';
import { getWatchedSiteImagery } from './get-watched-site-imagery';

export const orbitalHandler: OrbitalServiceHandler = {
  getCountryImageryEvidence,
  getPointPasses,
  listImagingSatellites,
  listSatelliteManeuvers,
  getWatchedSiteImagery,
};
