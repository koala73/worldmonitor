import type { ScenarioServiceHandler } from '../../../../src/generated/server/worldmonitor/scenario/v1/service_server';

import { runScenario } from './run-scenario';
import { getScenarioStatus } from './get-scenario-status';
import { listScenarioTemplates } from './list-scenario-templates';

export const scenarioHandler: ScenarioServiceHandler = {
  runScenario,
  getScenarioStatus,
  listScenarioTemplates,
};
