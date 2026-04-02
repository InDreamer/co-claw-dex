import { afterEach, describe, expect, it, vi } from 'vitest'

const MOCK_HOME = '/mock-home'
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
  if (options?.configToml !== undefined) {
    files.set(`${MOCK_HOME}/.codex/config.toml`, options.configToml)
  }
  if (options?.authJson !== undefined) {
    files.set(`${MOCK_HOME}/.codex/auth.json`, options.authJson)
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
  }))
  vi.doMock('os', () => ({
    homedir: () => MOCK_HOME,
  }))

  return import('../../../src/services/modelBackend/openaiCodexConfig.ts')
}

afterEach(() => {
  restoreEnv()
  vi.resetModules()
  vi.unmock('fs')
  vi.unmock('os')
})

describe('openaiCodexConfig fork contracts', () => {
  it('[P0:model] falls back to the fork default OpenAI provider config when ~/.codex/config.toml is absent', async () => {
    const defaults = await loadCodexConfigModule()

    expect(defaults.loadCodexProviderConfig()).toEqual({
      providerId: 'openai',
      model: 'gpt-5.4',
      disableResponseStorage: true,
      baseUrl: 'https://api.openai.com/v1',
      wireApi: 'responses',
      requiresOpenAIAuth: false,
      promptCacheRetention: undefined,
      modelContextWindow: undefined,
      reasoningEffort: undefined,
    })
    expect(defaults.resolveOpenAIBaseUrl()).toBe('https://api.openai.com/v1')
    expect(defaults.shouldStoreOpenAIResponses()).toBe(false)
  })

  it('[P0:model] falls back away from bare Claude-family currentModel values to the configured OpenAI default', async () => {
    const fromEnv = await loadCodexConfigModule({
      env: { OPENAI_MODEL: 'haiku' },
    })
    expect(fromEnv.resolveOpenAIModel('claude')).toBe('gpt-5-mini')

    const fromConfig = await loadCodexConfigModule({
      configToml: 'model = "best"\n',
    })
    expect(fromConfig.resolveOpenAIModel('claude-custom')).toBe('gpt-5.4')
  })

  it('[P0:model] resolves model selection by current argument before env and config, with alias normalization at each layer', async () => {
    const withEnvAndConfig = await loadCodexConfigModule({
      configToml: 'model = "haiku"\n',
      env: { OPENAI_MODEL: 'best' },
    })
    expect(withEnvAndConfig.resolveOpenAIModel(undefined)).toBe('gpt-5.4')
    expect(withEnvAndConfig.resolveOpenAIModel('sonnet')).toBe('gpt-5.2')

    const configOnly = await loadCodexConfigModule({
      configToml: 'model = "haiku"\n',
    })
    expect(configOnly.resolveOpenAIModel(undefined)).toBe('gpt-5-mini')
  })

  it('[P0:model] returns no auth key and no optional overrides when auth/config values are malformed', async () => {
    const malformed = await loadCodexConfigModule({
      configToml: [
        'prompt_cache_retention = "forever"',
        'model_context_window = 0',
        'model_reasoning_effort = "wild"',
      ].join('\n'),
      authJson: '{not-json',
    })

    expect(malformed.getOpenAIApiKey()).toBeUndefined()
    expect(malformed.resolveOpenAIPromptCacheRetention()).toBeUndefined()
    expect(malformed.resolveOpenAIConfiguredContextWindow()).toBeUndefined()
    expect(malformed.resolveOpenAIReasoningEffort()).toBeUndefined()
  })

  it('[P0:model] falls back to default transport/auth settings when model_provider selects a section that is missing from the config', async () => {
    const missingProviderSection = await loadCodexConfigModule({
      configToml: [
        'model_provider = "corp"',
        'model = "sonnet"',
        'prompt_cache_retention = "24h"',
      ].join('\n'),
    })

    expect(missingProviderSection.loadCodexProviderConfig()).toEqual({
      providerId: 'corp',
      model: 'gpt-5.2',
      disableResponseStorage: true,
      baseUrl: 'https://api.openai.com/v1',
      wireApi: 'responses',
      requiresOpenAIAuth: false,
      promptCacheRetention: '24h',
      modelContextWindow: undefined,
      reasoningEffort: undefined,
    })
    expect(missingProviderSection.resolveOpenAIBaseUrl()).toBe('https://api.openai.com/v1')
    expect(missingProviderSection.shouldUseOpenAIOfficialClientHeaders()).toBe(false)
  })

  it('[P0:model] reads base URL, wire API, auth gating, and provider-scoped overrides from the selected non-default provider section', async () => {
    const customProvider = await loadCodexConfigModule({
      configToml: [
        'model_provider = "corp"',
        'model = "haiku"',
        '[model_providers.openai]',
        'base_url = "https://ignored.example.com/v1"',
        '[model_providers.corp]',
        'base_url = "https://corp.example.com/v1/responses/"',
        'wire_api = "chat_completions"',
        'requires_openai_auth = true',
        'prompt_cache_retention = "24h"',
        'model_context_window = 777777',
        'model_reasoning_effort = "max"',
      ].join('\n'),
    })

    expect(customProvider.loadCodexProviderConfig()).toEqual({
      providerId: 'corp',
      model: 'gpt-5-mini',
      disableResponseStorage: true,
      baseUrl: 'https://corp.example.com/v1',
      wireApi: 'chat_completions',
      requiresOpenAIAuth: true,
      promptCacheRetention: '24h',
      modelContextWindow: 777777,
      reasoningEffort: 'xhigh',
    })
    expect(customProvider.resolveOpenAIBaseUrl()).toBe('https://corp.example.com/v1')
    expect(customProvider.shouldUseOpenAIOfficialClientHeaders()).toBe(true)
    expect(customProvider.resolveOpenAIPromptCacheRetention()).toBe('24h')
    expect(customProvider.resolveOpenAIConfiguredContextWindow('haiku')).toBe(777777)
    expect(customProvider.resolveOpenAIReasoningEffort()).toBe('xhigh')
  })

  it('[P0:model] normalizes base URLs and falls back from env auth to ~/.codex/auth.json', async () => {
    const fromConfigAndAuth = await loadCodexConfigModule({
      configToml: '[model_providers.openai]\nbase_url = "https://proxy.example.com/v1/responses/"\n',
      authJson: '{"OPENAI_API_KEY":" file-key "}',
    })
    expect(fromConfigAndAuth.resolveOpenAIBaseUrl()).toBe('https://proxy.example.com/v1')
    expect(fromConfigAndAuth.getOpenAIApiKey()).toBe('file-key')

    const fromEnv = await loadCodexConfigModule({
      authJson: '{"OPENAI_API_KEY":"file-key"}',
      env: {
        OPENAI_BASE_URL: 'https://override.example.com/v1/responses/',
        OPENAI_API_KEY: 'env-key',
      },
    })
    expect(fromEnv.resolveOpenAIBaseUrl()).toBe('https://override.example.com/v1')
    expect(fromEnv.getOpenAIApiKey()).toBe('env-key')
  })

  it('[P0:model] lets top-level prompt-cache retention, context window, and reasoning effort override provider-section values', async () => {
    const overridden = await loadCodexConfigModule({
      configToml: [
        'model_provider = "corp"',
        'model = "sonnet"',
        'prompt_cache_retention = "in-memory"',
        'model_context_window = 123456',
        'model_reasoning_effort = "medium"',
        '[model_providers.corp]',
        'prompt_cache_retention = "24h"',
        'model_context_window = 777777',
        'model_reasoning_effort = "max"',
      ].join('\n'),
    })

    expect(overridden.resolveOpenAIPromptCacheRetention()).toBe('in_memory')
    expect(overridden.resolveOpenAIConfiguredContextWindow('sonnet')).toBe(123456)
    expect(overridden.resolveOpenAIReasoningEffort()).toBe('medium')
  })

  it('[P0:model] normalizes prompt-cache retention, exposes official-client-header gating, and respects backend selection envs', async () => {
    const configured = await loadCodexConfigModule({
      configToml: [
        'prompt_cache_retention = "in-memory"',
        '[model_providers.openai]',
        'requires_openai_auth = true',
      ].join('\n'),
    })

    expect(configured.resolveOpenAIPromptCacheRetention()).toBe('in_memory')
    expect(configured.shouldUseOpenAIOfficialClientHeaders()).toBe(true)
    expect(configured.isOpenAIResponsesBackendEnabled()).toBe(true)

    const claudeBackend = await loadCodexConfigModule({
      env: { CLAUDE_CODE_MODEL_BACKEND: 'claude' },
    })
    expect(claudeBackend.isOpenAIResponsesBackendEnabled()).toBe(false)

    const cubenceOverride = await loadCodexConfigModule({
      env: {
        CLAUDE_CODE_MODEL_BACKEND: 'claude',
        CUBENCE_MODEL_BACKEND: 'openaiResponses',
      },
    })
    expect(cubenceOverride.isOpenAIResponsesBackendEnabled()).toBe(true)
  })

  it('[P0:model] keeps the selected provider section baseUrl in config but lets resolveOpenAIBaseUrl apply OPENAI_BASE_URL on top', async () => {
    const overridden = await loadCodexConfigModule({
      configToml: [
        'model_provider = "corp"',
        '[model_providers.corp]',
        'base_url = "https://corp.example.com/v1/responses/"',
      ].join('\n'),
      env: {
        OPENAI_BASE_URL: 'https://env-override.example.com/v1/responses/',
      },
    })

    expect(overridden.loadCodexProviderConfig().baseUrl).toBe(
      'https://corp.example.com/v1',
    )
    expect(overridden.resolveOpenAIBaseUrl()).toBe(
      'https://env-override.example.com/v1',
    )
  })

  it('[P0:model] lets OPENAI_MODEL_CONTEXT_WINDOW and OPENAI_REASONING_EFFORT env overrides beat config values', async () => {
    const overridden = await loadCodexConfigModule({
      configToml: [
        'model = "sonnet"',
        'model_context_window = 123456',
        'model_reasoning_effort = "low"',
      ].join('\n'),
      env: {
        OPENAI_MODEL_CONTEXT_WINDOW: '654321',
        OPENAI_REASONING_EFFORT: 'minimal',
      },
    })

    expect(overridden.resolveOpenAIConfiguredContextWindow()).toBe(654321)
    expect(overridden.resolveOpenAIConfiguredContextWindow('sonnet')).toBe(654321)
    expect(overridden.resolveOpenAIConfiguredContextWindow('haiku')).toBe(654321)
    expect(overridden.resolveOpenAIReasoningEffort()).toBe('minimal')
  })

  it('[P0:model] uses provider config for response storage, context windows, and reasoning effort unless an explicit env override disables storage', async () => {
    const providerConfig = await loadCodexConfigModule({
      configToml: [
        'model = "sonnet"',
        'disable_response_storage = false',
        'model_context_window = 123456',
        'model_reasoning_effort = "max"',
      ].join('\n'),
    })

    expect(providerConfig.shouldStoreOpenAIResponses()).toBe(true)
    expect(providerConfig.resolveOpenAIConfiguredContextWindow('sonnet')).toBe(123456)
    expect(providerConfig.resolveOpenAIConfiguredContextWindow('haiku')).toBeUndefined()
    expect(providerConfig.resolveOpenAIReasoningEffort()).toBe('xhigh')

    const envOverride = await loadCodexConfigModule({
      configToml: 'disable_response_storage = false\n',
      env: { CUBENCE_DISABLE_RESPONSE_STORAGE: '1' },
    })
    expect(envOverride.shouldStoreOpenAIResponses()).toBe(false)
  })
})
