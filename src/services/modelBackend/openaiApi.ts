import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getOpenAIApiKey,
  resolveOpenAIBaseUrl,
  shouldUseOpenAIOfficialClientHeaders,
} from './openaiCodexConfig.js'
import {
  buildOpenAICodexTurnMetadata,
  getOpenAICodexIdentity,
  resolveOpenAICodexSessionId,
  shouldAttachOpenAICodexTurnMetadata,
} from './openaiCodexIdentity.js'
import type { OpenAIErrorPayload } from './openaiResponsesTypes.js'

const MISSING_OPENAI_API_KEY_MESSAGE =
  'OPENAI_API_KEY is not configured. Expected ~/.codex/auth.json or OPENAI_API_KEY.'

function resolveOpenAIRequestUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl
  }

  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`
  return `${resolveOpenAIBaseUrl()}${path}`
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

export async function buildOpenAIRequestHeaders(
  apiKey: string,
  extraHeaders: HeadersInit | undefined,
  body: unknown,
): Promise<Headers> {
  const headers = buildOpenAIHeaders(apiKey, extraHeaders, body)

  if (!shouldUseOpenAIOfficialClientHeaders()) {
    return headers
  }

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

  if (shouldAttachOpenAICodexTurnMetadata(body) && !headers.has('x-codex-turn-metadata')) {
    const metadata = await buildOpenAICodexTurnMetadata(body)
    if (metadata) {
      headers.set('x-codex-turn-metadata', metadata)
    }
  }

  return headers
}

export async function fetchOpenAIResponse(
  pathOrUrl: string,
  options: {
    method?: string
    body?: unknown
    headers?: HeadersInit
    signal?: AbortSignal
  } = {},
): Promise<Response> {
  const apiKey = getOpenAIApiKey()
  if (!apiKey) {
    throw new Error(MISSING_OPENAI_API_KEY_MESSAGE)
  }

  const { method = 'GET', body, headers, signal } = options
  const response = await fetch(resolveOpenAIRequestUrl(pathOrUrl), {
    method,
    headers: await buildOpenAIRequestHeaders(apiKey, headers, body),
    body:
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : jsonStringify(body),
    signal,
  })

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
  } = {},
): Promise<T> {
  const response = await fetchOpenAIResponse(pathOrUrl, options)
  const payloadText = await response.text()

  if (!payloadText) {
    throw new Error('OpenAI request returned an empty payload')
  }

  return JSON.parse(payloadText) as T
}
