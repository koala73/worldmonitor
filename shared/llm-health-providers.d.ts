export interface LlmHealthProvider {
  name: 'ollama' | 'groq' | 'openrouter';
  url: string;
  allowPrivateNetwork: boolean;
}

export function getConfiguredLlmHealthProviders(
  env: Readonly<Record<string, string | undefined>>,
): LlmHealthProvider[];
