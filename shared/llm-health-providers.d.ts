export interface LlmHealthProvider {
  name: 'ollama' | 'openrouter' | 'atlascloud';
  url: string;
  allowPrivateNetwork: boolean;
}

export function getConfiguredLlmHealthProviders(
  env: Readonly<Record<string, string | undefined>>,
): LlmHealthProvider[];
