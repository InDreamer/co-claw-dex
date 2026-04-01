import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getOpenAIApiKey,
  resolveOpenAIBaseUrl,
} from './openaiCodexConfig.js'
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

function buildOpenAIHeaders(
  apiKey: string,
  extraHeaders: HeadersInit | undefined,
  hasBody: boolean,
): Headers {
  const headers = new Headers(extraHeaders)
  headers.set('authorization', `Bearer ${apiKey}`)
  if (hasBody && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
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
    headers: buildOpenAIHeaders(apiKey, headers, body !== undefined),
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
