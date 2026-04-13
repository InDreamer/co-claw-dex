import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { normalizeOpenAICompatibleModel } from './openaiModelCatalog.js'

type CodexProviderConfig = {
  providerId: string
  model: string
  disableResponseStorage: boolean
  baseUrl: string
  configuredBaseUrl?: string
  wireApi: string
  wireApiError?: string
  requiresOpenAIAuth: boolean
  promptCacheRetention?: 'in_memory' | '24h'
  modelContextWindow?: number
  reasoningEffort?: OpenAIReasoningEffort
}

export type CodexAuthMode = 'none' | 'api_key' | 'chatgpt'

export type CodexAuthSource =
  | 'none'
  | 'OPENAI_API_KEY'
  | 'auth_json_api_key'
  | 'auth_json_chatgpt'

export type CodexAuthConfig = {
  mode: CodexAuthMode
  source: CodexAuthSource
  openaiApiKey?: string
  accessToken?: string
  refreshToken?: string
  accountId?: string
  idToken?: string
  lastRefresh?: string
  error?: string
}

export type ResolvedCodexAuthConfig = CodexAuthConfig & {
  wireApi: string
  isCompatible: boolean
  incompatibilityReason?: string
}

type ParsedCodexAuthFile = {
  fileOpenaiApiKey?: string
  authMode?: string
  accessToken?: string
  refreshToken?: string
  accountId?: string
  idToken?: string
  lastRefresh?: string
  error?: string
}

export type OpenAIReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'

let cachedProviderConfig: CodexProviderConfig | null | undefined
let cachedParsedAuthFile: ParsedCodexAuthFile | null | undefined

const DEFAULT_MODEL = 'gpt-5.4'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const DEFAULT_WIRE_API = 'responses'

function buildUnsupportedWireApiMessage(wireApi: string): string {
  return `当前配置的 wire_api = "${wireApi}" 无效。OpenAI/Codex 公开 CLI 仅支持 wire_api = "responses"。`
}

function trimToUndefined(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function getCodexConfigPath(): string {
  return (
    trimToUndefined(process.env.COCLAWDEX_CONFIG_PATH) ||
    join(homedir(), '.codex', 'config.toml')
  )
}

export function getCodexAuthPath(): string {
  return join(homedir(), '.codex', 'auth.json')
}

export function resolveCodexConfigPathInfo(): {
  path: string
  source: 'COCLAWDEX_CONFIG_PATH' | 'default'
} {
  const override = trimToUndefined(process.env.COCLAWDEX_CONFIG_PATH)
  if (override) {
    return {
      path: override,
      source: 'COCLAWDEX_CONFIG_PATH',
    }
  }

  return {
    path: getCodexConfigPath(),
    source: 'default',
  }
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

function normalizeWireApi(
  wireApi: string | undefined,
): {
  wireApi: string
  wireApiError?: string
} {
  const normalized = wireApi?.trim().toLowerCase() || DEFAULT_WIRE_API
  if (normalized === DEFAULT_WIRE_API) {
    return { wireApi: DEFAULT_WIRE_API }
  }

  return {
    wireApi: normalized,
    wireApiError: buildUnsupportedWireApiMessage(normalized),
  }
}

function loadParsedCodexAuthFile(): ParsedCodexAuthFile {
  if (cachedParsedAuthFile) return cachedParsedAuthFile
  if (cachedParsedAuthFile === null) return {}

  const authPath = getCodexAuthPath()
  const raw = readIfExists(authPath)
  if (!raw) {
    cachedParsedAuthFile = null
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as {
      OPENAI_API_KEY?: string
      auth_mode?: string
      last_refresh?: string
      tokens?: {
        access_token?: string
        refresh_token?: string
        account_id?: string
        id_token?: string
      }
    }
    const authMode = trimToUndefined(parsed.auth_mode)?.toLowerCase()
    const accessToken = trimToUndefined(parsed.tokens?.access_token)
    const refreshToken = trimToUndefined(parsed.tokens?.refresh_token)
    const accountId = trimToUndefined(parsed.tokens?.account_id)
    const idToken = trimToUndefined(parsed.tokens?.id_token)
    const parsedFile: ParsedCodexAuthFile = {
      fileOpenaiApiKey: trimToUndefined(parsed.OPENAI_API_KEY),
      authMode,
      accessToken,
      refreshToken,
      accountId,
      idToken,
      lastRefresh: trimToUndefined(parsed.last_refresh),
    }

    if (
      authMode === 'chatgpt' &&
      (!accessToken || !refreshToken || !accountId)
    ) {
      parsedFile.error =
        `检测到 ${authPath} 使用 auth_mode="chatgpt"，` +
        '但缺少 tokens.access_token、tokens.refresh_token 或 tokens.account_id。'
    }

    cachedParsedAuthFile = parsedFile
    return parsedFile
  } catch {
    cachedParsedAuthFile = {
      error: `无法解析 ${authPath}。请确认它是合法 JSON。`,
    }
    return cachedParsedAuthFile
  }
}

function getChatGPTAuthCandidate(
  parsed: ParsedCodexAuthFile,
): CodexAuthConfig | undefined {
  if (
    parsed.authMode === 'chatgpt' &&
    parsed.accessToken &&
    parsed.refreshToken &&
    parsed.accountId
  ) {
    return {
      mode: 'chatgpt',
      source: 'auth_json_chatgpt',
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      accountId: parsed.accountId,
      idToken: parsed.idToken,
      lastRefresh: parsed.lastRefresh,
    }
  }
  return undefined
}

function getEnvApiKeyCandidate(): CodexAuthConfig | undefined {
  const apiKey = trimToUndefined(process.env.OPENAI_API_KEY)
  if (!apiKey) {
    return undefined
  }

  return {
    mode: 'api_key',
    source: 'OPENAI_API_KEY',
    openaiApiKey: apiKey,
  }
}

function getFileApiKeyCandidate(
  parsed: ParsedCodexAuthFile,
): CodexAuthConfig | undefined {
  if (!parsed.fileOpenaiApiKey) {
    return undefined
  }

  return {
    mode: 'api_key',
    source: 'auth_json_api_key',
    openaiApiKey: parsed.fileOpenaiApiKey,
  }
}

function buildNoAuthConfig(error?: string): CodexAuthConfig {
  return {
    mode: 'none',
    source: 'none',
    error,
  }
}

export function formatCodexAuthSource(source: CodexAuthSource): string {
  switch (source) {
    case 'OPENAI_API_KEY':
      return 'OPENAI_API_KEY'
    case 'auth_json_api_key':
      return `${getCodexAuthPath()} (OPENAI_API_KEY)`
    case 'auth_json_chatgpt':
      return `${getCodexAuthPath()} (auth_mode="chatgpt")`
    case 'none':
    default:
      return '未配置'
  }
}

export function formatCodexAuthMode(mode: CodexAuthMode): string {
  switch (mode) {
    case 'api_key':
      return 'OpenAI API key'
    case 'chatgpt':
      return 'ChatGPT/Codex 登录态'
    case 'none':
    default:
      return '未配置'
  }
}

export function loadCodexProviderConfig(): CodexProviderConfig {
  if (cachedProviderConfig) return cachedProviderConfig
  if (cachedProviderConfig === null) {
    return {
      providerId: 'openai',
      model: DEFAULT_MODEL,
      disableResponseStorage: true,
      baseUrl: DEFAULT_BASE_URL,
      configuredBaseUrl: undefined,
      wireApi: DEFAULT_WIRE_API,
      wireApiError: undefined,
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
  const configuredBaseUrl = normalizeBaseUrl(
    matchString(providerSection, /^\s*base_url\s*=\s*"([^"]+)"/m),
  )
  const { wireApi, wireApiError } = normalizeWireApi(
    matchString(providerSection, /^\s*wire_api\s*=\s*"([^"]+)"/m),
  )
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
    matchInteger(process.env.OPENAI_MODEL_CONTEXT_WINDOW || '', /^(\d+)$/)
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
    baseUrl: configuredBaseUrl,
    configuredBaseUrl:
      matchString(providerSection, /^\s*base_url\s*=\s*"([^"]+)"/m) !== undefined
        ? configuredBaseUrl
        : undefined,
    wireApi,
    wireApiError,
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
  const parsed = loadParsedCodexAuthFile()
  return (
    getChatGPTAuthCandidate(parsed) ||
    getEnvApiKeyCandidate() ||
    getFileApiKeyCandidate(parsed) ||
    buildNoAuthConfig(parsed.error)
  )
}

export function resolveSelectedCodexAuth(): ResolvedCodexAuthConfig {
  const provider = loadCodexProviderConfig()
  const selectedAuth = loadCodexAuthConfig()

  if (provider.wireApiError) {
    return {
      ...selectedAuth,
      wireApi: provider.wireApi,
      isCompatible: false,
      incompatibilityReason: provider.wireApiError,
      error: provider.wireApiError,
    }
  }

  if (selectedAuth.mode !== 'none') {
    return {
      ...selectedAuth,
      wireApi: provider.wireApi,
      isCompatible: true,
    }
  }

  return {
    ...selectedAuth,
    wireApi: provider.wireApi,
    isCompatible: false,
    incompatibilityReason:
      selectedAuth.error ||
      `未检测到 OpenAI/Codex 凭据。请设置 OPENAI_API_KEY，或在 ${getCodexAuthPath()} 中提供 ChatGPT/Codex 登录态或 OPENAI_API_KEY。`,
  }
}

export function getOpenAIApiKey(): string | undefined {
  const resolved = resolveSelectedCodexAuth()
  return resolved.isCompatible && resolved.mode === 'api_key'
    ? resolved.openaiApiKey
    : undefined
}

export function resolveOpenAIBaseUrl(
  auth = resolveSelectedCodexAuth(),
): string {
  const envBaseUrl = trimToUndefined(process.env.OPENAI_BASE_URL)
  if (envBaseUrl) {
    return normalizeBaseUrl(envBaseUrl)
  }

  const provider = loadCodexProviderConfig()
  if (provider.configuredBaseUrl) {
    return provider.configuredBaseUrl
  }

  return auth.mode === 'chatgpt' ? DEFAULT_CHATGPT_BASE_URL : DEFAULT_BASE_URL
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

export function invalidateCodexAuthCache(): void {
  cachedParsedAuthFile = undefined
}

export function persistChatGPTAuthRefresh(update: {
  accessToken: string
  refreshToken: string
  accountId: string
  idToken?: string
  lastRefresh?: string
}): void {
  const authPath = getCodexAuthPath()
  const raw = readIfExists(authPath)
  if (!raw) {
    throw new Error(`未找到 ${authPath}，无法回写 ChatGPT/Codex 登录态。`)
  }

  let parsed: {
    OPENAI_API_KEY?: string
    auth_mode?: string
    last_refresh?: string
    tokens?: {
      access_token?: string
      refresh_token?: string
      account_id?: string
      id_token?: string
    }
  }
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`无法解析 ${authPath}，无法回写 ChatGPT/Codex 登录态。`)
  }

  const next = {
    ...parsed,
    auth_mode: 'chatgpt',
    last_refresh: update.lastRefresh || new Date().toISOString(),
    tokens: {
      ...(parsed.tokens ?? {}),
      access_token: update.accessToken,
      refresh_token: update.refreshToken,
      account_id: update.accountId,
      ...(update.idToken !== undefined
        ? { id_token: update.idToken }
        : {}),
    },
  }

  mkdirSync(dirname(authPath), { recursive: true })
  writeFileSync(authPath, JSON.stringify(next, null, 2), 'utf8')
  invalidateCodexAuthCache()
}
