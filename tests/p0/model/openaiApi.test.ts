import { afterEach, describe, expect, it, vi } from 'vitest'

type LoadOptions = {
  apiKey?: string
  baseUrl?: string
  officialHeaders?: boolean
  sessionId?: string | undefined
  attachTurnMetadata?: boolean
  turnMetadata?: string | undefined
}

async function loadOpenAIApiModule(options: LoadOptions = {}) {
  vi.resetModules()

  vi.doMock('../../../src/services/modelBackend/openaiCodexConfig.js', () => ({
    getOpenAIApiKey: () => options.apiKey,
    resolveOpenAIBaseUrl: () => options.baseUrl ?? 'https://api.example.com/v1',
    shouldUseOpenAIOfficialClientHeaders: () =>
      options.officialHeaders ?? false,
  }))
  vi.doMock('../../../src/services/modelBackend/openaiCodexIdentity.js', () => ({
    buildOpenAICodexTurnMetadata: async () =>
      Object.prototype.hasOwnProperty.call(options, 'turnMetadata')
        ? options.turnMetadata
        : 'turn-meta',
    getOpenAICodexIdentity: async () => ({
      userAgent: 'codex-agent/1.0',
      originator: 'codex-cli',
    }),
    resolveOpenAICodexSessionId: () => options.sessionId,
    shouldAttachOpenAICodexTurnMetadata: () =>
      options.attachTurnMetadata ?? false,
  }))
  vi.doMock('../../../src/bootstrap/state.js', () => ({
    getIsNonInteractiveSession: () => false,
  }))
  vi.doMock('../../../src/utils/slowOperations.js', () => ({
    jsonStringify: (value: unknown) => JSON.stringify(value),
  }))

  return import('../../../src/services/modelBackend/openaiApi.ts')
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('openaiApi fork contracts', () => {
  it('[P0:model] normalizes JSON, raw-text, and empty error payloads into stable public error messages', async () => {
    const api = await loadOpenAIApiModule({ apiKey: 'irrelevant' })

    expect(
      api.normalizeOpenAIErrorMessage('{"error":{"message":"json failure"}}', 500),
    ).toBe('json failure')
    expect(api.normalizeOpenAIErrorMessage('plain failure', 502)).toBe(
      'plain failure',
    )
    expect(api.normalizeOpenAIErrorMessage('', 503)).toBe(
      'OpenAI request failed with status 503',
    )
  })

  it('[P0:model] always overwrites caller-supplied authorization with the configured OpenAI bearer token', async () => {
    const api = await loadOpenAIApiModule({ apiKey: 'real-key' })

    const headers = api.buildOpenAIHeaders('real-key', {
      authorization: 'Bearer caller-key',
      'x-extra': '1',
    }, { body: 'payload' })

    expect(headers.get('authorization')).toBe('Bearer real-key')
    expect(headers.get('x-extra')).toBe('1')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('[P0:model] conditionally injects official client headers while preserving caller-supplied headers', async () => {
    const plainApi = await loadOpenAIApiModule({ officialHeaders: false })
    const plainHeaders = await plainApi.buildOpenAIRequestHeaders(
      'plain-key',
      undefined,
      { hello: 'world' },
    )
    expect(plainHeaders.get('authorization')).toBe('Bearer plain-key')
    expect(plainHeaders.get('content-type')).toBe('application/json')
    expect(plainHeaders.get('user-agent')).toBeNull()
    expect(plainHeaders.get('originator')).toBeNull()
    expect(plainHeaders.get('x-client-request-id')).toBeNull()

    const officialApi = await loadOpenAIApiModule({
      officialHeaders: true,
      sessionId: 'sess-42',
      attachTurnMetadata: true,
      turnMetadata: 'signed-turn-meta',
    })
    const officialHeaders = await officialApi.buildOpenAIRequestHeaders(
      'official-key',
      { 'user-agent': 'caller-agent/9.9' },
      { some: 'payload' },
    )

    expect(officialHeaders.get('authorization')).toBe('Bearer official-key')
    expect(officialHeaders.get('user-agent')).toBe('caller-agent/9.9')
    expect(officialHeaders.get('originator')).toBe('codex-cli')
    expect(officialHeaders.get('session_id')).toBe('sess-42')
    expect(officialHeaders.get('x-client-request-id')).toBe('sess-42')
    expect(officialHeaders.get('x-codex-turn-metadata')).toBe('signed-turn-meta')
  })

  it('[P0:model] defaults raw string request bodies to application/json when the caller does not provide a content-type', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const api = await loadOpenAIApiModule({
      apiKey: 'raw-default-key',
      baseUrl: 'https://proxy.example.com/v1',
    })

    await api.fetchOpenAIResponse('/responses', {
      method: 'POST',
      body: '{"hello":"world"}',
    })

    const [, requestInit] = fetchMock.mock.calls[0]!
    expect(requestInit?.body).toBe('{"hello":"world"}')
    const headers = requestInit?.headers as Headers
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('authorization')).toBe('Bearer raw-default-key')
  })

  it('[P0:model] preserves caller-supplied content-type and raw string bodies instead of forcing JSON serialization', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const api = await loadOpenAIApiModule({
      apiKey: 'raw-key',
      baseUrl: 'https://proxy.example.com/v1',
    })

    await api.fetchOpenAIResponse('/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: '{"hello":"world"}',
    })

    const [, requestInit] = fetchMock.mock.calls[0]!
    expect(requestInit?.body).toBe('{"hello":"world"}')
    const headers = requestInit?.headers as Headers
    expect(headers.get('content-type')).toBe('application/x-ndjson')
    expect(headers.get('authorization')).toBe('Bearer raw-key')
  })

  it('[P0:model] resolves relative request paths against the normalized base URL and sends JSON bodies with auth headers', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const api = await loadOpenAIApiModule({
      apiKey: 'fallback-key',
      baseUrl: 'https://proxy.example.com/v1',
    })

    await api.fetchOpenAIResponse('responses', {
      method: 'POST',
      headers: { 'x-extra': '1' },
      body: { hello: 'world' },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, requestInit] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://proxy.example.com/v1/responses')
    expect(requestInit?.method).toBe('POST')
    expect(requestInit?.body).toBe('{"hello":"world"}')

    const headers = requestInit?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer fallback-key')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-extra')).toBe('1')
  })

  it('[P0:model] omits x-codex-turn-metadata when turn-metadata attachment is disabled even if a session id is present', async () => {
    const api = await loadOpenAIApiModule({
      apiKey: 'official-key',
      officialHeaders: true,
      sessionId: 'sess-no-turn-meta',
      attachTurnMetadata: false,
      turnMetadata: 'unused-turn-meta',
    })

    const headers = await api.buildOpenAIRequestHeaders(
      'official-key',
      undefined,
      { body: 'payload' },
    )

    expect(headers.get('session_id')).toBe('sess-no-turn-meta')
    expect(headers.get('x-client-request-id')).toBe('sess-no-turn-meta')
    expect(headers.get('x-codex-turn-metadata')).toBeNull()
  })

  it('[P0:model] omits generated session and turn-metadata headers when the Codex identity helpers return no values', async () => {
    const api = await loadOpenAIApiModule({
      apiKey: 'official-key',
      officialHeaders: true,
      sessionId: undefined,
      attachTurnMetadata: true,
      turnMetadata: undefined,
    })

    const headers = await api.buildOpenAIRequestHeaders(
      'official-key',
      undefined,
      { body: 'payload' },
    )

    expect(headers.get('user-agent')).toBe('codex-agent/1.0')
    expect(headers.get('originator')).toBe('codex-cli')
    expect(headers.get('session_id')).toBeNull()
    expect(headers.get('x-client-request-id')).toBeNull()
    expect(headers.get('x-codex-turn-metadata')).toBeNull()
  })

  it('[P0:model] preserves caller-supplied official-client identity headers instead of overwriting them', async () => {
    const api = await loadOpenAIApiModule({
      apiKey: 'official-key',
      officialHeaders: true,
      sessionId: 'sess-generated',
      attachTurnMetadata: true,
      turnMetadata: 'generated-turn-meta',
    })

    const headers = await api.buildOpenAIRequestHeaders(
      'official-key',
      {
        originator: 'caller-originator',
        session_id: 'caller-session',
        'x-client-request-id': 'caller-request-id',
        'x-codex-turn-metadata': 'caller-turn-meta',
      },
      { any: 'payload' },
    )

    expect(headers.get('originator')).toBe('caller-originator')
    expect(headers.get('session_id')).toBe('caller-session')
    expect(headers.get('x-client-request-id')).toBe('caller-request-id')
    expect(headers.get('x-codex-turn-metadata')).toBe('caller-turn-meta')
  })

  it('[P0:model] passes through absolute URLs, avoids inventing JSON content-type for bodiless requests, and preserves raw non-JSON error payloads', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const api = await loadOpenAIApiModule({
      apiKey: 'direct-key',
      baseUrl: 'https://proxy.example.com/v1',
    })

    await api.fetchOpenAIResponse('https://other.example.com/custom', {
      headers: { accept: 'text/plain' },
    })

    const [url, requestInit] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://other.example.com/custom')
    expect(requestInit?.body).toBeUndefined()
    const headers = requestInit?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer direct-key')
    expect(headers.get('accept')).toBe('text/plain')
    expect(headers.get('content-type')).toBeNull()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gateway down', { status: 502 })),
    )
    const rawErrorApi = await loadOpenAIApiModule({ apiKey: 'direct-key' })
    await expect(
      rawErrorApi.fetchOpenAIResponse('https://other.example.com/custom'),
    ).rejects.toThrow('gateway down')
  })

  it('[P0:model] surfaces missing-auth, OpenAI error payloads, and empty JSON responses as stable public errors', async () => {
    const noKeyApi = await loadOpenAIApiModule({ apiKey: undefined })
    await expect(noKeyApi.fetchOpenAIResponse('/responses')).rejects.toThrow(
      'OPENAI_API_KEY is not configured. Expected ~/.codex/auth.json or OPENAI_API_KEY.',
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('{"error":{"message":"bad auth"}}', { status: 401 }),
      ),
    )
    const failingApi = await loadOpenAIApiModule({ apiKey: 'test-key' })
    await expect(failingApi.fetchOpenAIResponse('/responses')).rejects.toThrow(
      'bad auth',
    )

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const emptyPayloadApi = await loadOpenAIApiModule({ apiKey: 'test-key' })
    await expect(emptyPayloadApi.fetchOpenAIJson('/responses')).rejects.toThrow(
      'OpenAI request returned an empty payload',
    )
  })
})
