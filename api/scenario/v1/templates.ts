export const config = { runtime: 'edge' };

import { SCENARIO_TEMPLATES } from '../../../server/worldmonitor/supply-chain/v1/scenario-templates';

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response('', { status: 405 });
  }

  const templates = SCENARIO_TEMPLATES.map(t => ({
    id: t.id,
    name: t.name,
    affectedChokepointIds: t.affectedChokepointIds,
    disruptionPct: t.disruptionPct,
    durationDays: t.durationDays,
    affectedHs2: t.affectedHs2,
    costShockMultiplier: t.costShockMultiplier,
  }));

  return new Response(JSON.stringify({ templates }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
