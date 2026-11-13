import type { OrbitalServiceHandler } from '../../../../src/generated/server/worldmonitor/orbital/v1/service_server';
import { getCountryImageryEvidence } from './get-country-imagery-evidence';
import { getPointPasses } from './get-point-passes';
import { listImagingSatellites } from './list-imaging-satellites';

export const orbitalHandler: OrbitalServiceHandler = {
  getCountryImageryEvidence,
  getPointPasses,
  listImagingSatellites,
};
