import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  persistChatGPTAuthRefresh,
  resolveOpenAIBaseUrl,
  resolveSelectedCodexAuth,
  shouldUseOpenAIOfficialClientHeaders,
  type ResolvedCodexAuthConfig,
} from './openaiCodexConfig.js'
import {
  buildOpenAICodexTurnMetadata,
  getOpenAICodexIdentity,
  resolveOpenAICodexSessionId,
  shouldAttachOpenAICodexTurnMetadata,
} from './openaiCodexIdentity.js'
import type { OpenAIErrorPayload } from './openaiResponsesTypes.js'

const MISSING_OPENAI_CREDENTIAL_MESSAGE =
  'No compatible OpenAI/Codex credential is configured. Expected a ChatGPT/Codex login session in ~/.codex/auth.json, OPENAI_API_KEY, or an OPENAI_API_KEY entry in ~/.codex/auth.json.'
const CHATGPT_REFRESH_URL = 'https://auth.openai.com/oauth/token'
const CHATGPT_REFRESH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CHATGPT_TOKEN_REFRESH_INTERVAL_DAYS = 8

type ChatGPTRefreshResponse = {
  access_token?: string
  refresh_token?: string
  id_token?: string
  error?: string
  error_description?: string
}

function trimToUndefined(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function resolveOpenAIRequestUrl(
  pathOrUrl: string,
  auth: ResolvedCodexAuthConfig,
): string {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl
  }

  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`
  return `${resolveOpenAIBaseUrl(auth)}${path}`
}

function resolveConfiguredAuth(
  authOverride?: ResolvedCodexAuthConfig,
): ResolvedCodexAuthConfig {
  const resolved = authOverride ?? resolveSelectedCodexAuth()
  if (resolved.isCompatible) {
    return resolved
  }

  throw new Error(
    resolved.incompatibilityReason ||
      resolved.error ||
      MISSING_OPENAI_CREDENTIAL_MESSAGE,
  )
}

function shouldAttachOfficialHeaders(auth: ResolvedCodexAuthConfig): boolean {
  return auth.mode === 'chatgpt' || shouldUseOpenAIOfficialClientHeaders()
}

function isChatGPTAuth(
  auth: ResolvedCodexAuthConfig,
): auth is ResolvedCodexAuthConfig & {
  mode: 'chatgpt'
  accessToken: string
  refreshToken: string
  accountId: string
} {
  return (
    auth.mode === 'chatgpt' &&
    Boolean(auth.accessToken) &&
    Boolean(auth.refreshToken) &&
    Boolean(auth.accountId)
  )
}

function isChatGPTAuthRefreshStale(auth: ResolvedCodexAuthConfig): boolean {
  if (!isChatGPTAuth(auth) || !auth.lastRefresh) {
    return false
  }

  const lastRefreshMs = Date.parse(auth.lastRefresh)
  if (!Number.isFinite(lastRefreshMs)) {
    return false
  }

  const refreshIntervalMs =
    CHATGPT_TOKEN_REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000
  return Date.now() - lastRefreshMs >= refreshIntervalMs
}

function normalizeChatGPTRefreshErrorMessage(
  payloadText: string,
  status: number,
): string {
  try {
    const parsed = JSON.parse(payloadText) as ChatGPTRefreshResponse
    const message = trimToUndefined(parsed.error_description)
    if (message) {
      return message
    }
    const error = trimToUndefined(parsed.error)
    if (error) {
      return `ChatGPT/Codex token refresh failed: ${error}`
    }
  } catch {
    // 保留原始错误文本，避免刷新失败时丢失服务端信息。
  }

  return payloadText || `ChatGPT/Codex token refresh failed with status ${status}`
}

export function normalizeOpenAIErrorMessage(
  payloadText: string,
  status: number,
): string {
  try {
    const parsed = JSON.parse(payloadText) as OpenAIErrorPayload
    if (parsed.error?.message) {
      return parsed.error.message
    }
  } catch {
    // Fall back to the raw payload text.
  }

  return payloadText || `OpenAI request failed with status ${status}`
}

export function buildOpenAIHeaders(
  apiKey: string,
  extraHeaders: HeadersInit | undefined,
  body: unknown,
): Headers {
  const headers = new Headers(extraHeaders)
  headers.set('authorization', `Bearer ${apiKey}`)
  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return headers
}

export function buildChatGPTHeaders(
  accessToken: string,
  accountId: string,
  extraHeaders: HeadersInit | undefined,
  body: unknown,
): Headers {
  const headers = new Headers(extraHeaders)
  headers.set('authorization', `Bearer ${accessToken}`)
  headers.set('chatgpt-account-id', accountId)
  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return headers
}

async function appendOfficialClientHeaders(
  headers: Headers,
  body: unknown,
): Promise<void> {
  const identity = await getOpenAICodexIdentity(getIsNonInteractiveSession())
  if (!headers.has('user-agent')) {
    headers.set('user-agent', identity.userAgent)
  }
  if (!headers.has('originator')) {
    headers.set('originator', identity.originator)
  }

  const sessionId = resolveOpenAICodexSessionId(body)
  if (sessionId) {
    if (!headers.has('session_id')) {
      headers.set('session_id', sessionId)
    }
    if (!headers.has('x-client-request-id')) {
      headers.set('x-client-request-id', sessionId)
    }
  }

  if (
    shouldAttachOpenAICodexTurnMetadata(body) &&
    !headers.has('x-codex-turn-metadata')
  ) {
    const metadata = await buildOpenAICodexTurnMetadata(body)
    if (metadata) {
      headers.set('x-codex-turn-metadata', metadata)
    }
  }
}

export async function buildOpenAIRequestHeaders(
  extraHeaders: HeadersInit | undefined,
  body: unknown,
  authOverride?: ResolvedCodexAuthConfig,
): Promise<Headers> {
  const auth = resolveConfiguredAuth(authOverride)
  const headers = isChatGPTAuth(auth)
    ? buildChatGPTHeaders(auth.accessToken, auth.accountId, extraHeaders, body)
    : buildOpenAIHeaders(auth.openaiApiKey || '', extraHeaders, body)

  if (!shouldAttachOfficialHeaders(auth)) {
    return headers
  }

  await appendOfficialClientHeaders(headers, body)
  return headers
}

function normalizeRefreshPayload(payload: ChatGPTRefreshResponse): {
  accessToken: string
  refreshToken: string
  idToken?: string
} {
  const accessToken = trimToUndefined(payload.access_token)
  const refreshToken = trimToUndefined(payload.refresh_token)
  const idToken = trimToUndefined(payload.id_token)

  if (!accessToken || !refreshToken) {
    throw new Error('ChatGPT/Codex token refresh returned an incomplete token payload.')
  }

  return {
    accessToken,
    refreshToken,
    idToken,
  }
}

async function refreshChatGPTAuth(
  auth: ResolvedCodexAuthConfig & {
    mode: 'chatgpt'
    refreshToken: string
    accountId: string
    idToken?: string
  },
): Promise<ResolvedCodexAuthConfig> {
  const requestBody = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CHATGPT_REFRESH_CLIENT_ID,
    refresh_token: auth.refreshToken,
  })

  const response = await fetch(CHATGPT_REFRESH_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: requestBody.toString(),
  })

  const payloadText = await response.text()
  if (!response.ok) {
    throw new Error(
      normalizeChatGPTRefreshErrorMessage(payloadText, response.status),
    )
  }

  let payload: ChatGPTRefreshResponse
  try {
    payload = JSON.parse(payloadText) as ChatGPTRefreshResponse
  } catch {
    throw new Error('ChatGPT/Codex token refresh returned invalid JSON.')
  }

  const normalized = normalizeRefreshPayload(payload)
  persistChatGPTAuthRefresh({
    accessToken: normalized.accessToken,
    refreshToken: normalized.refreshToken,
    accountId: auth.accountId,
    idToken: normalized.idToken ?? auth.idToken,
    lastRefresh: new Date().toISOString(),
  })

  return resolveConfiguredAuth()
}

async function maybeRefreshChatGPTAuthBeforeRequest(
  auth: ResolvedCodexAuthConfig,
): Promise<ResolvedCodexAuthConfig> {
  if (!isChatGPTAuthRefreshStale(auth) || !isChatGPTAuth(auth)) {
    return auth
  }

  return refreshChatGPTAuth(auth)
}

async function performOpenAIRequest(
  pathOrUrl: string,
  options: {
    method?: string
    body?: unknown
    headers?: HeadersInit
    signal?: AbortSignal
  },
  auth: ResolvedCodexAuthConfig,
): Promise<Response> {
  const { method = 'GET', body, headers, signal } = options
  return fetch(resolveOpenAIRequestUrl(pathOrUrl, auth), {
    method,
    headers: await buildOpenAIRequestHeaders(headers, body, auth),
    body:
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : jsonStringify(body),
    signal,
  })
}

export async function fetchOpenAIResponse(
  pathOrUrl: string,
  options: {
    method?: string
    body?: unknown
    headers?: HeadersInit
    signal?: AbortSignal
    authOverride?: ResolvedCodexAuthConfig
  } = {},
): Promise<Response> {
  const initialAuth = await maybeRefreshChatGPTAuthBeforeRequest(
    resolveConfiguredAuth(options.authOverride),
  )

  const response = await performOpenAIRequest(pathOrUrl, options, initialAuth)
  if (response.status === 401 && isChatGPTAuth(initialAuth)) {
    const refreshedAuth = await refreshChatGPTAuth(initialAuth)
    const retried = await performOpenAIRequest(pathOrUrl, options, refreshedAuth)
    if (!retried.ok) {
      const payloadText = await retried.text()
      throw new Error(normalizeOpenAIErrorMessage(payloadText, retried.status))
    }
    return retried
  }

  if (!response.ok) {
    const payloadText = await response.text()
    throw new Error(normalizeOpenAIErrorMessage(payloadText, response.status))
  }

  return response
}

export async function fetchOpenAIJson<T>(
  pathOrUrl: string,
  options: {
    method?: string
    body?: unknown
    headers?: HeadersInit
    signal?: AbortSignal
    authOverride?: ResolvedCodexAuthConfig
  } = {},
): Promise<T> {
  const response = await fetchOpenAIResponse(pathOrUrl, options)
  const payloadText = await response.text()

  if (!payloadText) {
    throw new Error('OpenAI request returned an empty payload')
  }

  return JSON.parse(payloadText) as T
}
