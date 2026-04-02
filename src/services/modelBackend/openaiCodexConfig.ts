import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { normalizeOpenAICompatibleModel } from './openaiModelCatalog.js'

type CodexProviderConfig = {
  providerId: string
  model: string
  disableResponseStorage: boolean
  baseUrl: string
  wireApi: string
  requiresOpenAIAuth: boolean
  promptCacheRetention?: 'in_memory' | '24h'
  modelContextWindow?: number
  reasoningEffort?: OpenAIReasoningEffort
}

type CodexAuthConfig = {
  openaiApiKey?: string
}

export type OpenAIReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'

let cachedProviderConfig: CodexProviderConfig | null | undefined
let cachedAuthConfig: CodexAuthConfig | null | undefined

const DEFAULT_MODEL = 'gpt-5.4'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

function getCodexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml')
}

function getCodexAuthPath(): string {
  return join(homedir(), '.codex', 'auth.json')
}

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

function matchString(source: string, pattern: RegExp): string | undefined {
  return source.match(pattern)?.[1]
}

function matchBoolean(source: string, pattern: RegExp): boolean | undefined {
  const value = source.match(pattern)?.[1]
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function matchInteger(source: string, pattern: RegExp): number | undefined {
  const value = source.match(pattern)?.[1]
  if (!value) return undefined
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function normalizePromptCacheRetention(
  value: string | undefined,
): 'in_memory' | '24h' | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === '24h') return '24h'
  if (normalized === 'in_memory' || normalized === 'in-memory') {
    return 'in_memory'
  }
  return undefined
}

function normalizeReasoningEffort(
  value: string | undefined,
): OpenAIReasoningEffort | undefined {
  const normalized = value?.trim().toLowerCase()
  switch (normalized) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return normalized
    case 'max':
      return 'xhigh'
    default:
      return undefined
  }
}

function getProviderSection(source: string, providerId: string): string {
  const escaped = providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `\\[model_providers\\.${escaped}\\]([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|$)`,
  )
  return source.match(pattern)?.[1] ?? ''
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const trimmed = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/responses')) {
    return trimmed.slice(0, -'/responses'.length)
  }
  return trimmed
}

export function loadCodexProviderConfig(): CodexProviderConfig {
  if (cachedProviderConfig) return cachedProviderConfig
  if (cachedProviderConfig === null) {
    return {
      providerId: 'openai',
      model: DEFAULT_MODEL,
      disableResponseStorage: true,
      baseUrl: DEFAULT_BASE_URL,
      wireApi: 'responses',
      requiresOpenAIAuth: false,
      promptCacheRetention: undefined,
      modelContextWindow: undefined,
      reasoningEffort: undefined,
    }
  }

  const raw = readIfExists(getCodexConfigPath())
  if (!raw) {
    cachedProviderConfig = null
    return loadCodexProviderConfig()
  }

  const providerId =
    matchString(raw, /^model_provider\s*=\s*"([^"]+)"/m) || 'openai'
  const topLevelModel =
    matchString(raw, /^model\s*=\s*"([^"]+)"/m) || DEFAULT_MODEL
  const disableResponseStorage =
    matchBoolean(raw, /^disable_response_storage\s*=\s*(true|false)/m) ?? true
  const providerSection = getProviderSection(raw, providerId)
  const baseUrl =
    matchString(providerSection, /^\s*base_url\s*=\s*"([^"]+)"/m) ||
    process.env.OPENAI_BASE_URL ||
    DEFAULT_BASE_URL
  const wireApi =
    matchString(providerSection, /^\s*wire_api\s*=\s*"([^"]+)"/m) ||
    'responses'
  const requiresOpenAIAuth =
    matchBoolean(
      providerSection,
      /^\s*requires_openai_auth\s*=\s*(true|false)/m,
    ) ?? false
  const promptCacheRetention = normalizePromptCacheRetention(
    matchString(raw, /^prompt_cache_retention\s*=\s*"([^"]+)"/m) ||
      matchString(
        providerSection,
        /^\s*prompt_cache_retention\s*=\s*"([^"]+)"/m,
      ) ||
      process.env.OPENAI_PROMPT_CACHE_RETENTION,
  )
  const modelContextWindow =
    matchInteger(raw, /^model_context_window\s*=\s*(\d+)/m) ||
    matchInteger(
      providerSection,
      /^\s*model_context_window\s*=\s*(\d+)/m,
    ) ||
    matchInteger(
      process.env.OPENAI_MODEL_CONTEXT_WINDOW || '',
      /^(\d+)$/,
    )
  const reasoningEffort = normalizeReasoningEffort(
    process.env.OPENAI_REASONING_EFFORT ||
      matchString(raw, /^model_reasoning_effort\s*=\s*"([^"]+)"/m) ||
      matchString(
        providerSection,
        /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m,
      ),
  )

  cachedProviderConfig = {
    providerId,
    model: normalizeOpenAICompatibleModel(topLevelModel) ?? topLevelModel,
    disableResponseStorage,
    baseUrl: normalizeBaseUrl(baseUrl),
    wireApi,
    requiresOpenAIAuth,
    promptCacheRetention,
    modelContextWindow,
    reasoningEffort,
  }
  return cachedProviderConfig
}

export function isOpenAIResponsesBackendEnabled(): boolean {
  const configured =
    process.env.CUBENCE_MODEL_BACKEND ??
    process.env.CLAUDE_CODE_MODEL_BACKEND ??
    'openaiResponses'
  return configured.toLowerCase() !== 'claude'
}

export function loadCodexAuthConfig(): CodexAuthConfig {
  if (cachedAuthConfig) return cachedAuthConfig
  if (cachedAuthConfig === null) return {}

  const raw = readIfExists(getCodexAuthPath())
  if (!raw) {
    cachedAuthConfig = null
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as { OPENAI_API_KEY?: string }
    cachedAuthConfig = {
      openaiApiKey: parsed.OPENAI_API_KEY?.trim() || undefined,
    }
    return cachedAuthConfig
  } catch {
    cachedAuthConfig = null
    return {}
  }
}

export function getOpenAIApiKey(): string | undefined {
  const envKey = process.env.OPENAI_API_KEY?.trim()
  if (envKey) return envKey
  return loadCodexAuthConfig().openaiApiKey
}

export function resolveOpenAIBaseUrl(): string {
  return normalizeBaseUrl(
    process.env.OPENAI_BASE_URL || loadCodexProviderConfig().baseUrl,
  )
}

export function shouldUseOpenAIOfficialClientHeaders(): boolean {
  return loadCodexProviderConfig().requiresOpenAIAuth
}

export function resolveOpenAIModel(currentModel: string | undefined): string {
  const candidate = normalizeOpenAICompatibleModel(currentModel)
  if (candidate) {
    return candidate
  }
  return (
    normalizeOpenAICompatibleModel(process.env.OPENAI_MODEL) ||
    normalizeOpenAICompatibleModel(loadCodexProviderConfig().model) ||
    DEFAULT_MODEL
  )
}

export function shouldStoreOpenAIResponses(): boolean {
  if (process.env.CUBENCE_DISABLE_RESPONSE_STORAGE === '1') {
    return false
  }
  return !loadCodexProviderConfig().disableResponseStorage
}

export function resolveOpenAIConfiguredContextWindow(
  currentModel?: string,
): number | undefined {
  const envWindow = matchInteger(
    process.env.OPENAI_MODEL_CONTEXT_WINDOW || '',
    /^(\d+)$/,
  )
  if (envWindow) {
    return envWindow
  }

  const config = loadCodexProviderConfig()
  if (!config.modelContextWindow) {
    return undefined
  }
  if (!currentModel) {
    return config.modelContextWindow
  }

  const configuredModel = resolveOpenAIModel(config.model)
  const normalizedCurrentModel = resolveOpenAIModel(currentModel)
  return normalizedCurrentModel === configuredModel
    ? config.modelContextWindow
    : undefined
}

export function resolveOpenAIPromptCacheRetention():
  | 'in_memory'
  | '24h'
  | undefined {
  return normalizePromptCacheRetention(
    process.env.OPENAI_PROMPT_CACHE_RETENTION ||
      loadCodexProviderConfig().promptCacheRetention,
  )
}

export function resolveOpenAIReasoningEffort():
  | OpenAIReasoningEffort
  | undefined {
  return normalizeReasoningEffort(
    process.env.OPENAI_REASONING_EFFORT ||
      loadCodexProviderConfig().reasoningEffort,
  )
}
