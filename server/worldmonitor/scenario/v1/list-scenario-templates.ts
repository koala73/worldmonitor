import type {
  ServerContext,
  ListScenarioTemplatesRequest,
  ListScenarioTemplatesResponse,
} from '../../../../src/generated/server/worldmonitor/scenario/v1/service_server';

import { SCENARIO_TEMPLATES } from '../../supply-chain/v1/scenario-templates';

export async function listScenarioTemplates(
  _ctx: ServerContext,
  _req: ListScenarioTemplatesRequest,
): Promise<ListScenarioTemplatesResponse> {
  return {
    templates: SCENARIO_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      affectedChokepointIds: [...t.affectedChokepointIds],
      disruptionPct: t.disruptionPct,
      durationDays: t.durationDays,
      // Empty array means ALL sectors on the wire (mirrors the `affectedHs2: null`
      // template convention — proto `repeated` cannot carry null).
      affectedHs2: t.affectedHs2 ? [...t.affectedHs2] : [],
      costShockMultiplier: t.costShockMultiplier,
    })),
  };
}
