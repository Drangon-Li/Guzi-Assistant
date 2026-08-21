export interface DirectModelEnvironment {
  GUZI_ASSISTANT_API_BASE?: string
  GUZI_ASSISTANT_API_KEY?: string
  GUZI_ASSISTANT_MODEL?: string
  OPENAI_BASE_URL?: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  ESHELL_API_BASE?: string
  ESHELL_API_KEY?: string
  ESHELL_MODEL?: string
}

export interface DirectModelSettings {
  apiBase: string
  apiKey: string
  model: string
}

function firstNonBlank(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value?.trim()) return value.trim()
  }
  return ''
}

export function resolveDirectModelSettings(
  stored: Partial<DirectModelSettings>,
  env: DirectModelEnvironment
): DirectModelSettings {
  return {
    apiBase:
      stored.apiBase ??
      firstNonBlank(env.GUZI_ASSISTANT_API_BASE, env.OPENAI_BASE_URL, env.ESHELL_API_BASE),
    apiKey:
      stored.apiKey ??
      firstNonBlank(env.GUZI_ASSISTANT_API_KEY, env.OPENAI_API_KEY, env.ESHELL_API_KEY),
    model:
      stored.model !== undefined
        ? stored.model
        : firstNonBlank(env.GUZI_ASSISTANT_MODEL, env.OPENAI_MODEL, env.ESHELL_MODEL) ||
          'gpt-5.5'
  }
}

export function responsesEndpoint(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, '')
  return /\/v1$/i.test(base) ? `${base}/responses` : `${base}/v1/responses`
}
