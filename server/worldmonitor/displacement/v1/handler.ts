import type { DisplacementServiceHandler } from '../../../../src/generated/server/worldmonitor/displacement/v1/service_server';

import { getDisplacementSummary } from './get-displacement-summary';
import { getInternalDisplacement } from './get-internal-displacement';
import { getPopulationExposure } from './get-population-exposure';

export const displacementHandler: DisplacementServiceHandler = {
  getDisplacementSummary,
  getInternalDisplacement,
  getPopulationExposure,
};
