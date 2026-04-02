import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { getSessionId } from '../../bootstrap/state.js'
import { createAssistantAPIErrorMessage, createAssistantMessage, getContentText } from '../../utils/messages.js'
import { logForDebugging } from '../../utils/debug.js'
import { validateBoundedIntEnvVar } from '../../utils/envValidation.js'
import {
  getStrictJsonSchemaIncompatibility,
  getToolInputJsonSchema,
  normalizeJsonSchema,
} from '../../utils/jsonSchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { convertEffortValueToLevel, resolveAppliedEffort } from '../../utils/effort.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { getEmptyToolPermissionContext, type Tool, type Tools } from '../../Tool.js'
import type { ModelBackend, ModelBackendStream, StreamTurnParams } from './types.js'
import {
  resolveOpenAIModel,
  resolveOpenAIPromptCacheRetention,
  shouldStoreOpenAIResponses,
} from './openaiCodexConfig.js'
import { fetchOpenAIResponse } from './openaiApi.js'
import type {
  OpenAIResponse,
  OpenAIResponseFunctionCall,
  OpenAIResponseOutputItem,
  OpenAIResponsesStreamEvent,
} from './openaiResponsesTypes.js'

type OpenAIInputItem =
  | {
      role: 'user' | 'assistant'
      content: Array<{ type: 'input_text' | 'output_text'; text: string }>
    }
  | {
      type: 'function_call'
      call_id: string
      name: string
      arguments: string
    }
  | {
      type: 'function_call_output'
      call_id: string
      output: string
    }

type StreamEventMessage = Extract<Message, { type: 'stream_event' }>

function buildResponsesUrl(): string {
  return '/responses'
}

const loggedStrictSchemaDowngrades = new Set<string>()

function maybeLogStrictSchemaDowngrade(name: string, reason: string): void {
  const key = `${name}:${reason}`
  if (loggedStrictSchemaDowngrades.has(key)) {
    return
  }
  loggedStrictSchemaDowngrades.add(key)
  // Log once per schema failure so we can track why strict mode is absent
  // without flooding debug output on every turn.
  logForDebugging(
    `[openaiResponses] strict mode disabled for ${name}: ${reason}`,
  )
}

function mapToolToOpenAIFunction(
  tool: Tool,
): Promise<{
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: true
}> {
  return Promise.resolve().then(async () => {
    const parameters = getToolInputJsonSchema(tool)
    const strictCompatibilityError =
      tool.strict === true
        ? getStrictJsonSchemaIncompatibility(parameters)
        : undefined
    if (strictCompatibilityError) {
      maybeLogStrictSchemaDowngrade(tool.name, strictCompatibilityError)
    }

    return {
      type: 'function',
      name: tool.name,
      description: await tool.prompt({
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        tools: [] as unknown as Tools,
        agents: [],
      }),
      parameters,
      ...(tool.strict === true && !strictCompatibilityError
        ? { strict: true as const }
        : {}),
    }
  })
}

function extractToolResultOutput(message: UserMessage): OpenAIInputItem[] {
  if (!Array.isArray(message.message.content)) return []

  const outputs: OpenAIInputItem[] = []
  for (const block of message.message.content) {
    if (block.type !== 'tool_result') continue

    const output =
      typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? getContentText(block.content as ContentBlockParam[]) ||
            jsonStringify(block.content)
          : jsonStringify(block.content)

    outputs.push({
      type: 'function_call_output',
      call_id: block.tool_use_id,
      output,
    })
  }

  return outputs
}

function translateMessageToInput(message: Message): OpenAIInputItem[] {
  switch (message.type) {
    case 'user': {
      const toolOutputs = extractToolResultOutput(message)
      if (toolOutputs.length > 0) return toolOutputs

      const text = getContentText(message.message.content)
      if (!text) return []
      return [
        {
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      ]
    }
    case 'assistant': {
      if (!Array.isArray(message.message.content)) {
        const text = getContentText(message.message.content as ContentBlockParam[])
        if (!text) return []
        return [
          {
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          },
        ]
      }

      const inputs: OpenAIInputItem[] = []
      const text = getContentText(message.message.content as ContentBlockParam[])
      if (text) {
        inputs.push({
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        })
      }

      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue
        inputs.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: jsonStringify(block.input || {}),
        })
      }

      return inputs
    }
    default:
      return []
  }
}

function buildInput(messages: Message[]): {
  input: OpenAIInputItem[]
} {
  return {
    input: messages.flatMap(translateMessageToInput),
  }
}

function mapUsage(usage: OpenAIResponse['usage']) {
  if (!usage) return undefined
  const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0
  const totalInputTokens = usage.input_tokens ?? 0

  return {
    input_tokens: Math.max(0, totalInputTokens - cachedTokens),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cachedTokens,
    output_tokens: usage.output_tokens ?? 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: null,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: null,
    iterations: null,
    speed: null,
  }
}

function getPromptCacheKey(): string {
  return getSessionId()
}

function getSharedAssistantMessageId(response: OpenAIResponse): string {
  // Parallel tool calls from one response should stay grouped under a single
  // assistant turn, matching the native streaming transcript shape.
  const outputMessageId = response.output?.find(
    (item): item is OpenAIResponseOutputItem & { id: string } =>
      typeof item.id === 'string' && item.id.trim().length > 0,
  )?.id
  return outputMessageId ?? response.id
}

function createAssistantMessagesFromResponse(
  response: OpenAIResponse,
  model: string,
): AssistantMessage[] {
  const messages: AssistantMessage[] = []
  const sharedMessageId = getSharedAssistantMessageId(response)

  for (const item of response.output || []) {
    if (item.type === 'message') {
      const text = (item.content || [])
        .filter(
          (part): part is { type: 'output_text'; text: string } =>
            part.type === 'output_text' && typeof part.text === 'string',
        )
        .map(part => part.text)
        .join('')
        .trim()

      if (!text) continue
      const message = createAssistantMessage({
        content: text,
        usage: mapUsage(response.usage) as never,
      }) as AssistantMessage
      message.requestId = response.id
      message.message.model = model
      message.message.id = sharedMessageId
      messages.push(message)
      continue
    }

    if (item.type === 'function_call') {
      const functionCall = item as OpenAIResponseFunctionCall
      let input: unknown = {}
      try {
        input = JSON.parse(functionCall.arguments || '{}')
      } catch {
        input = { raw_arguments: functionCall.arguments || '' }
      }

      const message = createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id: functionCall.call_id,
            name: functionCall.name,
            input,
          } as never,
        ],
        usage: mapUsage(response.usage) as never,
      }) as AssistantMessage
      message.requestId = response.id
      message.message.model = model
      message.message.id = sharedMessageId
      messages.push(message)
    }
  }

  return messages
}

async function createResponsesRequest(params: StreamTurnParams): Promise<{
  url: string
  request: Record<string, unknown>
  model: string
}> {
  const model = resolveOpenAIModel(params.options.model)
  const { input } = buildInput(params.messages)
  const effort = resolveAppliedEffort(model, params.options.effortValue)
  const promptCacheRetention = resolveOpenAIPromptCacheRetention()
  const serializedTools = await Promise.all(
    params.tools.map(tool => mapToolToOpenAIFunction(tool)),
  )

  const request: Record<string, unknown> = {
    model,
    instructions: params.systemPrompt.join('\n'),
    input,
    store: shouldStoreOpenAIResponses(),
    // Keep repeated turns in the same session sticky to the same cache shard.
    prompt_cache_key: getPromptCacheKey(),
  }

  if (serializedTools.length > 0) {
    request.tools = serializedTools
    if (params.options.toolChoice?.type === 'tool') {
      request.tool_choice = {
        type: 'function',
        name: params.options.toolChoice.name,
      }
    } else {
      request.tool_choice = 'auto'
    }
    request.parallel_tool_calls = true
  }

  if (params.options.outputFormat) {
    const outputSchema = normalizeJsonSchema(
      params.options.outputFormat.schema as Record<string, unknown>,
    )
    const strictCompatibilityError =
      getStrictJsonSchemaIncompatibility(outputSchema)
    if (strictCompatibilityError) {
      maybeLogStrictSchemaDowngrade(
        'claude_code_output_schema',
        strictCompatibilityError,
      )
    }
    request.text = {
      format: {
        type: 'json_schema',
        name: 'claude_code_output_schema',
        ...(strictCompatibilityError ? {} : { strict: true }),
        schema: outputSchema,
      },
    }
  }

  if (promptCacheRetention) {
    request.prompt_cache_retention = promptCacheRetention
  }

  if (params.options.maxOutputTokensOverride) {
    request.max_output_tokens = params.options.maxOutputTokensOverride
  }
  if (effort !== undefined) {
    request.reasoning = {
      effort: convertEffortValueToLevel(effort),
    }
  }

  logForDebugging(
    `[openaiResponses] request ${jsonStringify({
      url: buildResponsesUrl(),
      model,
      inputCount: input.length,
      toolCount: serializedTools.length,
      instructionChars: params.systemPrompt.join('\n').length,
      promptCacheRetention,
      hasReasoning: effort !== undefined,
      hasMaxOutputTokensOverride:
        params.options.maxOutputTokensOverride !== undefined,
    })}`,
  )

  return {
    url: buildResponsesUrl(),
    request,
    model,
  }
}

function createStreamEventMessage(
  event: StreamEventMessage['event'],
): StreamEventMessage {
  return {
    type: 'stream_event',
    event,
  } as StreamEventMessage
}

function createMessageStartStreamEvent(): StreamEventMessage {
  return createStreamEventMessage({
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  } as StreamEventMessage['event'])
}

function createMessageStopStreamEvent(): StreamEventMessage {
  return createStreamEventMessage({
    type: 'message_stop',
  } as StreamEventMessage['event'])
}

function createTextBlockStartStreamEvent(index: number): StreamEventMessage {
  return createStreamEventMessage({
    type: 'content_block_start',
    index,
    content_block: {
      type: 'text',
      text: '',
    },
  } as StreamEventMessage['event'])
}

function createTextDeltaStreamEvent(
  index: number,
  text: string,
): StreamEventMessage {
  return createStreamEventMessage({
    type: 'content_block_delta',
    index,
    delta: {
      type: 'text_delta',
      text,
    },
  } as StreamEventMessage['event'])
}

function createToolUseStartStreamEvent(
  index: number,
  item: OpenAIResponseFunctionCall,
): StreamEventMessage {
  return createStreamEventMessage({
    type: 'content_block_start',
    index,
    content_block: {
      type: 'tool_use',
      id: item.call_id,
      name: item.name,
      input: {},
    },
  } as StreamEventMessage['event'])
}

function createToolUseDeltaStreamEvent(
  index: number,
  partialJson: string,
): StreamEventMessage {
  return createStreamEventMessage({
    type: 'content_block_delta',
    index,
    delta: {
      type: 'input_json_delta',
      partial_json: partialJson,
    },
  } as StreamEventMessage['event'])
}

function createBlockStopStreamEvent(index: number): StreamEventMessage {
  return createStreamEventMessage({
    type: 'content_block_stop',
    index,
  } as StreamEventMessage['event'])
}

function getStreamEventErrorMessage(event: OpenAIResponsesStreamEvent): string {
  if (event.type === 'response.incomplete') {
    return (
      event.response?.incomplete_details?.reason ||
      'OpenAI Responses stream ended before completion.'
    )
  }
  return (
    event.response?.error?.message ||
    'OpenAI Responses returned a failed streaming event.'
  )
}

function parseSseChunk(chunk: string): OpenAIResponsesStreamEvent | null {
  const lines = chunk
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)

  if (lines.length === 0) return null

  let eventName = ''
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
    }
  }

  const data = dataLines.join('\n').trim()
  if (!data || data === '[DONE]') {
    return null
  }

  const parsed = JSON.parse(data) as { type?: string }
  if (!parsed.type && eventName) {
    parsed.type = eventName
  }
  return parsed as OpenAIResponsesStreamEvent
}

async function* parseResponsesStream(
  response: Response,
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('OpenAI Responses stream did not provide a readable body')
  }

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')

    let boundaryIndex = buffer.indexOf('\n\n')
    while (boundaryIndex !== -1) {
      const chunk = buffer.slice(0, boundaryIndex).trim()
      buffer = buffer.slice(boundaryIndex + 2)
      if (chunk) {
        const event = parseSseChunk(chunk)
        if (event) {
          yield event
        }
      }
      boundaryIndex = buffer.indexOf('\n\n')
    }
  }

  const trailing = buffer.trim()
  if (trailing) {
    const event = parseSseChunk(trailing)
    if (event) {
      yield event
    }
  }
}

async function streamResponse(
  url: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  return fetchOpenAIResponse(url, {
    method: 'POST',
    headers: {
      accept: 'text/event-stream',
    },
    body: {
      ...request,
      stream: true,
    },
    signal,
  })
}

export async function* runOpenAIResponses(
  params: StreamTurnParams,
): ModelBackendStream {
  try {
    const { url, request, model } = await createResponsesRequest(params)
    const streamedResponse = await streamResponse(url, request, params.signal)
    const outputIndexes = new Map<string, number>()
    let startedAssistantMessage = false
    let completedResponse: OpenAIResponse | undefined

    for await (const event of parseResponsesStream(streamedResponse)) {
      switch (event.type) {
        case 'response.created': {
          if (!startedAssistantMessage) {
            startedAssistantMessage = true
            yield createMessageStartStreamEvent()
          }
          break
        }
        case 'response.output_item.added': {
          if (!startedAssistantMessage) {
            startedAssistantMessage = true
            yield createMessageStartStreamEvent()
          }

          const index = event.output_index ?? 0
          if (event.item_id) {
            outputIndexes.set(event.item_id, index)
          }

          if (event.item?.type === 'message') {
            yield createTextBlockStartStreamEvent(index)
          } else if (event.item?.type === 'function_call') {
            const functionCall = event.item as OpenAIResponseFunctionCall
            yield createToolUseStartStreamEvent(index, functionCall)
          }
          break
        }
        case 'response.output_text.delta': {
          const text = event.delta || ''
          if (!text) break
          const index =
            event.output_index ??
            (event.item_id ? outputIndexes.get(event.item_id) : undefined) ??
            0
          yield createTextDeltaStreamEvent(index, text)
          break
        }
        case 'response.output_text.done': {
          const index =
            event.output_index ??
            (event.item_id ? outputIndexes.get(event.item_id) : undefined) ??
            0
          yield createBlockStopStreamEvent(index)
          break
        }
        case 'response.function_call_arguments.delta': {
          const partialJson = event.delta || ''
          if (!partialJson) break
          const index =
            event.output_index ??
            (event.item_id ? outputIndexes.get(event.item_id) : undefined) ??
            0
          yield createToolUseDeltaStreamEvent(index, partialJson)
          break
        }
        case 'response.function_call_arguments.done': {
          const index =
            event.output_index ??
            (event.item_id ? outputIndexes.get(event.item_id) : undefined) ??
            0
          yield createBlockStopStreamEvent(index)
          break
        }
        case 'response.failed':
        case 'response.incomplete': {
          yield createAssistantAPIErrorMessage({
            content: getStreamEventErrorMessage(event),
          })
          return
        }
        case 'response.completed': {
          completedResponse = event.response
          yield createMessageStopStreamEvent()
          break
        }
        default:
          break
      }
    }

    if (!completedResponse) {
      throw new Error(
        'OpenAI Responses stream finished without a completed response payload.',
      )
    }

    const assistantMessages = createAssistantMessagesFromResponse(
      completedResponse,
      model,
    )

    if (assistantMessages.length === 0) {
      yield createAssistantAPIErrorMessage({
        content:
          completedResponse.error?.message ||
          'OpenAI Responses returned no assistant output.',
      })
      return
    }

    for (const message of assistantMessages) {
      yield message
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'OpenAI Responses request failed'
    yield createAssistantAPIErrorMessage({ content: message })
  }
}

export const openaiResponsesModelBackend: ModelBackend = {
  id: 'openaiResponses',
  streamTurn(params) {
    return runOpenAIResponses(params)
  },
  getMaxOutputTokens(_model) {
    return validateBoundedIntEnvVar(
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
      32_000,
      64_000,
    ).effective
  },
}
