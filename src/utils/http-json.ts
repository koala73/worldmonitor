export async function readJsonResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  const body = await response.text();
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const looksLikeJson = body.trim().startsWith('{') || body.trim().startsWith('[');

  if (contentType && !contentType.includes('json') && !looksLikeJson) {
    throw new Error(fallbackMessage);
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(fallbackMessage);
  }
}
