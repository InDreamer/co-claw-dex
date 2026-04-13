import { afterEach, describe, expect, it, vi } from 'vitest'

const CHATGPT_REFRESH_URL = 'https://auth.openai.com/oauth/token'

type SelectedAuth = {
  mode: 'none' | 'api_key' | 'chatgpt'
  source: string
  wireApi: string
  isCompatible: boolean
  openaiApiKey?: string
  accessToken?: string
  refreshToken?: string
  accountId?: string
  idToken?: string
  lastRefresh?: string
  incompatibilityReason?: string
  error?: string
}

async function loadOpenAIApiModule(options: {
  selectedAuth?: Partial<SelectedAuth>
  officialHeaders?: boolean
  sessionId?: string | undefined
  attachTurnMetadata?: boolean
  turnMetadata?: string | undefined
  baseUrl?: string
} = {}) {
  vi.resetModules()

  let selectedAuth: SelectedAuth = {
    mode: 'api_key',
    source: 'OPENAI_API_KEY',
    wireApi: 'responses',
    isCompatible: true,
    openaiApiKey: 'test-api-key',
    ...options.selectedAuth,
  }
  const persistedRefreshes: Array<Record<string, unknown>> = []

  vi.doMock('../../../src/services/modelBackend/openaiCodexConfig.js', () => ({
    persistChatGPTAuthRefresh: (update: {
      accessToken: string
      refreshToken: string
      accountId: string
      idToken?: string
      lastRefresh?: string
    }) => {
      persistedRefreshes.push(update)
      selectedAuth = {
        mode: 'chatgpt',
        source: 'auth_json_chatgpt',
        wireApi: 'responses',
        isCompatible: true,
        accessToken: update.accessToken,
        refreshToken: update.refreshToken,
        accountId: update.accountId,
        idToken: update.idToken ?? selectedAuth.idToken,
        lastRefresh: update.lastRefresh,
      }
    },
    resolveSelectedCodexAuth: () => selectedAuth,
    resolveOpenAIBaseUrl: (auth: SelectedAuth = selectedAuth) =>
      options.baseUrl ??
      (auth.mode === 'chatgpt'
        ? 'https://chatgpt.com/backend-api/codex'
        : 'https://api.example.com/v1'),
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

  return {
    api: await import('../../../src/services/modelBackend/openaiApi.ts'),
    getSelectedAuth: () => selectedAuth,
    persistedRefreshes,
  }
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('openaiApi official-Codex alignment', () => {
  it('[P0:model] normalizes JSON, raw-text, and empty error payloads into stable public error messages', async () => {
    const { api } = await loadOpenAIApiModule()

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

  it('[P0:model] builds API key and ChatGPT/Codex login headers with the expected auth semantics', async () => {
    const { api } = await loadOpenAIApiModule({
      sessionId: 'sess-42',
      attachTurnMetadata: true,
      turnMetadata: 'signed-turn-meta',
    })

    const apiKeyHeaders = await api.buildOpenAIRequestHeaders(
      { authorization: 'Bearer caller-key' },
      { hello: 'world' },
      {
        mode: 'api_key',
        source: 'OPENAI_API_KEY',
        wireApi: 'responses',
        isCompatible: true,
        openaiApiKey: 'real-key',
      },
    )
    expect(apiKeyHeaders.get('authorization')).toBe('Bearer real-key')
    expect(apiKeyHeaders.get('chatgpt-account-id')).toBeNull()
    expect(apiKeyHeaders.get('user-agent')).toBeNull()

    const loginHeaders = await api.buildOpenAIRequestHeaders(
      undefined,
      { hello: 'world' },
      {
        mode: 'chatgpt',
        source: 'auth_json_chatgpt',
        wireApi: 'responses',
        isCompatible: true,
        accessToken: 'chatgpt-token',
        refreshToken: 'chatgpt-refresh-token',
        accountId: 'acct-123',
      },
    )
    expect(loginHeaders.get('authorization')).toBe('Bearer chatgpt-token')
    expect(loginHeaders.get('chatgpt-account-id')).toBe('acct-123')
    expect(loginHeaders.get('user-agent')).toBe('codex-agent/1.0')
    expect(loginHeaders.get('originator')).toBe('codex-cli')
    expect(loginHeaders.get('session_id')).toBe('sess-42')
    expect(loginHeaders.get('x-client-request-id')).toBe('sess-42')
    expect(loginHeaders.get('x-codex-turn-metadata')).toBe('signed-turn-meta')
  })

  it('[P0:model] resolves relative request paths against the auth-specific default base URL and sends JSON bodies with auth headers', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { api } = await loadOpenAIApiModule({
      selectedAuth: {
        mode: 'chatgpt',
        source: 'auth_json_chatgpt',
        accessToken: 'login-token',
        refreshToken: 'refresh-token',
        accountId: 'account-id',
      },
    })

    await api.fetchOpenAIResponse('responses', {
      method: 'POST',
      body: { hello: 'world' },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, requestInit] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(requestInit?.body).toBe('{"hello":"world"}')
    const headers = requestInit?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer login-token')
    expect(headers.get('chatgpt-account-id')).toBe('account-id')
  })

  it('[P0:model] surfaces missing credential errors before sending a request', async () => {
    const { api } = await loadOpenAIApiModule({
      selectedAuth: {
        mode: 'none',
        source: 'none',
        isCompatible: false,
        incompatibilityReason:
          '未检测到 OpenAI/Codex 凭据。请设置 OPENAI_API_KEY，或在 ~/.codex/auth.json 中提供 ChatGPT/Codex 登录态或 OPENAI_API_KEY。',
      },
    })

    await expect(api.fetchOpenAIResponse('/responses')).rejects.toThrow(
      '未检测到 OpenAI/Codex 凭据。请设置 OPENAI_API_KEY，或在 ~/.codex/auth.json 中提供 ChatGPT/Codex 登录态或 OPENAI_API_KEY。',
    )
  })

  it('[P0:model] refreshes a ChatGPT/Codex login token on 401 and retries the original /responses request exactly once', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://chatgpt.com/backend-api/codex/responses') {
        const authorization = (init?.headers as Headers).get('authorization')
        if (authorization === 'Bearer old-access-token') {
          return new Response('{"error":{"message":"expired"}}', { status: 401 })
        }
        if (authorization === 'Bearer new-access-token') {
          return new Response('{"ok":true}', { status: 200 })
        }
      }

      if (url === CHATGPT_REFRESH_URL) {
        return new Response(
          JSON.stringify({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            id_token: 'new-id-token',
          }),
          { status: 200 },
        )
      }

      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { api, persistedRefreshes, getSelectedAuth } = await loadOpenAIApiModule({
      selectedAuth: {
        mode: 'chatgpt',
        source: 'auth_json_chatgpt',
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token',
        accountId: 'account-id',
        idToken: 'old-id-token',
      },
    })

    const response = await api.fetchOpenAIResponse('/responses')
    expect(response.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1]?.[0]).toBe(CHATGPT_REFRESH_URL)
    expect(persistedRefreshes).toHaveLength(1)
    expect(persistedRefreshes[0]).toMatchObject({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      accountId: 'account-id',
      idToken: 'new-id-token',
    })
    expect(getSelectedAuth()).toMatchObject({
      mode: 'chatgpt',
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      accountId: 'account-id',
      idToken: 'new-id-token',
    })
  })

  it('[P0:model] proactively refreshes stale ChatGPT/Codex tokens before sending the request', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === CHATGPT_REFRESH_URL) {
        return new Response(
          JSON.stringify({
            access_token: 'fresh-access-token',
            refresh_token: 'fresh-refresh-token',
          }),
          { status: 200 },
        )
      }

      return new Response('{"ok":true}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { api, persistedRefreshes } = await loadOpenAIApiModule({
      selectedAuth: {
        mode: 'chatgpt',
        source: 'auth_json_chatgpt',
        accessToken: 'stale-access-token',
        refreshToken: 'stale-refresh-token',
        accountId: 'account-id',
        lastRefresh: '2026-04-01T00:00:00.000Z',
      },
    })

    await api.fetchOpenAIResponse('/responses')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CHATGPT_REFRESH_URL)
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://chatgpt.com/backend-api/codex/responses',
    )
    expect(persistedRefreshes).toHaveLength(1)
  })

  it('[P0:model] never routes API key requests through the ChatGPT refresh flow', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"error":{"message":"bad auth"}}', { status: 401 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { api } = await loadOpenAIApiModule({
      selectedAuth: {
        mode: 'api_key',
        source: 'OPENAI_API_KEY',
        openaiApiKey: 'api-key',
      },
    })

    await expect(api.fetchOpenAIResponse('/responses')).rejects.toThrow(
      'bad auth',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.com/v1/responses')
  })

  it('[P0:model] surfaces empty JSON responses as stable public errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const { api } = await loadOpenAIApiModule()

    await expect(api.fetchOpenAIJson('/responses')).rejects.toThrow(
      'OpenAI request returned an empty payload',
    )
  })
})
