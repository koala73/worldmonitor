import type { MilitaryServiceHandler } from '../../../../../src/generated/server/worldmonitor/military/v1/service_server';

import { listMilitaryFlights } from './list-military-flights';
import { listMilitaryVessels } from './list-military-vessels';
import { getTheaterPosture } from './get-theater-posture';
import { getAircraftDetails } from './get-aircraft-details';
import { getAircraftDetailsBatch } from './get-aircraft-details-batch';
import { getWingbitsStatus } from './get-wingbits-status';
import { getUSNIFleetReport } from './get-usni-fleet-report';

export const militaryHandler: MilitaryServiceHandler = {
  listMilitaryFlights,
  listMilitaryVessels,
  getTheaterPosture,
  getAircraftDetails,
  getAircraftDetailsBatch,
  getWingbitsStatus,
  getUSNIFleetReport,
};
