const HOSTED_LLM_PROVIDERS = [
  {
    name: 'groq',
    envKey: 'GROQ_API_KEY',
    url: 'https://api.groq.com',
    allowPrivateNetwork: false,
  },
  {
    name: 'openrouter',
    envKey: 'OPENROUTER_API_KEY',
    url: 'https://openrouter.ai',
    allowPrivateNetwork: false,
  },
];

/**
 * Derive the providers whose reachability should be reported.
 * Credential presence enables hosted providers. Credential format is validated
 * by the provider request, not guessed from a prefix at the health boundary.
 */
export function getConfiguredLlmHealthProviders(env) {
  const providers = [];
  const localUrl = env.OLLAMA_API_URL || env.LLM_API_URL;

  if (localUrl) {
    try {
      providers.push({
        name: 'ollama',
        url: new URL(localUrl).origin,
        allowPrivateNetwork: true,
      });
    } catch {
      // Invalid local URLs are not probeable providers.
    }
  }

  for (const provider of HOSTED_LLM_PROVIDERS) {
    if (!env[provider.envKey]) continue;
    providers.push({
      name: provider.name,
      url: provider.url,
      allowPrivateNetwork: provider.allowPrivateNetwork,
    });
  }

  return providers;
}
