type TauriInvoke = <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;

interface LocalApiProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: number[];
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function resolveInvokeBridge(): TauriInvoke | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const tauriWindow = window as unknown as {
    __TAURI__?: { core?: { invoke?: TauriInvoke } };
    __TAURI_INTERNALS__?: { invoke?: TauriInvoke };
  };

  const invoke =
    tauriWindow.__TAURI__?.core?.invoke ??
    tauriWindow.__TAURI_INTERNALS__?.invoke;

  return typeof invoke === 'function' ? invoke : null;
}

export function hasTauriInvokeBridge(): boolean {
  return resolveInvokeBridge() !== null;
}

export async function invokeTauri<T>(
  command: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const invoke = resolveInvokeBridge();
  if (!invoke) {
    throw new Error('Tauri invoke bridge unavailable');
  }

  return invoke<T>(command, payload);
}

export async function tryInvokeTauri<T>(
  command: string,
  payload?: Record<string, unknown>,
): Promise<T | null> {
  try {
    return await invokeTauri<T>(command, payload);
  } catch (error) {
    console.warn(`[tauri-bridge] Command failed: ${command}`, error);
    return null;
  }
}

/**
 * Send a normal sidecar API request through the native process. The native
 * process owns the local bearer token, so no renderer (including main) can
 * recover it through IPC or attach it to a direct localhost request.
 */
export async function proxyLocalApiRequest(
  path: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (!path.startsWith('/api/') || path.startsWith('//')) {
    throw new Error(`Refusing to proxy non-API path: ${path}`);
  }

  const request = input instanceof Request
    ? new Request(input, init)
    : new Request(`http://localhost${path}`, init);
  const headers = new Headers(request.headers);
  headers.delete('Authorization');
  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : Array.from(new Uint8Array(await request.arrayBuffer()));
  const invocation = invokeTauri<LocalApiProxyResponse>('proxy_local_api_request', {
    request: {
      method: request.method,
      path,
      headers: Object.fromEntries(headers.entries()),
      body,
    },
  });
  const response = await raceWithAbort(invocation, request.signal);
  return new Response(new Uint8Array(response.body), {
    status: response.status,
    headers: response.headers,
  });
}
