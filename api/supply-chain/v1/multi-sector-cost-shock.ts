export const config = { runtime: 'edge' };

import gateway from './[rpc]';
import { rewriteToSebuf } from '../../../server/alias-rewrite';

export default (req: Request, ctx: { waitUntil: (p: Promise<unknown>) => void }) =>
  rewriteToSebuf(req, '/api/supply-chain/v1/get-multi-sector-cost-shock', gateway, ctx);
