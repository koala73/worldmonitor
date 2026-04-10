export const config = { runtime: 'edge' };

import { isCallerPremium } from '../../../server/_shared/premium-check';
// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash } from '../../_upstash-json.js';

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response('', { status: 405 });
  }

  const isPro = await isCallerPremium(req);
  if (!isPro) {
    return new Response(
      JSON.stringify({ error: 'PRO subscription required' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const { searchParams } = new URL(req.url);
  const iso2 = searchParams.get('iso2')?.toUpperCase();
  if (!iso2 || !/^[A-Z]{2}$/.test(iso2)) {
    return new Response(
      JSON.stringify({ error: 'Invalid or missing iso2 parameter' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const key = `comtrade:bilateral-hs4:${iso2}:v1`;

  try {
    const data = await readJsonFromUpstash(key, 5_000);
    if (!data) {
      return new Response(
        JSON.stringify({ iso2, products: [], fetchedAt: '' }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
      );
    }
    return new Response(
      JSON.stringify(data),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'private, max-age=3600',
          'Vary': 'Authorization, Cookie',
        },
      },
    );
  } catch {
    return new Response(
      JSON.stringify({ error: 'Failed to fetch product data' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
