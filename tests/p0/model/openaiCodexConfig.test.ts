import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'

const MOCK_HOME = '/mock-home'
const DEFAULT_CONFIG_PATH = join(MOCK_HOME, '.codex', 'config.toml')
const DEFAULT_AUTH_PATH = join(MOCK_HOME, '.codex', 'auth.json')
const ENV_KEYS = [
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL_CONTEXT_WINDOW',
  'OPENAI_PROMPT_CACHE_RETENTION',
  'OPENAI_REASONING_EFFORT',
  'CUBENCE_DISABLE_RESPONSE_STORAGE',
  'CUBENCE_MODEL_BACKEND',
  'CLAUDE_CODE_MODEL_BACKEND',
  'COCLAWDEX_CONFIG_PATH',
] as const
const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

async function loadCodexConfigModule(options?: {
  configToml?: string
  authJson?: string
  env?: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>
}) {
  restoreEnv()
  for (const [key, value] of Object.entries(options?.env ?? {})) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  const files = new Map<string, string>()
  const configPath =
    options?.env?.COCLAWDEX_CONFIG_PATH || DEFAULT_CONFIG_PATH
  if (options?.configToml !== undefined) {
    files.set(configPath, options.configToml)
  }
  if (options?.authJson !== undefined) {
    files.set(DEFAULT_AUTH_PATH, options.authJson)
  }

  vi.resetModules()
  vi.doMock('fs', () => ({
    existsSync: (path: string) => files.has(String(path)),
    readFileSync: (path: string) => {
      const value = files.get(String(path))
      if (value === undefined) {
        throw new Error(`ENOENT: ${String(path)}`)
      }
      return value
    },
    mkdirSync: vi.fn(),
    writeFileSync: (path: string, value: string) => {
      files.set(String(path), value)
    },
  }))
  vi.doMock('os', () => ({
    homedir: () => MOCK_HOME,
  }))

  return {
    files,
    mod: await import('../../../src/services/modelBackend/openaiCodexConfig.ts'),
  }
}

afterEach(() => {
  restoreEnv()
  vi.resetModules()
  vi.unmock('fs')
  vi.unmock('os')
})

describe('openaiCodexConfig official-Codex alignment', () => {
  it('[P0:model] falls back to the default provider config and default config path when no config file exists', async () => {
    const { mod } = await loadCodexConfigModule()

    expect(mod.loadCodexProviderConfig()).toEqual({
      providerId: 'openai',
      model: 'gpt-5.4',
      disableResponseStorage: true,
      baseUrl: 'https://api.openai.com/v1',
      configuredBaseUrl: undefined,
      wireApi: 'responses',
      wireApiError: undefined,
      requiresOpenAIAuth: false,
      promptCacheRetention: undefined,
      modelContextWindow: undefined,
      reasoningEffort: undefined,
    })
    expect(mod.resolveCodexConfigPathInfo()).toEqual({
      path: DEFAULT_CONFIG_PATH,
      source: 'default',
    })
    expect(mod.resolveSelectedCodexAuth()).toEqual({
      mode: 'none',
      source: 'none',
      wireApi: 'responses',
      isCompatible: false,
      incompatibilityReason:
        `未检测到 OpenAI/Codex 凭据。请设置 OPENAI_API_KEY，或在 ${DEFAULT_AUTH_PATH} 中提供 ChatGPT/Codex 登录态或 OPENAI_API_KEY。`,
    })
    expect(mod.resolveOpenAIBaseUrl()).toBe('https://api.openai.com/v1')
    expect(mod.shouldStoreOpenAIResponses()).toBe(false)
  })

  it('[P0:model] reads provider config from COCLAWDEX_CONFIG_PATH and rejects non-responses wire_api values explicitly', async () => {
    const { mod } = await loadCodexConfigModule({
      configToml: [
        'model_provider = "corp"',
        'model = "sonnet"',
        '[model_providers.corp]',
        'base_url = "https://corp.example.com/v1/responses/"',
        'wire_api = "wham_tasks"',
      ].join('\n'),
      authJson: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          account_id: 'account-id',
        },
      }),
      env: {
        COCLAWDEX_CONFIG_PATH: '/alt/config_for_coclawdex.toml',
      },
    })

    expect(mod.resolveCodexConfigPathInfo()).toEqual({
      path: '/alt/config_for_coclawdex.toml',
      source: 'COCLAWDEX_CONFIG_PATH',
    })
    expect(mod.loadCodexProviderConfig()).toMatchObject({
      providerId: 'corp',
      model: 'gpt-5.2',
      baseUrl: 'https://corp.example.com/v1',
      configuredBaseUrl: 'https://corp.example.com/v1',
      wireApi: 'wham_tasks',
      wireApiError:
        '当前配置的 wire_api = "wham_tasks" 无效。OpenAI/Codex 公开 CLI 仅支持 wire_api = "responses"。',
    })
    expect(mod.resolveSelectedCodexAuth()).toMatchObject({
      mode: 'chatgpt',
      source: 'auth_json_chatgpt',
      wireApi: 'wham_tasks',
      isCompatible: false,
      incompatibilityReason:
        '当前配置的 wire_api = "wham_tasks" 无效。OpenAI/Codex 公开 CLI 仅支持 wire_api = "responses"。',
    })
  })

  it('[P0:model] prefers the ChatGPT/Codex login session over env and file API keys, and switches the default base URL to chatgpt.com/backend-api/codex', async () => {
    const { mod } = await loadCodexConfigModule({
      authJson: JSON.stringify({
        OPENAI_API_KEY: 'file-key',
        auth_mode: 'chatgpt',
        last_refresh: '2026-04-01T00:00:00.000Z',
        tokens: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          account_id: 'account-id',
          id_token: 'id-token',
        },
      }),
      env: {
        OPENAI_API_KEY: 'env-key',
      },
    })

    expect(mod.loadCodexAuthConfig()).toEqual({
      mode: 'chatgpt',
      source: 'auth_json_chatgpt',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accountId: 'account-id',
      idToken: 'id-token',
      lastRefresh: '2026-04-01T00:00:00.000Z',
    })
    expect(mod.resolveSelectedCodexAuth()).toEqual({
      mode: 'chatgpt',
      source: 'auth_json_chatgpt',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accountId: 'account-id',
      idToken: 'id-token',
      lastRefresh: '2026-04-01T00:00:00.000Z',
      wireApi: 'responses',
      isCompatible: true,
    })
    expect(mod.resolveOpenAIBaseUrl()).toBe(
      'https://chatgpt.com/backend-api/codex',
    )
    expect(mod.getOpenAIApiKey()).toBeUndefined()
  })

  it('[P0:model] falls back to env and file API keys only when no login session exists', async () => {
    const { mod: envPreferred } = await loadCodexConfigModule({
      authJson: JSON.stringify({
        OPENAI_API_KEY: 'file-key',
      }),
      env: {
        OPENAI_API_KEY: 'env-key',
      },
    })

    expect(envPreferred.resolveSelectedCodexAuth()).toEqual({
      mode: 'api_key',
      source: 'OPENAI_API_KEY',
      openaiApiKey: 'env-key',
      wireApi: 'responses',
      isCompatible: true,
    })
    expect(envPreferred.resolveOpenAIBaseUrl()).toBe('https://api.openai.com/v1')
    expect(envPreferred.getOpenAIApiKey()).toBe('env-key')

    const { mod: fileFallback } = await loadCodexConfigModule({
      authJson: JSON.stringify({
        OPENAI_API_KEY: 'file-key',
      }),
    })
    expect(fileFallback.resolveSelectedCodexAuth()).toEqual({
      mode: 'api_key',
      source: 'auth_json_api_key',
      openaiApiKey: 'file-key',
      wireApi: 'responses',
      isCompatible: true,
    })
    expect(fileFallback.getOpenAIApiKey()).toBe('file-key')
  })

  it('[P0:model] honors explicit provider and environment base URL overrides ahead of auth-based defaults', async () => {
    const { mod: fromConfig } = await loadCodexConfigModule({
      configToml: [
        'model_provider = "openai"',
        '[model_providers.openai]',
        'base_url = "https://proxy.example.com/v1/responses/"',
      ].join('\n'),
      authJson: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          account_id: 'account-id',
        },
      }),
    })
    expect(fromConfig.resolveOpenAIBaseUrl()).toBe('https://proxy.example.com/v1')

    const { mod: fromEnv } = await loadCodexConfigModule({
      authJson: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          account_id: 'account-id',
        },
      }),
      env: {
        OPENAI_BASE_URL: 'https://env.example.com/v1/responses/',
      },
    })
    expect(fromEnv.resolveOpenAIBaseUrl()).toBe('https://env.example.com/v1')
  })

  it('[P0:model] returns a structured auth error when auth.json is malformed', async () => {
    const { mod } = await loadCodexConfigModule({
      authJson: '{not-json',
    })

    expect(mod.loadCodexAuthConfig()).toEqual({
      mode: 'none',
      source: 'none',
      error: `无法解析 ${DEFAULT_AUTH_PATH}。请确认它是合法 JSON。`,
    })
    expect(mod.resolveSelectedCodexAuth()).toEqual({
      mode: 'none',
      source: 'none',
      error: `无法解析 ${DEFAULT_AUTH_PATH}。请确认它是合法 JSON。`,
      wireApi: 'responses',
      isCompatible: false,
      incompatibilityReason: `无法解析 ${DEFAULT_AUTH_PATH}。请确认它是合法 JSON。`,
    })
  })

  it('[P0:model] persists refreshed ChatGPT/Codex tokens back to auth.json while preserving existing id_token and OPENAI_API_KEY', async () => {
    const { mod, files } = await loadCodexConfigModule({
      authJson: JSON.stringify({
        OPENAI_API_KEY: 'file-key',
        auth_mode: 'chatgpt',
        last_refresh: '2026-04-01T00:00:00.000Z',
        tokens: {
          access_token: 'old-access-token',
          refresh_token: 'old-refresh-token',
          account_id: 'account-id',
          id_token: 'kept-id-token',
        },
      }),
    })

    mod.persistChatGPTAuthRefresh({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      accountId: 'account-id',
      lastRefresh: '2026-04-13T00:00:00.000Z',
    })

    expect(JSON.parse(files.get(DEFAULT_AUTH_PATH)!)).toEqual({
      OPENAI_API_KEY: 'file-key',
      auth_mode: 'chatgpt',
      last_refresh: '2026-04-13T00:00:00.000Z',
      tokens: {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        account_id: 'account-id',
        id_token: 'kept-id-token',
      },
    })
  })
})
