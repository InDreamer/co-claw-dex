import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchOpenAIResponseMock = vi.hoisted(() => vi.fn())
const resolveAppliedEffortMock = vi.hoisted(() => vi.fn(() => undefined))

vi.mock('../../../src/bootstrap/state.js', () => ({
  getSessionId: () => 'session-123',
}))
vi.mock('../../../src/utils/messages.js', () => ({
  createAssistantAPIErrorMessage: ({ content }: { content: string }) => ({
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      model: 'uninitialized',
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: 'text', text: content }],
    },
  }),
  createAssistantMessage: ({ content, usage }: { content: unknown; usage: unknown }) => ({
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'uninitialized',
      usage,
      content:
        typeof content === 'string'
          ? [{ type: 'text', text: content }]
          : content,
    },
  }),
  getContentText: (content: unknown) => {
    if (typeof content === 'string') {
      return content
    }
    if (Array.isArray(content)) {
      return content
        .map(block => {
          if (typeof block === 'string') return block
          if (block && typeof block === 'object' && 'text' in block) {
            return String((block as { text?: unknown }).text ?? '')
          }
          return ''
        })
        .join('')
    }
    return ''
  },
}))
vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: vi.fn(),
}))
vi.mock('../../../src/utils/envValidation.js', () => ({
  validateBoundedIntEnvVar: () => ({ effective: 32000 }),
}))
vi.mock('../../../src/utils/slowOperations.js', () => ({
  jsonStringify: (value: unknown) => JSON.stringify(value),
}))
vi.mock('../../../src/utils/zodToJsonSchema.js', () => ({
  zodToJsonSchema: () => ({ type: 'object' }),
}))
vi.mock('../../../src/utils/effort.js', () => ({
  convertEffortValueToLevel: (value: unknown) => value,
  resolveAppliedEffort: (...args: unknown[]) => resolveAppliedEffortMock(...args),
}))
vi.mock('../../../src/Tool.js', () => ({
  getEmptyToolPermissionContext: () => ({}),
}))
vi.mock('../../../src/services/modelBackend/openaiCodexConfig.js', () => ({
  resolveOpenAIModel: () => 'gpt-5.2',
  resolveOpenAIPromptCacheRetention: () => '24h',
  shouldStoreOpenAIResponses: () => true,
}))
vi.mock('../../../src/services/modelBackend/openaiApi.js', () => ({
  fetchOpenAIResponse: (...args: unknown[]) => fetchOpenAIResponseMock(...args),
}))

import { runOpenAIResponses } from '../../../src/services/modelBackend/openaiResponsesBackend.ts'

function makeRawSseResponse(chunks: string[]) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function makeSseResponse(events: Array<Record<string, unknown>>) {
  return makeRawSseResponse(
    events.map(
      event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
    ),
  )
}

async function collect(generator: AsyncGenerator<any>) {
  const items: any[] = []
  for await (const item of generator) {
    items.push(item)
  }
  return items
}

beforeEach(() => {
  fetchOpenAIResponseMock.mockReset()
  resolveAppliedEffortMock.mockReset()
  resolveAppliedEffortMock.mockReturnValue(undefined)
})

describe('openaiResponsesBackend fork contracts', () => {
  it('[P0:model] serializes structured tool_result content into function_call_output payloads without dropping observable text', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-structured-tool-result-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          },
        },
      ]),
    )

    await collect(
      runOpenAIResponses({
        messages: [
          {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-array-1',
                  content: [
                    { type: 'text', text: 'plain text' },
                    { type: 'text', text: ' + more' },
                  ],
                  is_error: false,
                },
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-object-1',
                  content: { ok: true, value: 7 },
                  is_error: false,
                },
              ],
            },
          },
        ],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    const [, options] = fetchOpenAIResponseMock.mock.calls.at(-1)!
    expect(options.body.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'tool-array-1',
        output: 'plain text + more',
      },
      {
        type: 'function_call_output',
        call_id: 'tool-object-1',
        output: '{"ok":true,"value":7}',
      },
    ])
  })

  it('[P0:model] omits empty historical text turns but preserves plain assistant text and rich user-text arrays in request input', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-history-mix-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: {
              input_tokens: 3,
              output_tokens: 1,
            },
          },
        },
      ]),
    )

    await collect(
      runOpenAIResponses({
        messages: [
          { type: 'user', message: { content: '' } },
          { type: 'assistant', message: { content: 'assistant plain text' } },
          {
            type: 'user',
            message: {
              content: [
                { type: 'text', text: 'rich ' },
                { type: 'text', text: 'user text' },
              ],
            },
          },
        ],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    const [, options] = fetchOpenAIResponseMock.mock.calls.at(-1)!
    expect(options.body.input).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'assistant plain text' }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'rich user text' }],
      },
    ])
  })

  it('[P0:model] omits an empty assistant text item when a historical assistant turn contains only tool_use blocks', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-tool-only-assistant-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: {
              input_tokens: 3,
              output_tokens: 1,
            },
          },
        },
      ]),
    )

    await collect(
      runOpenAIResponses({
        messages: [
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'tool-only-a', name: 'Read', input: { path: 'a.ts' } },
                { type: 'tool_use', id: 'tool-only-b', name: 'Edit', input: { file: 'b.ts' } },
              ],
            },
          },
        ],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    const [, options] = fetchOpenAIResponseMock.mock.calls.at(-1)!
    expect(options.body.input).toEqual([
      {
        type: 'function_call',
        call_id: 'tool-only-a',
        name: 'Read',
        arguments: '{"path":"a.ts"}',
      },
      {
        type: 'function_call',
        call_id: 'tool-only-b',
        name: 'Edit',
        arguments: '{"file":"b.ts"}',
      },
    ])
  })

  it('[P0:model] preserves the order of multiple tool_use blocks from one assistant turn in the Responses input payload', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-multi-tool-use-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: {
              input_tokens: 4,
              output_tokens: 1,
            },
          },
        },
      ]),
    )

    await collect(
      runOpenAIResponses({
        messages: [
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'calling tools' },
                { type: 'tool_use', id: 'tool-a', name: 'Read', input: { path: 'a.ts' } },
                { type: 'tool_use', id: 'tool-b', name: 'Edit', input: { file: 'b.ts', value: 'x' } },
              ],
            },
          },
        ],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    const [, options] = fetchOpenAIResponseMock.mock.calls.at(-1)!
    expect(options.body.input).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'calling tools' }],
      },
      {
        type: 'function_call',
        call_id: 'tool-a',
        name: 'Read',
        arguments: '{"path":"a.ts"}',
      },
      {
        type: 'function_call',
        call_id: 'tool-b',
        name: 'Edit',
        arguments: '{"file":"b.ts","value":"x"}',
      },
    ])
  })

  it('[P0:model] prioritizes tool_result serialization over any co-located user text in the same historical message', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-user-mixed-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: {
              input_tokens: 2,
              output_tokens: 1,
            },
          },
        },
      ]),
    )

    await collect(
      runOpenAIResponses({
        messages: [
          {
            type: 'user',
            message: {
              content: [
                { type: 'text', text: 'preface text that should not become input_text' },
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-priority-1',
                  content: 'tool output wins',
                  is_error: false,
                },
              ],
            },
          },
        ],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    const [, options] = fetchOpenAIResponseMock.mock.calls.at(-1)!
    expect(options.body.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'tool-priority-1',
        output: 'tool output wins',
      },
    ])
  })

  it('[P0:model] translates user text, assistant tool_use, and tool_result history into Responses input payloads', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              input_tokens_details: { cached_tokens: 4 },
            },
          },
        },
      ]),
    )

    const params = {
      messages: [
        { type: 'user', message: { content: 'hello model' } },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'calling tool' },
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.ts' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'file contents',
                is_error: false,
              },
            ],
          },
        },
      ],
      systemPrompt: ['system prompt'],
      tools: [
        {
          name: 'Read',
          inputJSONSchema: { type: 'object', properties: { path: { type: 'string' } } },
          prompt: async () => 'Read a file',
        },
      ],
      options: {
        model: 'sonnet',
        toolChoice: { type: 'tool', name: 'Read' },
      },
      signal: new AbortController().signal,
    } as any

    await collect(runOpenAIResponses(params))

    expect(fetchOpenAIResponseMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchOpenAIResponseMock.mock.calls[0]!
    expect(url).toBe('/responses')
    expect(options.method).toBe('POST')
    expect(options.headers).toEqual({ accept: 'text/event-stream' })
    expect(options.body).toMatchObject({
      stream: true,
      model: 'gpt-5.2',
      instructions: 'system prompt',
      store: true,
      prompt_cache_key: 'session-123',
      prompt_cache_retention: '24h',
      tool_choice: { type: 'function', name: 'Read' },
      parallel_tool_calls: true,
      tools: [
        {
          type: 'function',
          name: 'Read',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'hello model' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'calling tool' }],
        },
        {
          type: 'function_call',
          call_id: 'tool-1',
          name: 'Read',
          arguments: '{"path":"a.ts"}',
        },
        {
          type: 'function_call_output',
          call_id: 'tool-1',
          output: 'file contents',
        },
      ],
    })
  })

  it('[P0:model] preserves mixed historical message ordering across user text, assistant text/tool_use, tool_result precedence, and later tool-only assistant turns', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-history-order-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: {
              input_tokens: 7,
              output_tokens: 1,
            },
          },
        },
      ]),
    )

    await collect(
      runOpenAIResponses({
        messages: [
          { type: 'user', message: { content: 'first user turn' } },
          { type: 'assistant', message: { content: 'assistant plain text' } },
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'calling tool now' },
                { type: 'tool_use', id: 'tool-history-1', name: 'Read', input: { path: 'a.ts' } },
              ],
            },
          },
          {
            type: 'user',
            message: {
              content: [
                { type: 'text', text: 'ignored beside tool result' },
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-history-1',
                  content: 'tool output wins',
                  is_error: false,
                },
              ],
            },
          },
          {
            type: 'user',
            message: {
              content: [
                { type: 'text', text: 'follow ' },
                { type: 'text', text: 'up turn' },
              ],
            },
          },
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'tool-history-2', name: 'Edit', input: { file: 'b.ts' } },
              ],
            },
          },
        ],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    const [, options] = fetchOpenAIResponseMock.mock.calls.at(-1)!
    expect(options.body.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'first user turn' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'assistant plain text' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'calling tool now' }],
      },
      {
        type: 'function_call',
        call_id: 'tool-history-1',
        name: 'Read',
        arguments: '{"path":"a.ts"}',
      },
      {
        type: 'function_call_output',
        call_id: 'tool-history-1',
        output: 'tool output wins',
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'follow up turn' }],
      },
      {
        type: 'function_call',
        call_id: 'tool-history-2',
        name: 'Edit',
        arguments: '{"file":"b.ts"}',
      },
    ])
  })

  it('[P0:model] falls back to zodToJsonSchema when a tool omits inputJSONSchema in the Responses request payload', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-tool-schema-fallback-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          },
        },
      ]),
    )

    await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['tool schema fallback'],
        tools: [
          {
            name: 'Search',
            inputSchema: { fake: 'zod-schema' },
            prompt: async () => 'Search for files',
          },
        ],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    const [, options] = fetchOpenAIResponseMock.mock.calls.at(-1)!
    expect(options.body).toMatchObject({
      tools: [
        {
          type: 'function',
          name: 'Search',
          description: 'Search for files',
          parameters: { type: 'object' },
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    })
  })

  it('[P0:model] includes reasoning.effort in the Responses request when resolveAppliedEffort returns a value', async () => {
    resolveAppliedEffortMock.mockReturnValue('high')
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-reasoning-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: {
              input_tokens: 2,
              output_tokens: 1,
            },
          },
        },
      ]),
    )

    await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['reason carefully'],
        tools: [],
        options: { model: 'sonnet', effortValue: 'high' },
        signal: new AbortController().signal,
      } as any),
    )

    const [, options] = fetchOpenAIResponseMock.mock.calls.at(-1)!
    expect(options.body.reasoning).toEqual({ effort: 'high' })
  })

  it('[P0:model] uses auto tool choice plus JSON-schema text formatting and max-output overrides when requested', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-format-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: '{"ok":true}' }],
              },
            ],
            usage: {
              input_tokens: 2,
              output_tokens: 3,
            },
          },
        },
      ]),
    )

    await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['format as json'],
        tools: [
          {
            name: 'Read',
            inputJSONSchema: { type: 'object' },
            prompt: async () => 'Read a file',
          },
        ],
        options: {
          model: 'sonnet',
          outputFormat: {
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
            },
          },
          maxOutputTokensOverride: 321,
        },
        signal: new AbortController().signal,
      } as any),
    )

    const [, options] = fetchOpenAIResponseMock.mock.calls.at(-1)!
    expect(options.body).toMatchObject({
      tool_choice: 'auto',
      parallel_tool_calls: true,
      max_output_tokens: 321,
      text: {
        format: {
          type: 'json_schema',
          name: 'claude_code_output_schema',
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
        },
      },
    })
    expect((options.body as any).text.format).not.toHaveProperty('strict')
  })

  it('[P0:model] still emits assistant messages when a completed Responses payload omits usage entirely', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-no-usage-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'no usage attached' }],
              },
            ],
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'message_stop' } },
      {
        type: 'assistant',
        requestId: 'resp-no-usage-1',
        message: {
          model: 'gpt-5.2',
          usage: undefined,
          content: [{ type: 'text', text: 'no usage attached' }],
        },
      },
    ])
  })

  it('[P0:model] preserves multiple output_text parts from one completed Responses message as distinct assistant text blocks', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-multi-output-text-1',
            output: [
              {
                type: 'message',
                content: [
                  { type: 'output_text', text: ' hello' },
                  { type: 'output_text', text: ' world ' },
                ],
              },
            ],
            usage: {
              input_tokens: 3,
              output_tokens: 2,
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'message_stop' } },
      {
        type: 'assistant',
        requestId: 'resp-multi-output-text-1',
        message: {
          model: 'gpt-5.2',
          usage: {
            input_tokens: 3,
            cache_read_input_tokens: 0,
            output_tokens: 2,
          },
          content: [
            { type: 'text', text: 'hello', citations: [] },
            { type: 'text', text: 'world', citations: [] },
          ],
        },
      },
    ])
  })

  it('[P0:model] clamps mapped input_tokens at zero when cached_tokens exceed the reported total input tokens', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-usage-clamp-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'usage clamp' }],
              },
            ],
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              input_tokens_details: { cached_tokens: 9 },
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'message_stop' } },
      {
        type: 'assistant',
        requestId: 'resp-usage-clamp-1',
        message: {
          model: 'gpt-5.2',
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 9,
            output_tokens: 2,
          },
          content: [{ type: 'text', text: 'usage clamp' }],
        },
      },
    ])
  })

  it('[P0:model] maps completed Responses payloads into assistant text/tool_use messages with Claude-style usage fields', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-2',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'hello back' }],
              },
              {
                type: 'function_call',
                call_id: 'tool-9',
                name: 'Read',
                arguments: '{"path":"b.ts"}',
              },
            ],
            usage: {
              input_tokens: 12,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 7 },
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      {
        type: 'stream_event',
        event: { type: 'message_start' },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'assistant',
        requestId: 'resp-2',
        message: {
          model: 'gpt-5.2',
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 7,
            output_tokens: 5,
          },
          content: [{ type: 'text', text: 'hello back' }],
        },
      },
      {
        type: 'assistant',
        requestId: 'resp-2',
        message: {
          model: 'gpt-5.2',
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 7,
            output_tokens: 5,
          },
          content: [
            {
              type: 'tool_use',
              id: 'tool-9',
              name: 'Read',
              input: { path: 'b.ts' },
            },
          ],
        },
      },
    ])
  })

  it('[P0:model] preserves the order of multiple function_call output items from one completed response', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-multi-function-call-1',
            output: [
              {
                type: 'function_call',
                call_id: 'tool-multi-a',
                name: 'Read',
                arguments: '{"path":"a.ts"}',
              },
              {
                type: 'function_call',
                call_id: 'tool-multi-b',
                name: 'Edit',
                arguments: '{"file":"b.ts","value":"x"}',
              },
            ],
            usage: {
              input_tokens: 6,
              output_tokens: 3,
              input_tokens_details: { cached_tokens: 1 },
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs.slice(0, 2)).toMatchObject([
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'message_stop' } },
    ])

    const assistantMessages = outputs.filter(output => output.type === 'assistant')
    expect(assistantMessages).toMatchObject([
      {
        type: 'assistant',
        requestId: 'resp-multi-function-call-1',
        message: {
          model: 'gpt-5.2',
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 1,
            output_tokens: 3,
          },
          content: [
            {
              type: 'tool_use',
              id: 'tool-multi-a',
              name: 'Read',
              input: { path: 'a.ts' },
            },
          ],
        },
      },
      {
        type: 'assistant',
        requestId: 'resp-multi-function-call-1',
        message: {
          model: 'gpt-5.2',
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 1,
            output_tokens: 3,
          },
          content: [
            {
              type: 'tool_use',
              id: 'tool-multi-b',
              name: 'Edit',
              input: { file: 'b.ts', value: 'x' },
            },
          ],
        },
      },
    ])
  })

  it('[P0:model] preserves output-item order plus requestId/model/usage when a completed response emits tool_use, text, then tool_use', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-mixed-order-1',
            output: [
              {
                type: 'function_call',
                call_id: 'tool-order-a',
                name: 'Read',
                arguments: '{"path":"first.ts"}',
              },
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'between tools' }],
              },
              {
                type: 'function_call',
                call_id: 'tool-order-b',
                name: 'Edit',
                arguments: '{"file":"second.ts","value":"done"}',
              },
            ],
            usage: {
              input_tokens: 9,
              output_tokens: 4,
              input_tokens_details: { cached_tokens: 2 },
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs.slice(0, 2)).toMatchObject([
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'message_stop' } },
    ])

    const assistantMessages = outputs.filter(output => output.type === 'assistant')
    expect(assistantMessages).toMatchObject([
      {
        type: 'assistant',
        requestId: 'resp-mixed-order-1',
        message: {
          model: 'gpt-5.2',
          usage: {
            input_tokens: 7,
            cache_read_input_tokens: 2,
            output_tokens: 4,
          },
          content: [
            {
              type: 'tool_use',
              id: 'tool-order-a',
              name: 'Read',
              input: { path: 'first.ts' },
            },
          ],
        },
      },
      {
        type: 'assistant',
        requestId: 'resp-mixed-order-1',
        message: {
          model: 'gpt-5.2',
          usage: {
            input_tokens: 7,
            cache_read_input_tokens: 2,
            output_tokens: 4,
          },
          content: [{ type: 'text', text: 'between tools' }],
        },
      },
      {
        type: 'assistant',
        requestId: 'resp-mixed-order-1',
        message: {
          model: 'gpt-5.2',
          usage: {
            input_tokens: 7,
            cache_read_input_tokens: 2,
            output_tokens: 4,
          },
          content: [
            {
              type: 'tool_use',
              id: 'tool-order-b',
              name: 'Edit',
              input: { file: 'second.ts', value: 'done' },
            },
          ],
        },
      },
    ])
  })

  it('[P0:model] uses distinct default assistant API error text for failed vs incomplete stream events when OpenAI omits details', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item_id: 'msg-item-fallback-failed',
          item: { type: 'message' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg-item-fallback-failed',
          delta: 'partial failure output',
        },
        {
          type: 'response.failed',
          response: {},
        },
      ]),
    )

    const failedOutputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(failedOutputs).toEqual([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial failure output' },
        },
      },
      {
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          model: 'uninitialized',
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [
            {
              type: 'text',
              text: 'OpenAI Responses returned a failed streaming event.',
            },
          ],
        },
      },
    ])

    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item_id: 'msg-item-fallback-incomplete',
          item: { type: 'message' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg-item-fallback-incomplete',
          delta: 'partial incomplete output',
        },
        {
          type: 'response.incomplete',
          response: {},
        },
      ]),
    )

    const incompleteOutputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(incompleteOutputs).toEqual([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial incomplete output' },
        },
      },
      {
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          model: 'uninitialized',
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [
            {
              type: 'text',
              text: 'OpenAI Responses stream ended before completion.',
            },
          ],
        },
      },
    ])
  })

  it('[P0:model] emits only one message_start even if response.created appears again after the stream has already started', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item_id: 'msg-item-dup-created-1',
          item: { type: 'message' },
        },
        { type: 'response.created' },
        {
          type: 'response.output_text.delta',
          item_id: 'msg-item-dup-created-1',
          delta: 'only one start',
        },
        {
          type: 'response.output_text.done',
          item_id: 'msg-item-dup-created-1',
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-dup-created-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'only one start' }],
              },
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(
      outputs.filter(
        output => output.type === 'stream_event' && output.event.type === 'message_start',
      ),
    ).toHaveLength(1)
    expect(outputs).toMatchObject([
      {
        type: 'stream_event',
        event: { type: 'message_start' },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'only one start' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'assistant',
        requestId: 'resp-dup-created-1',
        message: {
          model: 'gpt-5.2',
          content: [{ type: 'text', text: 'only one start' }],
        },
      },
    ])
  })

  it('[P0:model] starts a Claude-style streamed assistant turn on the first function-call item even if response.created is absent', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item_id: 'fn-item-no-created',
          item: {
            type: 'function_call',
            call_id: 'tool-no-created-1',
            name: 'Read',
            arguments: '',
          },
        },
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'fn-item-no-created',
          delta: '{"path":"nc.ts"}',
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: 'fn-item-no-created',
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-fn-no-created-1',
            output: [
              {
                type: 'function_call',
                call_id: 'tool-no-created-1',
                name: 'Read',
                arguments: '{"path":"nc.ts"}',
              },
            ],
            usage: {
              input_tokens: 2,
              output_tokens: 2,
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-no-created-1', name: 'Read', input: {} },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":"nc.ts"}' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'assistant',
        requestId: 'resp-fn-no-created-1',
        message: {
          model: 'gpt-5.2',
          content: [
            { type: 'tool_use', id: 'tool-no-created-1', name: 'Read', input: { path: 'nc.ts' } },
          ],
        },
      },
    ])
  })

  it('[P0:model] starts a Claude-style streamed assistant turn on the first output item even if response.created is absent', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item_id: 'msg-item-no-created',
          item: {
            type: 'message',
          },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg-item-no-created',
          delta: 'hello without created',
        },
        {
          type: 'response.output_text.done',
          item_id: 'msg-item-no-created',
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-no-created-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'hello without created' }],
              },
            ],
            usage: {
              input_tokens: 2,
              output_tokens: 2,
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello without created' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'assistant',
        requestId: 'resp-no-created-1',
        message: {
          model: 'gpt-5.2',
          content: [{ type: 'text', text: 'hello without created' }],
        },
      },
    ])
  })

  it('[P0:model] parses chunk-split CRLF SSE frames into the same Claude-style text stream outcome', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeRawSseResponse([
        'event: response.cre',
        'ated\r\ndata: {}\r\n\r\n',
        'event: response.output_item.added\r\n',
        'data: {"output_index":0,"item":{"type":"message"}}\r\n\r\n',
        'event: response.output_text.delta\r\n',
        'data: {"output_index":0,"delta":"split ',
        'chunk"}\r\n\r\n',
        'event: response.output_text.done\r\n',
        'data: {"output_index":0}\r\n\r\n',
        'event: response.completed\r\n',
        'data: {"response":{"id":"resp-split-sse-1","output":[{"type":"message","content":[{"type":"output_text","text":"split chunk"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}\r\n\r\n',
        'data: [DONE]\r\n\r\n',
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'split chunk' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'assistant',
        requestId: 'resp-split-sse-1',
        message: {
          model: 'gpt-5.2',
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          content: [{ type: 'text', text: 'split chunk' }],
        },
      },
    ])
  })

  it('[P0:model] merges multi-line SSE data fields before parsing stream events and completed payloads', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeRawSseResponse([
        'event: response.created\n',
        'data: {}\n\n',
        'event: response.output_item.added\n',
        'data: {"output_index":0,\n',
        'data: "item":{"type":"message"}}\n\n',
        'event: response.output_text.delta\n',
        'data: {"output_index":0,\n',
        'data: "delta":"multi-line data"}\n\n',
        'event: response.output_text.done\n',
        'data: {"output_index":0}\n\n',
        'event: response.completed\n',
        'data: {"response":{"id":"resp-multiline-sse-1",\n',
        'data: "output":[{"type":"message","content":[{"type":"output_text","text":"multi-line data"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'multi-line data' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'assistant',
        requestId: 'resp-multiline-sse-1',
        message: {
          model: 'gpt-5.2',
          content: [{ type: 'text', text: 'multi-line data' }],
        },
      },
    ])
  })

  it('[P0:model] ignores unknown streamed output_item.added types while preserving later known text stream items', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item_id: 'unknown-stream-item-1',
          item: { type: 'mystery' } as any,
        },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item_id: 'known-stream-item-1',
          item: { type: 'message' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'known-stream-item-1',
          delta: 'known after unknown',
        },
        {
          type: 'response.output_text.done',
          item_id: 'known-stream-item-1',
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-unknown-stream-item-1',
            output: [
              { type: 'mystery' } as any,
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'known after unknown' }],
              },
            ],
            usage: {
              input_tokens: 2,
              output_tokens: 2,
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(
      outputs.filter(
        output =>
          output.type === 'stream_event' && output.event.type === 'content_block_start',
      ),
    ).toMatchObject([
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
      },
    ])
    expect(outputs).toMatchObject([
      {
        type: 'stream_event',
        event: { type: 'message_start' },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'known after unknown' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'assistant',
        requestId: 'resp-unknown-stream-item-1',
        message: {
          model: 'gpt-5.2',
          content: [{ type: 'text', text: 'known after unknown' }],
        },
      },
    ])
  })

  it('[P0:model] ignores in_progress and output_item.done SSE noise while preserving the observable text stream outcome', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        { type: 'response.in_progress', response: { id: 'resp-noise-1' } },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item_id: 'msg-item-noise-1',
          item: { type: 'message' },
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item_id: 'msg-item-noise-1',
          item: { type: 'message' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg-item-noise-1',
          delta: 'noise-safe text',
        },
        {
          type: 'response.output_text.done',
          item_id: 'msg-item-noise-1',
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-noise-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'noise-safe text' }],
              },
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'noise-safe text' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'assistant',
        requestId: 'resp-noise-1',
        message: {
          model: 'gpt-5.2',
          content: [{ type: 'text', text: 'noise-safe text' }],
        },
      },
    ])
  })

  it('[P0:model] uses output_index fallback for streamed text deltas when item_id is absent from later SSE events', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.output_item.added',
          output_index: 3,
          item: { type: 'message' },
        },
        {
          type: 'response.output_text.delta',
          output_index: 3,
          delta: 'index text only',
        },
        {
          type: 'response.output_text.done',
          output_index: 3,
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-text-index-fallback-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'index text only' }],
              },
            ],
            usage: {
              input_tokens: 2,
              output_tokens: 2,
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      {
        type: 'stream_event',
        event: { type: 'message_start' },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 3,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 3,
          delta: { type: 'text_delta', text: 'index text only' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'assistant',
        requestId: 'resp-text-index-fallback-1',
        message: {
          model: 'gpt-5.2',
          content: [{ type: 'text', text: 'index text only' }],
        },
      },
    ])
  })

  it('[P0:model] uses output_index fallback for streamed tool-call deltas when item_id is absent from later SSE events', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.output_item.added',
          output_index: 4,
          item: {
            type: 'function_call',
            call_id: 'tool-index-fallback-1',
            name: 'Read',
            arguments: '',
          },
        },
        {
          type: 'response.function_call_arguments.delta',
          output_index: 4,
          delta: '{"path":"index-only.ts"}',
        },
        {
          type: 'response.function_call_arguments.done',
          output_index: 4,
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-index-fallback-1',
            output: [
              {
                type: 'function_call',
                call_id: 'tool-index-fallback-1',
                name: 'Read',
                arguments: '{"path":"index-only.ts"}',
              },
            ],
            usage: {
              input_tokens: 2,
              output_tokens: 2,
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      {
        type: 'stream_event',
        event: { type: 'message_start' },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 4,
          content_block: { type: 'tool_use', id: 'tool-index-fallback-1', name: 'Read', input: {} },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 4,
          delta: { type: 'input_json_delta', partial_json: '{"path":"index-only.ts"}' },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 4 },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'assistant',
        requestId: 'resp-index-fallback-1',
        message: {
          model: 'gpt-5.2',
          content: [
            {
              type: 'tool_use',
              id: 'tool-index-fallback-1',
              name: 'Read',
              input: { path: 'index-only.ts' },
            },
          ],
        },
      },
    ])
  })

  it('[P0:model] converts streamed text and tool-call SSE events into Claude-style stream events before final assistant messages', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item_id: 'msg-item-1',
          item: {
            type: 'message',
          },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg-item-1',
          delta: 'hello ',
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg-item-1',
          delta: 'world',
        },
        {
          type: 'response.output_text.done',
          item_id: 'msg-item-1',
        },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item_id: 'fn-item-1',
          item: {
            type: 'function_call',
            call_id: 'tool-11',
            name: 'Read',
            arguments: '',
          },
        },
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'fn-item-1',
          delta: '{"path":"c',
        },
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'fn-item-1',
          delta: '.ts"}',
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: 'fn-item-1',
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-stream-1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'hello world' }],
              },
              {
                type: 'function_call',
                call_id: 'tool-11',
                name: 'Read',
                arguments: '{"path":"c.ts"}',
              },
            ],
            usage: {
              input_tokens: 4,
              output_tokens: 6,
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs.slice(0, 7)).toEqual([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello ' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'world' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tool-11', name: 'Read', input: {} },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"path":"c' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '.ts"}' },
        },
      },
    ])
    expect(outputs[7]).toEqual({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 1 },
    })
    expect(outputs[8]).toEqual({
      type: 'stream_event',
      event: { type: 'message_stop' },
    })
    expect(outputs.slice(9)).toMatchObject([
      {
        type: 'assistant',
        requestId: 'resp-stream-1',
        message: {
          model: 'gpt-5.2',
          content: [{ type: 'text', text: 'hello world' }],
        },
      },
      {
        type: 'assistant',
        requestId: 'resp-stream-1',
        message: {
          model: 'gpt-5.2',
          content: [
            {
              type: 'tool_use',
              id: 'tool-11',
              name: 'Read',
              input: { path: 'c.ts' },
            },
          ],
        },
      },
    ])
  })

  it('[P0:model] prefers real completed output items over response.error metadata when assistant output is present', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-output-over-error-1',
            error: { message: 'should not replace real output' },
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'real assistant output' }],
              },
            ],
            usage: {
              input_tokens: 2,
              output_tokens: 1,
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'message_stop' } },
      {
        type: 'assistant',
        requestId: 'resp-output-over-error-1',
        message: {
          model: 'gpt-5.2',
          content: [{ type: 'text', text: 'real assistant output' }],
        },
      },
    ])
    expect(outputs.some(output => (output as any).isApiErrorMessage)).toBe(false)
  })

  it('[P0:model] ignores unknown completed response output item types while preserving later known message and tool_use outputs', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-unknown-output-1',
            output: [
              { type: 'mystery' } as any,
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'after unknown' }],
              },
              {
                type: 'function_call',
                call_id: 'tool-after-unknown-1',
                name: 'Read',
                arguments: '{"path":"after.ts"}',
              },
            ],
            usage: {
              input_tokens: 3,
              output_tokens: 2,
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'message_stop' } },
      {
        type: 'assistant',
        requestId: 'resp-unknown-output-1',
        message: {
          model: 'gpt-5.2',
          content: [{ type: 'text', text: 'after unknown' }],
        },
      },
      {
        type: 'assistant',
        requestId: 'resp-unknown-output-1',
        message: {
          model: 'gpt-5.2',
          content: [
            {
              type: 'tool_use',
              id: 'tool-after-unknown-1',
              name: 'Read',
              input: { path: 'after.ts' },
            },
          ],
        },
      },
    ])
  })

  it('[P0:model] skips empty message output items but still returns tool_use assistant messages from the same completed response', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-mixed-empty-1',
            output: [
              { type: 'message', content: [] },
              {
                type: 'function_call',
                call_id: 'tool-mixed-empty-1',
                name: 'Read',
                arguments: '{"path":"mixed.ts"}',
              },
            ],
            usage: {
              input_tokens: 3,
              output_tokens: 1,
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'message_stop' } },
      {
        type: 'assistant',
        requestId: 'resp-mixed-empty-1',
        message: {
          model: 'gpt-5.2',
          content: [
            {
              type: 'tool_use',
              id: 'tool-mixed-empty-1',
              name: 'Read',
              input: { path: 'mixed.ts' },
            },
          ],
        },
      },
    ])
  })

  it('[P0:model] preserves raw function-call arguments on invalid JSON and reports empty completed responses as assistant API errors', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-invalid-1',
            output: [
              {
                type: 'function_call',
                call_id: 'tool-bad-1',
                name: 'Read',
                arguments: '{not-json',
              },
            ],
            usage: {
              input_tokens: 3,
              output_tokens: 1,
            },
          },
        },
      ]),
    )
    const invalidArgs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )
    expect(invalidArgs.at(-1)).toMatchObject({
      type: 'assistant',
      requestId: 'resp-invalid-1',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-bad-1',
            name: 'Read',
            input: { raw_arguments: '{not-json' },
          },
        ],
      },
    })

    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-empty-1',
            output: [],
            usage: {
              input_tokens: 1,
              output_tokens: 0,
            },
          },
        },
      ]),
    )
    const empty = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )
    expect(empty).toEqual([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          model: 'uninitialized',
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: 'text', text: 'OpenAI Responses returned no assistant output.' }],
        },
      },
    ])
  })

  it('[P0:model] prefers response.error.message over the generic empty-output fallback when completion finishes without assistant output items', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.completed',
          response: {
            id: 'resp-empty-error-1',
            output: [],
            error: { message: 'response finished empty after moderation' },
            usage: {
              input_tokens: 1,
              output_tokens: 0,
            },
          },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toEqual([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          model: 'uninitialized',
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [
            {
              type: 'text',
              text: 'response finished empty after moderation',
            },
          ],
        },
      },
    ])
  })

  it('[P0:model] reports a stable assistant API error when the SSE stream ends without a completed payload', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item_id: 'msg-item-2',
          item: { type: 'message' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg-item-2',
          delta: 'partial output',
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toEqual([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial output' },
        },
      },
      {
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          model: 'uninitialized',
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [
            {
              type: 'text',
              text:
                'OpenAI Responses stream finished without a completed response payload.',
            },
          ],
        },
      },
    ])
  })

  it('[P0:model] parses a trailing completed SSE event even when the stream ends without a final blank-line separator', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeRawSseResponse([
        'event: response.created\n',
        'data: {}\n\n',
        'event: response.completed\n',
        'data: {"response":{"id":"resp-trailing-buffer-1","output":[{"type":"message","content":[{"type":"output_text","text":"trailing buffer"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}',
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      {
        type: 'stream_event',
        event: { type: 'message_start' },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'assistant',
        requestId: 'resp-trailing-buffer-1',
        message: {
          model: 'gpt-5.2',
          content: [{ type: 'text', text: 'trailing buffer' }],
        },
      },
    ])
  })

  it('[P0:model] honors SSE event names when the JSON payload omits type, matching real parser fallback behavior', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeRawSseResponse([
        'event: response.created\n',
        'data: {}\n\n',
        'event: response.completed\n',
        'data: {"response":{"id":"resp-event-name-1","output":[{"type":"message","content":[{"type":"output_text","text":"named-event"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toMatchObject([
      {
        type: 'stream_event',
        event: { type: 'message_start' },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'assistant',
        requestId: 'resp-event-name-1',
        message: {
          model: 'gpt-5.2',
          content: [{ type: 'text', text: 'named-event' }],
        },
      },
    ])
  })

  it('[P0:model] preserves already-emitted tool-call stream events and then surfaces failure without fabricating block or message stop events', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item_id: 'fn-item-failed-1',
          item: {
            type: 'function_call',
            call_id: 'tool-failed-1',
            name: 'Read',
            arguments: '',
          },
        },
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'fn-item-failed-1',
          delta: '{"path":"broken.ts"}',
        },
        {
          type: 'response.failed',
          response: { error: { message: 'tool stream failed' } },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toEqual([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-failed-1', name: 'Read', input: {} },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":"broken.ts"}' },
        },
      },
      {
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          model: 'uninitialized',
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: 'text', text: 'tool stream failed' }],
        },
      },
    ])
  })

  it('[P0:model] preserves already-emitted stream events and then surfaces incomplete as an assistant API error without fabricating message_stop', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        { type: 'response.created' },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item_id: 'msg-item-incomplete-1',
          item: { type: 'message' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg-item-incomplete-1',
          delta: 'partial before incomplete',
        },
        {
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'content_filter' } },
        },
      ]),
    )

    const outputs = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )

    expect(outputs).toEqual([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 0, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial before incomplete' },
        },
      },
      {
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          model: 'uninitialized',
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: 'text', text: 'content_filter' }],
        },
      },
    ])
  })

  it('[P0:model] surfaces streaming failure and incomplete events as assistant API errors', async () => {
    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        {
          type: 'response.failed',
          response: { error: { message: 'backend exploded' } },
        },
      ]),
    )
    const failed = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )
    expect(failed).toEqual([
      {
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          model: 'uninitialized',
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: 'text', text: 'backend exploded' }],
        },
      },
    ])

    fetchOpenAIResponseMock.mockResolvedValue(
      makeSseResponse([
        {
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'max_output_tokens' } },
        },
      ]),
    )
    const incomplete = await collect(
      runOpenAIResponses({
        messages: [],
        systemPrompt: ['system'],
        tools: [],
        options: { model: 'sonnet' },
        signal: new AbortController().signal,
      } as any),
    )
    expect(incomplete).toEqual([
      {
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          model: 'uninitialized',
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: 'text', text: 'max_output_tokens' }],
        },
      },
    ])
  })
})
