/**
 * Map-based route matcher for sebuf-generated RouteDescriptor arrays.
 *
 * All sebuf routes are static POST paths (e.g., "POST /api/seismology/v1/list-earthquakes"),
 * so a simple Map lookup keyed by "METHOD /path" is sufficient -- no regex or dynamic segments.
 */

/** Same shape as the generated RouteDescriptor (defined locally to avoid importing from a specific generated file). */
export interface RouteDescriptor {
  method: string;
  path: string;
  handler: (req: Request) => Promise<Response>;
}

export interface Router {
  match(req: Request): ((req: Request) => Promise<Response>) | null;
}

export function createRouter(allRoutes: RouteDescriptor[]): Router {
  const table = new Map<string, (req: Request) => Promise<Response>>();
  for (const route of allRoutes) {
    const key = `${route.method} ${route.path}`;
    table.set(key, route.handler);
  }

  return {
    match(req: Request) {
      const url = new URL(req.url);
      const key = `${req.method} ${url.pathname}`;
      return table.get(key) ?? null;
    },
  };
}
