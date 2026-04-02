import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/utils/slowOperations.js', () => ({
  jsonStringify: (value: unknown) => JSON.stringify(value),
}))

import {
  createSyntheticAssistantMessage,
  createToolStub,
} from '../../../src/remote/remotePermissionBridge.ts'

describe('remotePermissionBridge protocol contracts', () => {
  it('[P0:protocol] creates a synthetic assistant tool_use message that preserves the remote permission request payload with zero local usage accounting', () => {
    const synthetic = createSyntheticAssistantMessage(
      {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        tool_use_id: 'tool-remote-1',
        input: { path: 'src/index.ts' },
      } as any,
      'request-123',
    )

    expect(synthetic).toMatchObject({
      type: 'assistant',
      requestId: undefined,
      message: {
        id: 'remote-request-123',
        type: 'message',
        role: 'assistant',
        model: '',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [
          {
            type: 'tool_use',
            id: 'tool-remote-1',
            name: 'Read',
            input: { path: 'src/index.ts' },
          },
        ],
      },
    })
    expect(typeof synthetic.uuid).toBe('string')
    expect(synthetic.uuid.length).toBeGreaterThan(0)
    expect(Number.isNaN(Date.parse(synthetic.timestamp))).toBe(false)
  })

  it('[P0:protocol] builds fallback remote tool stubs that require permission and render at most three observable input fields with JSON stringification', async () => {
    const stub = createToolStub('RemoteSearch')

    expect(stub.name).toBe('RemoteSearch')
    expect(stub.userFacingName()).toBe('RemoteSearch')
    expect(stub.isEnabled()).toBe(true)
    expect(stub.needsPermissions()).toBe(true)
    expect(stub.isReadOnly()).toBe(false)
    expect(stub.isMcp).toBe(false)
    expect(stub.renderToolUseMessage({})).toBe('')
    expect(
      stub.renderToolUseMessage({
        query: 'needle',
        options: { scope: 'repo' },
        limit: 5,
        ignored: 'fourth field should not render',
      }),
    ).toBe('query: needle, options: {"scope":"repo"}, limit: 5')
    await expect(stub.call({} as never, {} as never)).resolves.toEqual({ data: '' })
    await expect(stub.description({} as never)).resolves.toBe('')
    expect(stub.prompt()).toBe('')
  })
})
