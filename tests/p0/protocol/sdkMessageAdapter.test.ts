import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: vi.fn(),
}))
vi.mock('../../../src/utils/messages/mappers.js', () => ({
  fromSDKCompactMetadata: (meta: unknown) => ({ mappedFrom: meta }),
}))
vi.mock('../../../src/utils/messages.js', () => ({
  createUserMessage: (input: Record<string, unknown>) => ({
    type: 'user',
    message: {
      role: 'user',
      content: input.content,
    },
    uuid: input.uuid,
    timestamp: input.timestamp,
    toolUseResult: input.toolUseResult,
  }),
}))

import {
  convertSDKMessage,
  getResultText,
  isSessionEndMessage,
  isSuccessResult,
} from '../../../src/remote/sdkMessageAdapter.ts'

describe('sdkMessageAdapter protocol contracts', () => {
  it('[P0:protocol] converts assistant messages and partial assistant events into REPL outputs without dropping payloads', () => {
    const assistant = convertSDKMessage({
      type: 'assistant',
      uuid: 'assistant-1',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'gpt-5.4',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'hello from remote' }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      error: { message: 'warning' },
    } as any)

    expect(assistant).toMatchObject({
      type: 'message',
      message: {
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          content: [{ type: 'text', text: 'hello from remote' }],
        },
        error: { message: 'warning' },
      },
    })

    const streamEvent = convertSDKMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hel' },
      },
    } as any)
    expect(streamEvent).toEqual({
      type: 'stream_event',
      event: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hel' },
        },
      },
    })
  })

  it('[P0:protocol] maps generic status strings and result messages without explicit errors into stable system text', () => {
    expect(
      convertSDKMessage({
        type: 'system',
        subtype: 'status',
        uuid: 'status-generic-1',
        status: 'reconnecting',
      } as any),
    ).toMatchObject({
      type: 'message',
      message: {
        type: 'system',
        content: 'Status: reconnecting',
        uuid: 'status-generic-1',
      },
    })

    expect(
      convertSDKMessage({
        type: 'result',
        subtype: 'error_unknown',
        uuid: 'result-unknown-1',
      } as any),
    ).toMatchObject({
      type: 'message',
      message: {
        type: 'system',
        content: 'Unknown error',
        level: 'warning',
        uuid: 'result-unknown-1',
      },
    })
  })

  it('[P0:protocol] maps failure/status/tool-progress/compact-boundary SDK events into observable system messages while ignoring success results', () => {
    const failedResult = convertSDKMessage({
      type: 'result',
      subtype: 'error_max_turns',
      uuid: 'result-1',
      errors: ['first failure', 'second failure'],
    } as any)
    expect(failedResult).toMatchObject({
      type: 'message',
      message: {
        type: 'system',
        level: 'warning',
        content: 'first failure, second failure',
        uuid: 'result-1',
      },
    })

    expect(
      convertSDKMessage({ type: 'result', subtype: 'success', uuid: 'result-2', result: 'done' } as any),
    ).toEqual({ type: 'ignored' })

    expect(
      convertSDKMessage({ type: 'system', subtype: 'status', uuid: 'status-1', status: 'compacting' } as any),
    ).toMatchObject({
      type: 'message',
      message: { type: 'system', content: 'Compacting conversation…', uuid: 'status-1' },
    })

    expect(
      convertSDKMessage({
        type: 'tool_progress',
        uuid: 'progress-1',
        tool_name: 'Bash',
        elapsed_time_seconds: 7,
        tool_use_id: 'tool-7',
      } as any),
    ).toMatchObject({
      type: 'message',
      message: {
        type: 'system',
        content: 'Tool Bash running for 7s…',
        uuid: 'progress-1',
        toolUseID: 'tool-7',
      },
    })

    expect(
      convertSDKMessage({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-1',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 321,
          preserved_segment: {
            head_uuid: 'head-1',
            anchor_uuid: 'anchor-1',
            tail_uuid: 'tail-1',
          },
        },
      } as any),
    ).toMatchObject({
      type: 'message',
      message: {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-1',
        compactMetadata: {
          mappedFrom: {
            trigger: 'auto',
            pre_tokens: 321,
            preserved_segment: {
              head_uuid: 'head-1',
              anchor_uuid: 'anchor-1',
              tail_uuid: 'tail-1',
            },
          },
        },
      },
    })
  })

  it('[P0:protocol] converts init messages but ignores empty-status and SDK-only noise events by default', () => {
    expect(
      convertSDKMessage({
        type: 'system',
        subtype: 'init',
        uuid: 'init-1',
        model: 'gpt-5.4',
      } as any),
    ).toMatchObject({
      type: 'message',
      message: {
        type: 'system',
        content: 'Remote session initialized (model: gpt-5.4)',
        uuid: 'init-1',
      },
    })

    expect(
      convertSDKMessage({
        type: 'system',
        subtype: 'status',
        uuid: 'status-empty-1',
        status: '',
      } as any),
    ).toEqual({ type: 'ignored' })
    expect(convertSDKMessage({ type: 'auth_status' } as any)).toEqual({
      type: 'ignored',
    })
    expect(convertSDKMessage({ type: 'tool_use_summary' } as any)).toEqual({
      type: 'ignored',
    })
    expect(convertSDKMessage({ type: 'rate_limit_event' } as any)).toEqual({
      type: 'ignored',
    })
    expect(convertSDKMessage({ type: 'future_type' } as any)).toEqual({
      type: 'ignored',
    })
  })

  it('[P0:protocol] treats result messages as session-ending and only exposes result text for successful completions', () => {
    const success = {
      type: 'result',
      subtype: 'success',
      result: 'final answer',
    } as any
    const failure = {
      type: 'result',
      subtype: 'error_max_turns',
      errors: ['boom'],
    } as any
    const assistant = { type: 'assistant' } as any

    expect(isSessionEndMessage(success)).toBe(true)
    expect(isSessionEndMessage(failure)).toBe(true)
    expect(isSessionEndMessage(assistant)).toBe(false)
    expect(isSuccessResult(success)).toBe(true)
    expect(isSuccessResult(failure)).toBe(false)
    expect(getResultText(success)).toBe('final answer')
    expect(getResultText(failure)).toBeNull()
  })

  it('[P0:protocol] converts user rich-text array messages only when historical user rendering is enabled', () => {
    const richUserMessage = {
      type: 'user',
      uuid: 'user-rich-1',
      timestamp: '2026-04-02T00:00:00.000Z',
      tool_use_result: { retained: true },
      message: {
        content: [
          { type: 'text', text: 'alpha' },
          { type: 'text', text: 'beta' },
        ],
      },
    } as any

    expect(convertSDKMessage(richUserMessage)).toEqual({ type: 'ignored' })
    const converted = convertSDKMessage(richUserMessage, {
      convertUserTextMessages: true,
    })
    expect(converted).toMatchObject({
      type: 'message',
      message: {
        type: 'user',
        uuid: 'user-rich-1',
        toolUseResult: { retained: true },
      },
    })
    expect((converted as any).message.timestamp).toBe(
      '2026-04-02T00:00:00.000Z',
    )
    expect((converted as any).message.message).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'alpha' },
        { type: 'text', text: 'beta' },
      ],
    })
  })

  it('[P0:protocol] ignores misleading parent_tool_use_id metadata and still relies on actual tool_result content shape for conversion decisions', () => {
    const echoedUserMessage = {
      type: 'user',
      uuid: 'user-parent-tool-1',
      timestamp: '2026-04-02T00:00:00.000Z',
      parent_tool_use_id: 'tool-parent-only-1',
      tool_use_result: { echoed: true },
      message: {
        content: [
          { type: 'text', text: 'echoed prompt content' },
        ],
      },
    } as any

    expect(
      convertSDKMessage(echoedUserMessage, { convertToolResults: true }),
    ).toEqual({ type: 'ignored' })

    expect(
      convertSDKMessage(echoedUserMessage, {
        convertToolResults: true,
        convertUserTextMessages: true,
      }),
    ).toMatchObject({
      type: 'message',
      message: {
        type: 'user',
        uuid: 'user-parent-tool-1',
        timestamp: '2026-04-02T00:00:00.000Z',
        toolUseResult: { echoed: true },
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'echoed prompt content' },
          ],
        },
      },
    })
  })

  it('[P0:protocol] ignores hook_response system messages so CCR-only noise does not leak into the local transcript', () => {
    expect(
      convertSDKMessage({
        type: 'system',
        subtype: 'hook_response',
        uuid: 'hook-1',
      } as any),
    ).toEqual({ type: 'ignored' })
  })

  it('[P0:protocol] does not let convertUserTextMessages accidentally render tool_result payloads without the dedicated opt-in', () => {
    const toolResultOnlyMessage = {
      type: 'user',
      uuid: 'user-tool-ignore-1',
      timestamp: '2026-04-02T00:00:00.000Z',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-ignore-1',
            content: 'hidden until convertToolResults',
            is_error: false,
          },
        ],
      },
    } as any

    expect(
      convertSDKMessage(toolResultOnlyMessage, { convertUserTextMessages: true }),
    ).toEqual({ type: 'ignored' })
  })

  it('[P0:protocol] preserves timestamp metadata on the dedicated convertToolResults path for real tool_result payloads', () => {
    const toolResultWithTimestamp = {
      type: 'user',
      uuid: 'user-tool-timestamp-1',
      timestamp: '2026-04-02T01:23:45.000Z',
      tool_use_result: { source: 'remote-tool' },
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-timestamp-1',
            content: 'done',
            is_error: false,
          },
        ],
      },
    } as any

    expect(
      convertSDKMessage(toolResultWithTimestamp, { convertToolResults: true }),
    ).toMatchObject({
      type: 'message',
      message: {
        type: 'user',
        uuid: 'user-tool-timestamp-1',
        timestamp: '2026-04-02T01:23:45.000Z',
        toolUseResult: { source: 'remote-tool' },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-timestamp-1',
              content: 'done',
              is_error: false,
            },
          ],
        },
      },
    })
  })

  it('[P0:protocol] preserves mixed user content blocks when convertToolResults handles a real tool_result payload', () => {
    const mixedToolResultMessage = {
      type: 'user',
      uuid: 'user-tool-mixed-1',
      timestamp: '2026-04-02T00:00:00.000Z',
      tool_use_result: { source: 'remote' },
      message: {
        content: [
          { type: 'text', text: 'preface' },
          {
            type: 'tool_result',
            tool_use_id: 'tool-mixed-1',
            content: 'done',
            is_error: false,
          },
        ],
      },
    } as any

    expect(
      convertSDKMessage(mixedToolResultMessage, { convertToolResults: true }),
    ).toMatchObject({
      type: 'message',
      message: {
        type: 'user',
        uuid: 'user-tool-mixed-1',
        toolUseResult: { source: 'remote' },
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'preface' },
            {
              type: 'tool_result',
              tool_use_id: 'tool-mixed-1',
              content: 'done',
              is_error: false,
            },
          ],
        },
      },
    })
  })

  it('[P0:protocol] conservatively ignores unexpected user object payloads even when historical user rendering is enabled', () => {
    const unsupportedUserPayload = {
      type: 'user',
      uuid: 'user-object-1',
      timestamp: '2026-04-02T00:00:00.000Z',
      message: {
        content: { unsupported: true },
      },
    } as any

    expect(
      convertSDKMessage(unsupportedUserPayload, {
        convertUserTextMessages: true,
      }),
    ).toEqual({ type: 'ignored' })
  })

  it('[P0:protocol] prioritizes tool_result rendering over generic historical-user rendering when both opts are enabled', () => {
    const dualOptToolResultMessage = {
      type: 'user',
      uuid: 'user-tool-dual-1',
      timestamp: '2026-04-02T00:00:00.000Z',
      tool_use_result: { source: 'remote-dual' },
      message: {
        content: [
          { type: 'text', text: 'preface' },
          {
            type: 'tool_result',
            tool_use_id: 'tool-dual-1',
            content: 'done',
            is_error: false,
          },
        ],
      },
    } as any

    expect(
      convertSDKMessage(dualOptToolResultMessage, {
        convertToolResults: true,
        convertUserTextMessages: true,
      }),
    ).toMatchObject({
      type: 'message',
      message: {
        type: 'user',
        uuid: 'user-tool-dual-1',
        timestamp: '2026-04-02T00:00:00.000Z',
        toolUseResult: { source: 'remote-dual' },
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'preface' },
            {
              type: 'tool_result',
              tool_use_id: 'tool-dual-1',
              content: 'done',
              is_error: false,
            },
          ],
        },
      },
    })
  })

  it('[P0:protocol] preserves timestamp and toolUseResult metadata for plain string user messages under historical rendering', () => {
    const userTextWithMetadata = {
      type: 'user',
      uuid: 'user-text-meta-1',
      timestamp: '2026-04-02T00:00:00.000Z',
      tool_use_result: { source: 'metadata-only' },
      message: { content: 'typed remotely with metadata' },
    } as any

    expect(
      convertSDKMessage(userTextWithMetadata, {
        convertUserTextMessages: true,
        convertToolResults: true,
      }),
    ).toMatchObject({
      type: 'message',
      message: {
        type: 'user',
        uuid: 'user-text-meta-1',
        timestamp: '2026-04-02T00:00:00.000Z',
        toolUseResult: { source: 'metadata-only' },
        message: {
          role: 'user',
          content: 'typed remotely with metadata',
        },
      },
    })
  })

  it('[P0:protocol] converts user tool_result and user text messages only when the corresponding opts are enabled', () => {
    const toolResultMessage = {
      type: 'user',
      uuid: 'user-tool-1',
      timestamp: '2026-04-02T00:00:00.000Z',
      tool_use_result: { kind: 'ok' },
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'done',
            is_error: false,
          },
        ],
      },
    } as any
    expect(convertSDKMessage(toolResultMessage)).toEqual({ type: 'ignored' })
    expect(
      convertSDKMessage(toolResultMessage, { convertToolResults: true }),
    ).toMatchObject({
      type: 'message',
      message: {
        type: 'user',
        uuid: 'user-tool-1',
        toolUseResult: { kind: 'ok' },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'done',
              is_error: false,
            },
          ],
        },
      },
    })

    const userTextMessage = {
      type: 'user',
      uuid: 'user-text-1',
      timestamp: '2026-04-02T00:00:00.000Z',
      message: { content: 'typed remotely' },
    } as any
    expect(convertSDKMessage(userTextMessage)).toEqual({ type: 'ignored' })
    expect(
      convertSDKMessage(userTextMessage, { convertUserTextMessages: true }),
    ).toMatchObject({
      type: 'message',
      message: {
        type: 'user',
        uuid: 'user-text-1',
        message: {
          role: 'user',
          content: 'typed remotely',
        },
      },
    })
  })
})
