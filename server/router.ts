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
  allowedMethods(pathname: string): string[];
}

/**
 * RFC 9110: HEAD is GET without a response body. Copy status and headers,
 * drop the payload, and cancel any unused stream so the runtime can release it.
 */
export function toHeadResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  if (response.body) {
    try {
      void response.body.cancel();
    } catch {
      // Body already consumed or locked (e.g. after arrayBuffer()).
    }
  }
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
  const staticPaths = new Map<string, Set<string>>();
  const dynamicRoutes: DynamicRoute[] = [];

  for (const route of allRoutes) {
    if (route.path.includes('{')) {
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
      if (!staticPaths.has(route.path)) staticPaths.set(route.path, new Set());
      staticPaths.get(route.path)!.add(route.method);
    }
  }

  function normalizePath(raw: string): string {
    return raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
  }

  function lookup(
    method: string,
    pathname: string,
  ): ((req: Request) => Promise<Response>) | null {
    const staticHandler = staticTable.get(`${method} ${pathname}`);
    if (staticHandler) return staticHandler;

    const parts = pathname.split('/').filter(Boolean);
    for (const route of dynamicRoutes) {
      if (route.method !== method) continue;
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
  }

  return {
    match(req: Request) {
      const pathname = normalizePath(new URL(req.url).pathname);
      const exact = lookup(req.method, pathname);
      if (exact) return exact;
      // allowedMethods() already advertises HEAD for every GET route (#7275).
      if (req.method === 'HEAD') return lookup('GET', pathname);
      return null;
    },

    allowedMethods(pathname: string): string[] {
      const normalized = normalizePath(pathname);

      const methods = staticPaths.get(normalized);
      if (methods) {
        const result = Array.from(methods);
        if (result.includes('GET') && !result.includes('HEAD')) result.push('HEAD');
        return result;
      }

      const parts = normalized.split('/').filter(Boolean);
      const found = new Set<string>();
      for (const route of dynamicRoutes) {
        if (route.segmentCount !== parts.length) continue;
        let matched = true;
        for (let i = 0; i < route.segmentCount; i++) {
          if (route.segments[i] !== null && route.segments[i] !== parts[i]) {
            matched = false;
            break;
          }
        }
        if (matched) found.add(route.method);
      }
      if (found.has('GET')) found.add('HEAD');
      return Array.from(found);
    },
  };
}
