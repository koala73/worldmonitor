/**
 * Map-based route matcher for sebuf-generated RouteDescriptor arrays.
 *
 * Static routes (no path params) use exact Map lookup for O(1) matching.
 * Dynamic routes (with {param} segments) fall back to linear scan with pattern matching.
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

interface DynamicRoute {
  method: string;
  /** Number of path segments (for quick filtering). */
  segmentCount: number;
  /** Each segment is either a literal string or null (= path param wildcard). */
  segments: (string | null)[];
  handler: (req: Request) => Promise<Response>;
}

export function createRouter(allRoutes: RouteDescriptor[]): Router {
  const staticTable = new Map<string, (req: Request) => Promise<Response>>();
  const dynamicRoutes: DynamicRoute[] = [];

  for (const route of allRoutes) {
    if (route.path.includes('{')) {
      // Dynamic route — parse segments for pattern matching
      const parts = route.path.split('/').filter(Boolean);
      dynamicRoutes.push({
        method: route.method,
        segmentCount: parts.length,
        segments: parts.map((p) => (p.startsWith('{') && p.endsWith('}') ? null : p)),
        handler: route.handler,
      });
    } else {
      const key = `${route.method} ${route.path}`;
      staticTable.set(key, route.handler);
    }
  }

  return {
    match(req: Request) {
      const url = new URL(req.url);
      // Normalize trailing slashes: /api/foo/v1/bar/ -> /api/foo/v1/bar
      const pathname =
        url.pathname.length > 1 && url.pathname.endsWith('/')
          ? url.pathname.slice(0, -1)
          : url.pathname;

      // Fast path: exact match for static routes
      const key = `${req.method} ${pathname}`;
      const staticHandler = staticTable.get(key);
      if (staticHandler) return staticHandler;

      // Slow path: match dynamic routes
      const parts = pathname.split('/').filter(Boolean);
      for (const route of dynamicRoutes) {
        if (route.method !== req.method) continue;
        if (route.segmentCount !== parts.length) continue;
        let matched = true;
        for (let i = 0; i < route.segmentCount; i++) {
          if (route.segments[i] !== null && route.segments[i] !== parts[i]) {
            matched = false;
            break;
          }
        }
        if (matched) return route.handler;
      }

      return null;
    },
  };
}
