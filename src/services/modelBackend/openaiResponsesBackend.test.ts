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
})
