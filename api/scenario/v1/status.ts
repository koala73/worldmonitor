export const config = { runtime: 'edge' };

import gateway from './[rpc]';
import { rewriteToSebuf } from '../../../server/alias-rewrite';

// Alias for documented v1 URL. See server/alias-rewrite.ts.
export default (req: Request, ctx: { waitUntil: (p: Promise<unknown>) => void }) =>
  rewriteToSebuf(req, '/api/scenario/v1/get-scenario-status', gateway, ctx);
