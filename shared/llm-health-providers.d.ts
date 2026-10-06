export interface LlmHealthProvider {
  name: 'ollama' | 'openrouter';
  url: string;
  allowPrivateNetwork: boolean;
}

export function getConfiguredLlmHealthProviders(
  env: Readonly<Record<string, string | undefined>>,
): LlmHealthProvider[];
