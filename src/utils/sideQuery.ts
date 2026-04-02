import type Anthropic from '@anthropic-ai/sdk'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages.js'
import {
  getLastApiCompletionTimestamp,
  setLastApiCompletionTimestamp,
} from '../bootstrap/state.js'
import { STRUCTURED_OUTPUTS_BETA_HEADER } from '../constants/betas.js'
import type { QuerySource } from '../constants/querySource.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../constants/system.js'
import { logEvent } from '../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/metadata.js'
import { getAPIMetadata } from '../services/api/claude.js'
import { getAnthropicClient } from '../services/api/client.js'
import {
  isOpenAIResponsesBackendEnabled,
  resolveOpenAIModel,
} from '../services/modelBackend/openaiCodexConfig.js'
import { fetchOpenAIJson } from '../services/modelBackend/openaiApi.js'
import {
  extractOpenAIResponseMessageBlocks,
  extractOpenAIResponseMessageText,
  extractOpenAIResponseReasoningText,
  isOpenAIDisplayOnlyNativeItemType,
  parseOpenAIResponseFunctionArguments,
  summarizeOpenAINativeOutputItem,
} from '../services/modelBackend/openaiResponsesOutput.js'
import { getModelBetas, modelSupportsStructuredOutputs } from './betas.js'
import { computeFingerprint } from './fingerprint.js'
import {
  getStrictJsonSchemaIncompatibility,
  getToolInputJsonSchema,
  normalizeJsonSchema,
} from './jsonSchema.js'
import { logForDebugging } from './debug.js'
import { convertEffortValueToLevel, resolveAppliedEffort } from './effort.js'
import { jsonStringify } from './slowOperations.js'
import { normalizeModelStringForAPI } from './model/model.js'

type MessageParam = Anthropic.MessageParam
type TextBlockParam = Anthropic.TextBlockParam
type Tool = Anthropic.Tool
type ToolChoice = Anthropic.ToolChoice
type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type BetaJSONOutputFormat = Anthropic.Beta.Messages.BetaJSONOutputFormat
type BetaThinkingConfigParam = Anthropic.Beta.Messages.BetaThinkingConfigParam

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

const loggedStrictSchemaDowngrades = new Set<string>()

function maybeLogStrictSchemaDowngrade(name: string, reason: string): void {
  const key = `${name}:${reason}`
  if (loggedStrictSchemaDowngrades.has(key)) {
    return
  }
  loggedStrictSchemaDowngrades.add(key)
  logForDebugging(`[sideQuery] strict mode disabled for ${name}: ${reason}`)
}

export type SideQueryOptions = {
  /** Model to use for the query */
  model: string
  /**
   * System prompt - string or array of text blocks (will be prefixed with CLI attribution).
   *
   * The attribution header is always placed in its own TextBlockParam block to ensure
   * server-side parsing correctly extracts the cc_entrypoint value without including
   * system prompt content.
   */
  system?: string | TextBlockParam[]
  /** Messages to send (supports cache_control on content blocks) */
  messages: MessageParam[]
  /** Optional tools (supports both standard Tool[] and BetaToolUnion[] for custom tool types) */
  tools?: Tool[] | BetaToolUnion[]
  /** Optional tool choice (use { type: 'tool', name: 'x' } for forced output) */
  tool_choice?: ToolChoice
  /** Optional JSON output format for structured responses */
  output_format?: BetaJSONOutputFormat
  /** Max tokens (default: 1024) */
  max_tokens?: number
  /** Max retries (default: 2) */
  maxRetries?: number
  /** Abort signal */
  signal?: AbortSignal
  /** Skip CLI system prompt prefix (keeps attribution header for OAuth). For internal classifiers that provide their own prompt. */
  skipSystemPromptPrefix?: boolean
  /** Temperature override */
  temperature?: number
  /** Thinking budget (enables thinking), or `false` to send `{ type: 'disabled' }`. */
  thinking?: number | false
  /** Stop sequences — generation stops when any of these strings is emitted */
  stop_sequences?: string[]
  /** Attributes this call in tengu_api_success for COGS joining against reporting.sampling_calls. */
  querySource: QuerySource
}

/**
 * Extract text from first user message for fingerprint computation.
 */
function extractFirstUserMessageText(messages: MessageParam[]): string {
  const firstUserMessage = messages.find(m => m.role === 'user')
  if (!firstUserMessage) return ''

  const content = firstUserMessage.content
  if (typeof content === 'string') return content

  // Array of content blocks - find first text block
  const textBlock = content.find(block => block.type === 'text')
  return textBlock?.type === 'text' ? textBlock.text : ''
}

function textBlocksToString(
  content: string | Anthropic.ContentBlockParam[] | Anthropic.ContentBlock[],
): string {
  if (typeof content === 'string') return content
  return content
    .filter(
      block =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'text',
    )
    .map(block => ('text' in block ? block.text : ''))
    .join('')
}

function translateMessagesToResponsesInput(
  messages: MessageParam[],
): OpenAIInputItem[] {
  const input: OpenAIInputItem[] = []

  for (const message of messages) {
    if (typeof message.content === 'string') {
      input.push({
        role: message.role,
        content: [
          {
            type: message.role === 'assistant' ? 'output_text' : 'input_text',
            text: message.content,
          },
        ],
      })
      continue
    }

    const text = textBlocksToString(message.content)
    if (text) {
      input.push({
        role: message.role,
        content: [
          {
            type: message.role === 'assistant' ? 'output_text' : 'input_text',
            text,
          },
        ],
      })
    }

    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: jsonStringify(block.input ?? {}),
        })
      }
    }

    if (message.role === 'user') {
      for (const block of message.content) {
        if (block.type !== 'tool_result') continue
        input.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output:
            typeof block.content === 'string'
              ? block.content
              : jsonStringify(block.content),
        })
      }
    }
  }

  return input
}

function buildOpenAIInstructions(
  system: string | TextBlockParam[] | undefined,
  skipSystemPromptPrefix: boolean | undefined,
): string {
  const blocks: string[] = []
  if (!skipSystemPromptPrefix) {
    blocks.push(
      getCLISyspromptPrefix({
        isNonInteractive: false,
        hasAppendSystemPrompt: false,
      }),
    )
  }
  if (Array.isArray(system)) {
    blocks.push(...system.map(block => block.text))
  } else if (system) {
    blocks.push(system)
  }
  return blocks.join('\n')
}

function mapToolToOpenAIFunction(tool: Tool | BetaToolUnion): Record<string, unknown> {
  const typedTool = tool as Tool & {
    input_schema?: Record<string, unknown>
    strict?: boolean
  }
  const parameters = getToolInputJsonSchema(typedTool)
  const strictCompatibilityError =
    typedTool.strict === true
      ? getStrictJsonSchemaIncompatibility(parameters)
      : undefined
  if (strictCompatibilityError) {
    maybeLogStrictSchemaDowngrade(typedTool.name, strictCompatibilityError)
  }

  return {
    type: 'function',
    name: typedTool.name,
    description: typedTool.description,
    parameters,
    ...(typedTool.strict === true && !strictCompatibilityError
      ? { strict: true }
      : {}),
  }
}

function mapResponsesOutputToBetaMessage(
  response: {
    id: string
    output?: Array<Record<string, unknown>>
    usage?: {
      input_tokens?: number
      output_tokens?: number
      input_tokens_details?: { cached_tokens?: number }
    }
  },
  model: string,
): BetaMessage {
  const content: BetaContentBlock[] = []

  for (const output of response.output ?? []) {
    if (output.type === 'message') {
      const blocks = extractOpenAIResponseMessageBlocks(output)
      if (blocks.length > 0) {
        content.push(...(blocks as unknown as BetaContentBlock[]))
      }
      continue
    }

    if (output.type === 'function_call') {
      const parsedInput = parseOpenAIResponseFunctionArguments(
        output as { arguments: string },
      )
      content.push({
        type: 'tool_use',
        id: String(output.call_id ?? output.id ?? 'tool_use'),
        name: String(output.name ?? 'tool'),
        input: parsedInput,
      } as BetaContentBlock)
      continue
    }

    if (output.type === 'reasoning') {
      const thinking = extractOpenAIResponseReasoningText(output)
      if (thinking) {
        content.push({
          type: 'thinking',
          thinking,
          signature: '',
        } as BetaContentBlock)
      }
      continue
    }

    if (isOpenAIDisplayOnlyNativeItemType(output.type)) {
      const summary = summarizeOpenAINativeOutputItem(
        output as Parameters<typeof summarizeOpenAINativeOutputItem>[0],
      )
      if (summary) {
        content.push({ type: 'text', text: summary } as BetaContentBlock)
      }
    }
  }

  const hasToolUse = content.some(block => block.type === 'tool_use')

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      cache_read_input_tokens:
        response.usage?.input_tokens_details?.cached_tokens ?? 0,
      cache_creation_input_tokens: 0,
    },
  } as BetaMessage
}

/**
 * Lightweight API wrapper for "side queries" outside the main conversation loop.
 *
 * Use this instead of direct client.beta.messages.create() calls to ensure
 * proper OAuth token validation with fingerprint attribution headers.
 *
 * This handles:
 * - Fingerprint computation for OAuth validation
 * - Attribution header injection
 * - CLI system prompt prefix
 * - Proper betas for the model
 * - API metadata
 * - Model string normalization (strips [1m] suffix for API)
 *
 * @example
 * // Permission explainer
 * await sideQuery({ querySource: 'permission_explainer', model, system: SYSTEM_PROMPT, messages, tools, tool_choice })
 *
 * @example
 * // Session search
 * await sideQuery({ querySource: 'session_search', model, system: SEARCH_PROMPT, messages })
 *
 * @example
 * // Model validation
 * await sideQuery({ querySource: 'model_validation', model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
 */
export async function sideQuery(opts: SideQueryOptions): Promise<BetaMessage> {
  const {
    model,
    system,
    messages,
    tools,
    tool_choice,
    output_format,
    max_tokens = 1024,
    maxRetries = 2,
    signal,
    skipSystemPromptPrefix,
    temperature,
    thinking,
    stop_sequences,
  } = opts

  if (isOpenAIResponsesBackendEnabled()) {
    const normalizedModel = resolveOpenAIModel(model)
    const instructions = buildOpenAIInstructions(system, skipSystemPromptPrefix)
    const request: Record<string, unknown> = {
      model: normalizedModel,
      instructions,
      input: translateMessagesToResponsesInput(messages),
      store: false,
      max_output_tokens: max_tokens,
    }

    if (tools?.length) {
      request.tools = tools.map(mapToolToOpenAIFunction)
      if (tool_choice?.type === 'tool') {
        request.tool_choice = {
          type: 'function',
          name: tool_choice.name,
        }
      } else {
        request.tool_choice = 'auto'
      }
      request.parallel_tool_calls = true
    }

    if (output_format) {
      const outputSchema = normalizeJsonSchema(
        output_format.schema as Record<string, unknown>,
      )
      const strictCompatibilityError =
        getStrictJsonSchemaIncompatibility(outputSchema)
      if (strictCompatibilityError) {
        maybeLogStrictSchemaDowngrade(
          'side_query_output',
          strictCompatibilityError,
        )
      }
      request.text = {
        format: {
          type: 'json_schema',
          name: 'side_query_output',
          ...(strictCompatibilityError ? {} : { strict: true }),
          schema: outputSchema,
        },
      }
    }

    if (temperature !== undefined) {
      request.temperature = temperature
    }
    if (thinking !== undefined && thinking !== false) {
      const reasoningEffort = resolveAppliedEffort(normalizedModel, undefined)
      request.reasoning = {
        effort: convertEffortValueToLevel(reasoningEffort ?? 'medium'),
      }
    }
    if (stop_sequences) {
      request.stop = stop_sequences
    }

    const start = Date.now()
    const payload = await fetchOpenAIJson<{
      id: string
      output?: Array<Record<string, unknown>>
      usage?: {
        input_tokens?: number
        output_tokens?: number
        input_tokens_details?: { cached_tokens?: number }
      }
    }>('/responses', {
      method: 'POST',
      body: request,
      signal,
    })
    const result = mapResponsesOutputToBetaMessage(payload, normalizedModel)

    const requestId = payload.id
    const now = Date.now()
    const lastCompletion = getLastApiCompletionTimestamp()
    logEvent('tengu_api_success', {
      requestId:
        requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      querySource:
        opts.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      model:
        normalizedModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
      cachedInputTokens: payload.usage?.input_tokens_details?.cached_tokens ?? 0,
      uncachedInputTokens: 0,
      durationMsIncludingRetries: now - start,
      timeSinceLastApiCallMs:
        lastCompletion !== null ? now - lastCompletion : undefined,
    })
    setLastApiCompletionTimestamp(now)

    return result
  }

  const client = await getAnthropicClient({
    maxRetries,
    model,
    source: 'side_query',
  })
  const betas = [...getModelBetas(model)]
  // Add structured-outputs beta if using output_format and provider supports it
  if (
    output_format &&
    modelSupportsStructuredOutputs(model) &&
    !betas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
  ) {
    betas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  // Extract first user message text for fingerprint
  const messageText = extractFirstUserMessageText(messages)

  // Compute fingerprint for OAuth attribution
  const fingerprint = computeFingerprint(messageText, MACRO.VERSION)
  const attributionHeader = getAttributionHeader(fingerprint)

  // Build system as array to keep attribution header in its own block
  // (prevents server-side parsing from including system content in cc_entrypoint)
  const systemBlocks: TextBlockParam[] = [
    attributionHeader ? { type: 'text', text: attributionHeader } : null,
    // Skip CLI system prompt prefix for internal classifiers that provide their own prompt
    ...(skipSystemPromptPrefix
      ? []
      : [
          {
            type: 'text' as const,
            text: getCLISyspromptPrefix({
              isNonInteractive: false,
              hasAppendSystemPrompt: false,
            }),
          },
        ]),
    ...(Array.isArray(system)
      ? system
      : system
        ? [{ type: 'text' as const, text: system }]
        : []),
  ].filter((block): block is TextBlockParam => block !== null)

  let thinkingConfig: BetaThinkingConfigParam | undefined
  if (thinking === false) {
    thinkingConfig = { type: 'disabled' }
  } else if (thinking !== undefined) {
    thinkingConfig = {
      type: 'enabled',
      budget_tokens: Math.min(thinking, max_tokens - 1),
    }
  }

  const normalizedModel = normalizeModelStringForAPI(model)
  const start = Date.now()
  // biome-ignore lint/plugin: this IS the wrapper that handles OAuth attribution
  const response = await client.beta.messages.create(
    {
      model: normalizedModel,
      max_tokens,
      system: systemBlocks,
      messages,
      ...(tools && { tools }),
      ...(tool_choice && { tool_choice }),
      ...(output_format && { output_config: { format: output_format } }),
      ...(temperature !== undefined && { temperature }),
      ...(stop_sequences && { stop_sequences }),
      ...(thinkingConfig && { thinking: thinkingConfig }),
      ...(betas.length > 0 && { betas }),
      metadata: getAPIMetadata(),
    },
    { signal },
  )

  const requestId =
    (response as { _request_id?: string | null })._request_id ?? undefined
  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  logEvent('tengu_api_success', {
    requestId:
      requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource:
      opts.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      normalizedModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
    uncachedInputTokens: response.usage.cache_creation_input_tokens ?? 0,
    durationMsIncludingRetries: now - start,
    timeSinceLastApiCallMs:
      lastCompletion !== null ? now - lastCompletion : undefined,
  })
  setLastApiCompletionTimestamp(now)

  return response
}
