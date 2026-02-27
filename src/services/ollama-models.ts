function makeTimeout(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

export async function fetchOllamaModels(ollamaUrl: string): Promise<string[]> {
  if (!ollamaUrl) return [];

  try {
    const res = await fetch(new URL('/api/tags', ollamaUrl).toString(), {
      signal: makeTimeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as { models?: Array<{ name: string }> };
      const models = (data.models?.map(m => m.name) || []).filter(n => !n.includes('embed'));
      if (models.length > 0) return models;
    }
  } catch { /* Ollama endpoint not available */ }

  try {
    const res = await fetch(new URL('/v1/models', ollamaUrl).toString(), {
      signal: makeTimeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as { data?: Array<{ id: string }> };
      return (data.data?.map(m => m.id) || []).filter(n => !n.includes('embed'));
    }
  } catch { /* OpenAI endpoint also unavailable */ }

  return [];
}
