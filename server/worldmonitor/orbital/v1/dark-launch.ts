/** Orbital Watch ships dark (#10710): its RPCs answer 404 unless ORBITAL_WATCH_ENABLED=true. */
export function isOrbitalWatchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ORBITAL_WATCH_ENABLED ?? '').trim().toLowerCase() === 'true';
}

export function orbitalWatchDarkResponse(): Response {
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
