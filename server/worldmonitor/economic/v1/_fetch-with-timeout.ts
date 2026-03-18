/**
 * Fetch with an AbortController deadline.
 * Clears the timeout in all cases to avoid timer leaks.
 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeout = 8000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
