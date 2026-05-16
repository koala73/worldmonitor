export const config = { runtime: 'edge' };

export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await req.json();
    const points = body.points || [];

    if (points.length === 0) {
      return new Response(JSON.stringify({ success: false }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Log for research analysis
    console.log(`[RNG-Ingest] Received ${points.length} points from ${points[0].node_id || 'anonymous'}`);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: 'Bad Request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
