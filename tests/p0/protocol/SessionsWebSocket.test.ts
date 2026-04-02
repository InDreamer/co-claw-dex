import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const websocketState = vi.hoisted(() => ({
  instances: [] as FakeWebSocket[],
}))
const logErrorMock = vi.hoisted(() => vi.fn())

class FakeWebSocket {
  public handlers = new Map<string, Function>()
  public send = vi.fn()
  public close = vi.fn()
  public ping = vi.fn()

  constructor(
    public readonly url: string,
    public readonly options: Record<string, unknown>,
  ) {
    websocketState.instances.push(this)
  }

  on(event: string, handler: Function) {
    this.handlers.set(event, handler)
  }

  emit(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.(...args)
  }
}

vi.mock('crypto', () => ({
  randomUUID: () => 'uuid-fixed-123',
}))
vi.mock('ws', () => ({
  default: FakeWebSocket,
}))
vi.mock('../../../src/constants/oauth.js', () => ({
  getOauthConfig: () => ({ BASE_API_URL: 'https://api.example.com' }),
}))
vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: vi.fn(),
}))
vi.mock('../../../src/utils/errors.js', () => ({
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}))
vi.mock('../../../src/utils/log.js', () => ({
  logError: (...args: unknown[]) => logErrorMock(...args),
}))
vi.mock('../../../src/utils/mtls.js', () => ({
  getWebSocketTLSOptions: () => undefined,
}))
vi.mock('../../../src/utils/proxy.js', () => ({
  getWebSocketProxyAgent: () => undefined,
  getWebSocketProxyUrl: () => undefined,
}))
vi.mock('../../../src/utils/slowOperations.js', () => ({
  jsonParse: (value: string) => JSON.parse(value),
  jsonStringify: (value: unknown) => JSON.stringify(value),
}))

import { SessionsWebSocket } from '../../../src/remote/SessionsWebSocket.ts'

beforeEach(() => {
  websocketState.instances = []
  logErrorMock.mockReset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionsWebSocket protocol contracts', () => {
  it('[P0:protocol] constructs the subscription URL and auth headers from the OAuth base URL, session id, org id, and access token', async () => {
    const socket = new SessionsWebSocket(
      'session-connect-1',
      'org-connect-1',
      () => 'access-token-123',
      { onMessage: vi.fn() },
    )

    await socket.connect()

    expect(websocketState.instances).toHaveLength(1)
    expect(websocketState.instances[0]!.url).toBe(
      'wss://api.example.com/v1/sessions/ws/session-connect-1/subscribe?organization_uuid=org-connect-1',
    )
    expect(websocketState.instances[0]!.options).toMatchObject({
      headers: {
        Authorization: 'Bearer access-token-123',
        'anthropic-version': '2023-06-01',
      },
      agent: undefined,
    })
  })

  it('[P0:protocol] logs and ignores malformed websocket payloads instead of crashing or forwarding junk downstream', async () => {
    const onMessage = vi.fn()
    const socket = new SessionsWebSocket(
      'session-bad-json-1',
      'org-1',
      () => 'access-token',
      { onMessage },
    )

    await socket.connect()
    const ws = websocketState.instances.at(-1)!
    ws.emit('open')
    ws.emit('message', Buffer.from('{not-json'))

    expect(onMessage).not.toHaveBeenCalled()
    expect(logErrorMock).toHaveBeenCalledTimes(1)
  })

  it('[P0:protocol] ignores a duplicate connect() call while the websocket is already connecting so only one subscription is created', async () => {
    const socket = new SessionsWebSocket(
      'session-dedupe-1',
      'org-1',
      () => 'access-token',
      { onMessage: vi.fn() },
    )

    const firstConnect = socket.connect()
    const secondConnect = socket.connect()
    await Promise.all([firstConnect, secondConnect])

    expect(websocketState.instances).toHaveLength(1)
  })

  it('[P0:protocol] sends keepalive pings only while connected and stops pinging after a close transitions the socket offline', async () => {
    const socket = new SessionsWebSocket(
      'session-ping-1',
      'org-1',
      () => 'access-token',
      { onMessage: vi.fn() },
    )

    await socket.connect()
    const ws = websocketState.instances.at(-1)!
    ws.emit('open')
    expect(socket.isConnected()).toBe(true)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(ws.ping).toHaveBeenCalledTimes(1)

    ws.emit('close', 4003, Buffer.from('closed'))
    expect(socket.isConnected()).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ws.ping).toHaveBeenCalledTimes(1)
  })

  it('[P0:protocol] serializes control responses and interrupt requests onto the live websocket connection with stable envelope shapes', async () => {
    const socket = new SessionsWebSocket(
      'session-control-1',
      'org-1',
      () => 'access-token',
      { onMessage: vi.fn() },
    )

    await socket.connect()
    const ws = websocketState.instances.at(-1)!
    ws.emit('open')

    socket.sendControlResponse({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: { behavior: 'allow', updatedInput: { path: 'a.ts' } },
      },
    } as any)
    socket.sendControlRequest({ subtype: 'interrupt' } as any)

    expect(ws.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-1',
          response: { behavior: 'allow', updatedInput: { path: 'a.ts' } },
        },
      }),
    )
    expect(ws.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        type: 'control_request',
        request_id: 'uuid-fixed-123',
        request: { subtype: 'interrupt' },
      }),
    )
  })

  it('[P0:protocol] forwards unknown messages with any string type so new backend event types are not silently dropped by the transport layer', async () => {
    const onMessage = vi.fn()
    const socket = new SessionsWebSocket(
      'session-unknown-1',
      'org-1',
      () => 'access-token',
      { onMessage },
    )

    await socket.connect()
    const ws = websocketState.instances.at(-1)!
    ws.emit('open')
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'future_remote_type', payload: 42 })),
    )

    expect(onMessage).toHaveBeenCalledWith({
      type: 'future_remote_type',
      payload: 42,
    })
  })

  it('[P0:protocol] refuses to send control responses or requests while disconnected and logs the transport error instead', async () => {
    const socket = new SessionsWebSocket(
      'session-disconnected-send-1',
      'org-1',
      () => 'access-token',
      { onMessage: vi.fn() },
    )

    socket.sendControlResponse({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'req-offline-1', error: 'offline' },
    } as any)
    socket.sendControlRequest({ subtype: 'interrupt' } as any)

    expect(logErrorMock).toHaveBeenCalledTimes(2)
    expect(websocketState.instances).toHaveLength(0)
  })

  it('[P0:protocol] treats permanent close code 4003 as terminal and does not enter reconnect backoff', async () => {
    const onReconnecting = vi.fn()
    const onClose = vi.fn()
    const socket = new SessionsWebSocket(
      'session-4003-1',
      'org-1',
      () => 'access-token',
      {
        onMessage: vi.fn(),
        onReconnecting,
        onClose,
      },
    )

    await socket.connect()
    websocketState.instances[0]!.emit('open')
    websocketState.instances[0]!.emit('close', 4003, Buffer.from('unauthorized'))

    expect(onReconnecting).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('[P0:protocol] retries close code 4001 only for the bounded transient budget before surfacing a final close', async () => {
    const onReconnecting = vi.fn()
    const onClose = vi.fn()
    const socket = new SessionsWebSocket(
      'session-4001-1',
      'org-1',
      () => 'access-token',
      {
        onMessage: vi.fn(),
        onReconnecting,
        onClose,
      },
    )

    await socket.connect()
    websocketState.instances[0]!.emit('open')

    ;(socket as any).handleClose(4001)
    ;(socket as any).state = 'connecting'
    ;(socket as any).handleClose(4001)
    ;(socket as any).state = 'connecting'
    ;(socket as any).handleClose(4001)
    ;(socket as any).state = 'connecting'
    ;(socket as any).handleClose(4001)

    expect(onReconnecting).toHaveBeenCalledTimes(3)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
