// Public profiles contain an alias and URL only. Neither env names nor keys enter DTOs.
export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Base URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL must use HTTP(S), without credentials, query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

export class ProviderCredentials {
  readonly #profiles = new Map<string, { baseUrl: string; key: string }>();
  constructor(env: NodeJS.ProcessEnv = process.env) {
    const add = (id: string, baseUrl: string, apiKeyEnv: string) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !env[apiKeyEnv]?.trim()) throw new Error('Invalid LLM credential profile or missing server key');
      this.#profiles.set(id, { baseUrl: normalizeBaseUrl(baseUrl), key: env[apiKeyEnv]! });
    };
    if (env.OPENAI_API_KEY) add('openai', 'https://api.openai.com/v1', 'OPENAI_API_KEY');
    if (env.OPENROUTER_API_KEY) add('openrouter', 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY');
    if (env.LLM_ENDPOINTS_JSON) {
      try {
        const profiles: unknown = JSON.parse(env.LLM_ENDPOINTS_JSON);
        if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) throw new Error();
        for (const [id, profile] of Object.entries(profiles)) {
          if (!profile || typeof profile !== 'object' || !('baseUrl' in profile) || typeof profile.baseUrl !== 'string' ||
              !('apiKeyEnv' in profile) || typeof profile.apiKeyEnv !== 'string') throw new Error();
          add(id, profile.baseUrl, profile.apiKeyEnv);
        }
      } catch { throw new Error('Invalid LLM_ENDPOINTS_JSON configuration (check profile URLs and server keys)'); }
    }
  }
  list(): { id: string; baseUrl: string }[] {
    return [...this.#profiles].map(([id, profile]) => ({ id, baseUrl: profile.baseUrl }));
  }
  resolve(baseUrl: string, profile?: string): string | undefined {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!profile) return undefined;
    const credentials = this.#profiles.get(profile);
    if (!credentials || credentials.baseUrl !== normalized) throw new Error('Credential profile is unavailable or does not match Base URL');
    return credentials.key;
  }
  redact(text: string): string {
    for (const { key } of this.#profiles.values()) text = text.split(key).join('[REDACTED]');
    return text.replace(/Bearer\s+[a-zA-Z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  }
}
