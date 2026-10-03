export interface LlmHealthProvider {
  name: 'ollama' | 'groq' | 'openrouter' | 'atlascloud';
  url: string;
  allowPrivateNetwork: boolean;
}

export function getConfiguredLlmHealthProviders(
  env: Readonly<Record<string, string | undefined>>,
): LlmHealthProvider[];
