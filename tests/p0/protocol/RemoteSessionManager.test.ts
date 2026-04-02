import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendEventToRemoteSessionMock = vi.hoisted(() => vi.fn())
const websocketState = vi.hoisted(() => ({
  callbacks: undefined as any,
  instance: undefined as any,
}))

vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: vi.fn(),
}))
vi.mock('../../../src/utils/log.js', () => ({
  logError: vi.fn(),
}))
vi.mock('../../../src/utils/teleport/api.js', () => ({
  sendEventToRemoteSession: (...args: unknown[]) => sendEventToRemoteSessionMock(...args),
}))
vi.mock('../../../src/remote/SessionsWebSocket.js', () => ({
  SessionsWebSocket: class SessionsWebSocket {
    public connect = vi.fn(async () => {})
    public sendControlResponse = vi.fn()
    public sendControlRequest = vi.fn()
    public isConnected = vi.fn(() => true)
    public close = vi.fn()
    public reconnect = vi.fn()

    constructor(
      _sessionId: string,
      _orgUuid: string,
      _getAccessToken: () => string,
      callbacks: unknown,
    ) {
      websocketState.callbacks = callbacks
      websocketState.instance = this
    }
  },
}))

import {
  RemoteSessionManager,
  createRemoteSessionConfig,
} from '../../../src/remote/RemoteSessionManager.ts'

beforeEach(() => {
  sendEventToRemoteSessionMock.mockReset()
  websocketState.callbacks = undefined
  websocketState.instance = undefined
})

describe('RemoteSessionManager protocol contracts', () => {
  it('[P0:protocol] relays websocket lifecycle callbacks so remote-session UI can distinguish connected, reconnecting, and disconnected states', () => {
    const onConnected = vi.fn()
    const onReconnecting = vi.fn()
    const onDisconnected = vi.fn()
    const manager = new RemoteSessionManager(
      createRemoteSessionConfig('session-life-1', () => 'token', 'org-life-1'),
      {
        onMessage: vi.fn(),
        onPermissionRequest: vi.fn(),
        onConnected,
        onReconnecting,
        onDisconnected,
      },
    )

    manager.connect()
    websocketState.callbacks.onConnected()
    websocketState.callbacks.onReconnecting()
    websocketState.callbacks.onClose()

    expect(onConnected).toHaveBeenCalledTimes(1)
    expect(onReconnecting).toHaveBeenCalledTimes(1)
    expect(onDisconnected).toHaveBeenCalledTimes(1)
  })

  it('[P0:protocol] forwards SDK messages to onMessage while swallowing control_response acknowledgments', () => {
    const onMessage = vi.fn()
    const manager = new RemoteSessionManager(
      createRemoteSessionConfig('session-sdk-1', () => 'token', 'org-sdk-1'),
      {
        onMessage,
        onPermissionRequest: vi.fn(),
      },
    )

    manager.connect()
    websocketState.callbacks.onMessage({
      type: 'assistant',
      uuid: 'assistant-remote-1',
      message: {
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        model: 'gpt-5.4',
        content: [{ type: 'text', text: 'forward me' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    websocketState.callbacks.onMessage({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-ack-1',
        response: { behavior: 'allow', updatedInput: {} },
      },
    })

    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistant',
        uuid: 'assistant-remote-1',
      }),
    )
  })

  it('[P0:protocol] replies with an explicit control_response error for unsupported remote control_request subtypes instead of hanging', () => {
    const onPermissionRequest = vi.fn()
    const manager = new RemoteSessionManager(
      createRemoteSessionConfig('session-1', () => 'token', 'org-1'),
      {
        onMessage: vi.fn(),
        onPermissionRequest,
      },
    )

    manager.connect()
    websocketState.callbacks.onMessage({
      type: 'control_request',
      request_id: 'req-unsupported-1',
      request: { subtype: 'future_remote_subtype' },
    })

    expect(onPermissionRequest).not.toHaveBeenCalled()
    expect(websocketState.instance.sendControlResponse).toHaveBeenCalledWith({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: 'req-unsupported-1',
        error: 'Unsupported control request subtype: future_remote_subtype',
      },
    })
  })

  it('[P0:protocol] preserves pending tool_use_id across can_use_tool requests so cancellation callbacks and allow responses stay aligned', () => {
    const onPermissionRequest = vi.fn()
    const onPermissionCancelled = vi.fn()
    const manager = new RemoteSessionManager(
      createRemoteSessionConfig('session-2', () => 'token', 'org-2'),
      {
        onMessage: vi.fn(),
        onPermissionRequest,
        onPermissionCancelled,
      },
    )

    manager.connect()
    websocketState.callbacks.onMessage({
      type: 'control_request',
      request_id: 'req-tool-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        tool_use_id: 'tool-use-123',
        input: { path: 'a.ts' },
      },
    })

    expect(onPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ tool_name: 'Read', tool_use_id: 'tool-use-123' }),
      'req-tool-1',
    )

    manager.respondToPermissionRequest('req-tool-1', {
      behavior: 'allow',
      updatedInput: { path: 'b.ts' },
    })
    expect(websocketState.instance.sendControlResponse).toHaveBeenCalledWith({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-tool-1',
        response: {
          behavior: 'allow',
          updatedInput: { path: 'b.ts' },
        },
      },
    })

    websocketState.callbacks.onMessage({
      type: 'control_request',
      request_id: 'req-tool-2',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Edit',
        tool_use_id: 'tool-use-456',
        input: { file: 'x.ts' },
      },
    })
    websocketState.callbacks.onMessage({
      type: 'control_cancel_request',
      request_id: 'req-tool-2',
    })

    expect(onPermissionCancelled).toHaveBeenCalledWith(
      'req-tool-2',
      'tool-use-456',
    )
  })

  it('[P0:protocol] encodes denied permission responses with a user-facing message instead of allow-style updatedInput payloads', () => {
    const manager = new RemoteSessionManager(
      createRemoteSessionConfig('session-deny-1', () => 'token', 'org-deny-1'),
      {
        onMessage: vi.fn(),
        onPermissionRequest: vi.fn(),
      },
    )

    manager.connect()
    websocketState.callbacks.onMessage({
      type: 'control_request',
      request_id: 'req-deny-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'tool-deny-1',
        input: { command: 'rm -rf /tmp/example' },
      },
    })

    manager.respondToPermissionRequest('req-deny-1', {
      behavior: 'deny',
      message: 'Denied by local policy',
    })

    expect(websocketState.instance.sendControlResponse).toHaveBeenCalledWith({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-deny-1',
        response: {
          behavior: 'deny',
          message: 'Denied by local policy',
        },
      },
    })
  })

  it('[P0:protocol] clears pending permission prompts on disconnect so stale local responses are not sent after teardown', () => {
    const manager = new RemoteSessionManager(
      createRemoteSessionConfig('session-disconnect-1', () => 'token', 'org-disconnect-1'),
      {
        onMessage: vi.fn(),
        onPermissionRequest: vi.fn(),
      },
    )

    manager.connect()
    websocketState.callbacks.onMessage({
      type: 'control_request',
      request_id: 'req-stale-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Edit',
        tool_use_id: 'tool-stale-1',
        input: { file: 'a.ts' },
      },
    })

    manager.disconnect()
    manager.respondToPermissionRequest('req-stale-1', {
      behavior: 'allow',
      updatedInput: { file: 'b.ts' },
    })

    expect(websocketState.instance.close).toHaveBeenCalledTimes(1)
    expect(manager.isConnected()).toBe(false)
    expect(websocketState.instance.sendControlResponse).not.toHaveBeenCalled()
  })

  it('[P0:protocol] delegates interrupt and forced reconnect commands to the websocket while preserving the configured session id', () => {
    const manager = new RemoteSessionManager(
      createRemoteSessionConfig('session-control-1', () => 'token', 'org-control-1'),
      {
        onMessage: vi.fn(),
        onPermissionRequest: vi.fn(),
      },
    )

    manager.connect()
    manager.cancelSession()
    manager.reconnect()

    expect(manager.getSessionId()).toBe('session-control-1')
    expect(websocketState.instance.sendControlRequest).toHaveBeenCalledWith({
      subtype: 'interrupt',
    })
    expect(websocketState.instance.reconnect).toHaveBeenCalledTimes(1)
  })

  it('[P0:protocol] returns the remote POST result and preserves caller-supplied UUIDs when sending session messages', async () => {
    sendEventToRemoteSessionMock.mockResolvedValueOnce(true)
    sendEventToRemoteSessionMock.mockResolvedValueOnce(false)

    const manager = new RemoteSessionManager(
      createRemoteSessionConfig('session-send-1', () => 'token', 'org-send-1'),
      {
        onMessage: vi.fn(),
        onPermissionRequest: vi.fn(),
      },
    )

    await expect(
      manager.sendMessage(
        { type: 'user_message', content: 'hello remote' } as any,
        { uuid: 'user-uuid-1' },
      ),
    ).resolves.toBe(true)
    await expect(
      manager.sendMessage({ type: 'user_message', content: 'retry later' } as any),
    ).resolves.toBe(false)

    expect(sendEventToRemoteSessionMock.mock.calls).toEqual([
      ['session-send-1', { type: 'user_message', content: 'hello remote' }, { uuid: 'user-uuid-1' }],
      ['session-send-1', { type: 'user_message', content: 'retry later' }, undefined],
    ])
  })
})
