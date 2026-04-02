import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { runOpenAIResponses } from './openaiResponsesBackend.js'

const originalFetch = global.fetch
const originalApiKey = process.env.OPENAI_API_KEY

function makeSseEvent(payload: Record<string, unknown>): string {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`
}

function makeSseResponse(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map(makeSseEvent).join(''), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
    },
  })
}

async function collectResponsesStream(
  events: Array<Record<string, unknown>>,
) {
  process.env.OPENAI_API_KEY = 'test-key'
  global.fetch = async () => makeSseResponse(events)

  const stream = runOpenAIResponses({
    messages: [createUserMessage({ content: 'hi' })],
    systemPrompt: asSystemPrompt(['system']),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      model: 'gpt-5',
      isNonInteractiveSession: false,
      querySource: 'repl_main_thread' as never,
      agents: [],
      hasAppendSystemPrompt: false,
      mcpTools: [],
    },
  })

  const emitted: unknown[] = []
  for await (const entry of stream) {
    emitted.push(entry)
  }
  return emitted
}

function getStreamedText(entries: unknown[]): string {
  return entries
    .filter(
      (entry): entry is {
        type: 'stream_event'
        event: {
          type: 'content_block_delta'
          delta?: { type?: string; text?: string }
        }
      } =>
        typeof entry === 'object' &&
        entry !== null &&
        'type' in entry &&
        entry.type === 'stream_event' &&
        typeof entry.event === 'object' &&
        entry.event !== null &&
        'type' in entry.event &&
        entry.event.type === 'content_block_delta' &&
        typeof entry.event.delta === 'object' &&
        entry.event.delta !== null &&
        entry.event.delta.type === 'text_delta',
    )
    .map(entry => entry.event.delta?.text ?? '')
    .join('')
}

function getAssistantTexts(entries: unknown[]): string[] {
  return entries
    .filter(
      (entry): entry is {
        type: 'assistant'
        message: { content: Array<{ type: string; text?: string }> }
      } =>
        typeof entry === 'object' &&
        entry !== null &&
        'type' in entry &&
        entry.type === 'assistant',
    )
    .flatMap(entry =>
      entry.message.content
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text as string),
    )
}

function getAssistantMessageIds(entries: unknown[]): string[] {
  return entries
    .filter(
      (entry): entry is {
        type: 'assistant'
        message: { id?: string }
      } =>
        typeof entry === 'object' &&
        entry !== null &&
        'type' in entry &&
        entry.type === 'assistant',
    )
    .map(entry => entry.message.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key'
})

afterEach(() => {
  global.fetch = originalFetch
  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY
  } else {
    process.env.OPENAI_API_KEY = originalApiKey
  }
})

describe('runOpenAIResponses', () => {
  test('streams custom tool call input as a display-only text block', async () => {
    const entries = await collectResponsesStream([
      { type: 'response.created' },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item_id: 'ct_item',
        item: {
          type: 'custom_tool_call',
          id: 'ct_item',
          name: 'delegate',
          call_id: 'ct_1',
          status: 'in_progress',
        },
      },
      {
        type: 'response.custom_tool_call_input.delta',
        output_index: 0,
        item_id: 'ct_item',
        delta: 'hello ',
      },
      {
        type: 'response.custom_tool_call_input.delta',
        output_index: 0,
        item_id: 'ct_item',
        delta: 'world',
      },
      {
        type: 'response.custom_tool_call_input.done',
        output_index: 0,
        item_id: 'ct_item',
        input: 'hello world',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'custom_tool_call',
          id: 'ct_item',
          name: 'delegate',
          call_id: 'ct_1',
          status: 'completed',
          input: 'hello world',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          output: [
            {
              type: 'custom_tool_call',
              id: 'ct_item',
              name: 'delegate',
              call_id: 'ct_1',
              status: 'completed',
              input: 'hello world',
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        },
      },
    ])

    const streamedText = getStreamedText(entries)
    expect(streamedText).toContain('[OpenAI native item: custom_tool_call]')
    expect(streamedText).toContain('name: delegate')
    expect(streamedText).toContain('input:\nhello world')
    expect(streamedText.match(/hello world/g)?.length).toBe(1)

    expect(getAssistantTexts(entries).join('\n')).toContain(
      '[OpenAI native item: custom_tool_call]',
    )
  })

  test('emits a real-time summary when a native built-in item completes', async () => {
    const entries = await collectResponsesStream([
      { type: 'response.created' },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item_id: 'ws_item',
        item: {
          type: 'web_search_call',
          id: 'ws_item',
          status: 'completed',
          action: {
            type: 'search',
            query: 'responses api stream events',
            sources: [{ title: 'Docs' }],
          },
        },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'web_search_call',
          id: 'ws_item',
          status: 'completed',
          action: {
            type: 'search',
            query: 'responses api stream events',
            sources: [{ title: 'Docs' }],
          },
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_2',
          output: [
            {
              type: 'web_search_call',
              id: 'ws_item',
              status: 'completed',
              action: {
                type: 'search',
                query: 'responses api stream events',
                sources: [{ title: 'Docs' }],
              },
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        },
      },
    ])

    const streamedText = getStreamedText(entries)
    expect(streamedText).toContain('[OpenAI native item: web_search_call]')
    expect(streamedText).toContain('action: search')
    expect(streamedText).toContain('query: responses api stream events')

    expect(getAssistantTexts(entries).join('\n')).toContain(
      '[OpenAI native item: web_search_call]',
    )
  })

  test('resolves native output_item.done blocks via item_id when output_index is missing', async () => {
    const entries = await collectResponsesStream([
      { type: 'response.created' },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item_id: 'msg_0',
        item: {
          type: 'message',
          id: 'msg_0',
          role: 'assistant',
        },
      },
      {
        type: 'response.content_part.added',
        output_index: 0,
        item_id: 'msg_0',
        content_index: 0,
        part: {
          type: 'output_text',
          text: '',
        },
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        item_id: 'msg_0',
        content_index: 0,
        delta: 'Primary text.',
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item_id: 'ws_item',
        item: {
          type: 'web_search_call',
          id: 'ws_item',
          status: 'completed',
          action: {
            type: 'search',
            query: 'adapter fit',
            sources: [{ title: 'Docs' }],
          },
        },
      },
      {
        type: 'response.output_item.done',
        item_id: 'ws_item',
        item: {
          type: 'web_search_call',
          id: 'ws_item',
          status: 'completed',
          action: {
            type: 'search',
            query: 'adapter fit',
            sources: [{ title: 'Docs' }],
          },
        },
      },
      {
        type: 'response.output_item.done',
        item_id: 'msg_0',
        item: {
          type: 'message',
          id: 'msg_0',
          role: 'assistant',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_item_id_done',
          output: [
            {
              type: 'message',
              id: 'msg_0',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Primary text.' }],
            },
            {
              type: 'web_search_call',
              id: 'ws_item',
              status: 'completed',
              action: {
                type: 'search',
                query: 'adapter fit',
                sources: [{ title: 'Docs' }],
              },
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        },
      },
    ])

    const streamedText = getStreamedText(entries)
    expect(streamedText).toContain('Primary text.')
    expect(streamedText).toContain('[OpenAI native item: web_search_call]')
    expect(streamedText).toContain('query: adapter fit')
  })

  test('streams output audio transcripts into text deltas', async () => {
    const entries = await collectResponsesStream([
      { type: 'response.created' },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item_id: 'msg_audio',
        item: {
          type: 'message',
          id: 'msg_audio',
          role: 'assistant',
        },
      },
      {
        type: 'response.content_part.added',
        output_index: 0,
        item_id: 'msg_audio',
        content_index: 0,
        part: {
          type: 'output_audio',
        },
      },
      {
        type: 'response.output_audio_transcript.delta',
        output_index: 0,
        item_id: 'msg_audio',
        content_index: 0,
        delta: 'Hello from audio',
      },
      {
        type: 'response.output_audio_transcript.done',
        output_index: 0,
        item_id: 'msg_audio',
        content_index: 0,
        transcript: 'Hello from audio',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_audio',
          role: 'assistant',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_audio',
          output: [
            {
              type: 'message',
              id: 'msg_audio',
              role: 'assistant',
              content: [
                {
                  type: 'output_audio',
                  transcript: 'Hello from audio',
                },
              ],
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        },
      },
    ])

    expect(getStreamedText(entries)).toContain('Hello from audio')
    expect(getAssistantTexts(entries).join('\n')).toContain('Hello from audio')
  })

  test('streams transcript text from output_audio_transcript.done when no deltas arrived', async () => {
    const entries = await collectResponsesStream([
      { type: 'response.created' },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item_id: 'msg_audio_done',
        item: {
          type: 'message',
          id: 'msg_audio_done',
          role: 'assistant',
        },
      },
      {
        type: 'response.content_part.added',
        output_index: 0,
        item_id: 'msg_audio_done',
        content_index: 0,
        part: {
          type: 'output_audio',
        },
      },
      {
        type: 'response.output_audio_transcript.done',
        output_index: 0,
        item_id: 'msg_audio_done',
        content_index: 0,
        transcript: 'Transcript delivered on done.',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_audio_done',
          role: 'assistant',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_audio_done',
          output: [
            {
              type: 'message',
              id: 'msg_audio_done',
              role: 'assistant',
              content: [
                {
                  type: 'output_audio',
                  transcript: 'Transcript delivered on done.',
                },
              ],
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        },
      },
    ])

    expect(getStreamedText(entries)).toContain('Transcript delivered on done.')
    expect(getAssistantTexts(entries).join('\n')).toContain(
      'Transcript delivered on done.',
    )
  })

  test('groups assistant items from one completed response under a shared message id', async () => {
    const entries = await collectResponsesStream([
      { type: 'response.created' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_grouped',
          output: [
            {
              type: 'message',
              id: 'msg_grouped',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Grouped text.' }],
            },
            {
              type: 'function_call',
              id: 'fn_item_2',
              call_id: 'call_2',
              name: 'Read',
              arguments: '{"file_path":"README.md"}',
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        },
      },
    ])

    expect(getAssistantTexts(entries)).toContain('Grouped text.')
    expect(getAssistantMessageIds(entries)).toEqual([
      'msg_grouped',
      'msg_grouped',
    ])
  })

  test('summarizes image generation calls without streaming image payloads', async () => {
    const entries = await collectResponsesStream([
      { type: 'response.created' },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item_id: 'ig_item',
        item: {
          type: 'image_generation_call',
          id: 'ig_item',
          status: 'in_progress',
        },
      },
      {
        type: 'response.image_generation_call.in_progress',
        output_index: 0,
        item_id: 'ig_item',
      },
      {
        type: 'response.image_generation_call.partial_image',
        output_index: 0,
        item_id: 'ig_item',
        partial_image_index: 0,
        partial_image_b64: 'QUJDREVGR0g=',
      },
      {
        type: 'response.image_generation_call.completed',
        output_index: 0,
        item_id: 'ig_item',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'image_generation_call',
          id: 'ig_item',
          status: 'completed',
          revised_prompt: 'A warm illustration of a cat hugging an otter.',
          result: 'QUJDREVGR0g=',
          partial_image_count: 1,
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_image',
          output: [
            {
              type: 'image_generation_call',
              id: 'ig_item',
              status: 'completed',
              revised_prompt: 'A warm illustration of a cat hugging an otter.',
              result: 'QUJDREVGR0g=',
              partial_image_count: 1,
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        },
      },
    ])

    const streamedText = getStreamedText(entries)
    expect(streamedText).toContain('[OpenAI native item: image_generation_call]')
    expect(streamedText).toContain('status: completed')
    expect(streamedText).toContain('partial_images: 1')
    expect(streamedText).toContain('result_bytes: 12')
    expect(streamedText).not.toContain('QUJDREVGR0g=')

    const assistantText = getAssistantTexts(entries).join('\n')
    expect(assistantText).toContain('[OpenAI native item: image_generation_call]')
    expect(assistantText).toContain('revised_prompt:')
    expect(assistantText).toContain('result_bytes: 12')
    expect(assistantText).not.toContain('QUJDREVGR0g=')
  })
})
