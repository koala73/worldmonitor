export const config = { runtime: 'edge' };

import gateway from './[rpc]';
import { rewriteToSebuf } from '../../../server/alias-rewrite';

export default (req: Request, ctx: { waitUntil: (p: Promise<unknown>) => void }) =>
  rewriteToSebuf(req, '/api/scenario/v1/run-scenario', gateway, ctx);
