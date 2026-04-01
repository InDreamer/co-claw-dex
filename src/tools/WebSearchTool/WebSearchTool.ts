import type {
  BetaContentBlock,
  BetaWebSearchTool20250305,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { getAPIProvider } from 'src/utils/model/providers.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { z } from 'zod/v4'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { queryWithModel } from '../../services/api/claude.js'
import { callMCPToolWithUrlElicitationRetry } from '../../services/mcp/client.js'
import type { ConnectedMCPServer } from '../../services/mcp/types.js'
import {
  isOpenAIResponsesBackendEnabled,
  resolveOpenAIModel,
} from '../../services/modelBackend/openaiCodexConfig.js'
import { fetchOpenAIJson } from '../../services/modelBackend/openaiApi.js'
import { getModelBackend } from '../../services/modelBackend/index.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { createUserMessage } from '../../utils/messages.js'
import { getMainLoopModel, getSmallFastModel } from '../../utils/model/model.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { getWebSearchPrompt, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'

type OpenAIWebSearchSource = {
  title?: string
  url?: string
}

type OpenAIWebSearchCall = {
  type: 'web_search_call'
  id?: string
  action?: {
    type?: 'search' | 'open_page' | 'find_in_page'
    query?: string
    queries?: string[]
    sources?: OpenAIWebSearchSource[]
  }
}

type OpenAIOutputTextAnnotation = {
  type?: string
  title?: string
  url?: string
}

type OpenAIOutputTextPart = {
  type: 'output_text'
  text?: string
  annotations?: OpenAIOutputTextAnnotation[]
}

type OpenAIMessageOutput = {
  type: 'message'
  content?: OpenAIOutputTextPart[]
}

type OpenAIWebSearchResponse = {
  output?: Array<OpenAIWebSearchCall | OpenAIMessageOutput | Record<string, unknown>>
}

type GrokSearchResult = {
  title: string
  url: string
  description?: string
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().min(2).describe('The search query to use'),
    allowed_domains: z
      .array(z.string())
      .optional()
      .describe('Only include search results from these domains'),
    blocked_domains: z
      .array(z.string())
      .optional()
      .describe('Never include search results from these domains'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Input = z.infer<InputSchema>

const searchResultSchema = lazySchema(() => {
  const searchHitSchema = z.object({
    title: z.string().describe('The title of the search result'),
    url: z.string().describe('The URL of the search result'),
  })

  return z.object({
    tool_use_id: z.string().describe('ID of the tool use'),
    content: z.array(searchHitSchema).describe('Array of search hits'),
  })
})

export type SearchResult = z.infer<ReturnType<typeof searchResultSchema>>

const outputSchema = lazySchema(() =>
  z.object({
    query: z.string().describe('The search query that was executed'),
    results: z
      .array(z.union([searchResultSchema(), z.string()]))
      .describe('Search results and/or text commentary from the model'),
    durationSeconds: z
      .number()
      .describe('Time taken to complete the search operation'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// Re-export WebSearchProgress from centralized types to break import cycles
export type { WebSearchProgress } from '../../types/tools.js'

import type { WebSearchProgress } from '../../types/tools.js'

function makeToolSchema(input: Input): BetaWebSearchTool20250305 {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    allowed_domains: input.allowed_domains,
    blocked_domains: input.blocked_domains,
    max_uses: 8, // Hardcoded to 8 searches maximum
  }
}

function makeOutputFromSearchResponse(
  result: BetaContentBlock[],
  query: string,
  durationSeconds: number,
): Output {
  // The result is a sequence of these blocks:
  // - text to start -- always?
  // [
  //    - server_tool_use
  //    - web_search_tool_result
  //    - text and citation blocks intermingled
  //  ]+  (this block repeated for each search)

  const results: (SearchResult | string)[] = []
  let textAcc = ''
  let inText = true

  for (const block of result) {
    if (block.type === 'server_tool_use') {
      if (inText) {
        inText = false
        if (textAcc.trim().length > 0) {
          results.push(textAcc.trim())
        }
        textAcc = ''
      }
      continue
    }

    if (block.type === 'web_search_tool_result') {
      // Handle error case - content is a WebSearchToolResultError
      if (!Array.isArray(block.content)) {
        const errorMessage = `Web search error: ${block.content.error_code}`
        logError(new Error(errorMessage))
        results.push(errorMessage)
        continue
      }
      // Success case - add results to our collection
      const hits = block.content.map(r => ({ title: r.title, url: r.url }))
      results.push({
        tool_use_id: block.tool_use_id,
        content: hits,
      })
    }

    if (block.type === 'text') {
      if (inText) {
        textAcc += block.text
      } else {
        inText = true
        textAcc = block.text
      }
    }
  }

  if (textAcc.length) {
    results.push(textAcc.trim())
  }

  return {
    query,
    results,
    durationSeconds,
  }
}

function normalizeDomainFilter(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
}

function getMessageOutputText(
  item: OpenAIMessageOutput,
): { text: string; annotations: OpenAIOutputTextAnnotation[] } {
  const textParts = (item.content ?? []).filter(
    (part): part is OpenAIOutputTextPart => part.type === 'output_text',
  )

  return {
    text: textParts.map(part => part.text ?? '').join('').trim(),
    annotations: textParts.flatMap(part => part.annotations ?? []),
  }
}

function matchesBlockedDomain(url: string, blockedDomains: string[]): boolean {
  if (blockedDomains.length === 0) return false

  let hostname = ''
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    hostname = url.toLowerCase()
  }

  return blockedDomains.some(domain => {
    const normalized = normalizeDomainFilter(domain).toLowerCase()
    return hostname === normalized || hostname.endsWith(`.${normalized}`)
  })
}

function dedupeSearchHits(
  hits: Array<{ title: string; url: string }>,
): Array<{ title: string; url: string }> {
  const seen = new Set<string>()
  const deduped: Array<{ title: string; url: string }> = []

  for (const hit of hits) {
    const key = hit.url.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    deduped.push(hit)
  }

  return deduped
}

function makeOutputFromOpenAIWebSearchResponse(
  response: OpenAIWebSearchResponse,
  query: string,
  durationSeconds: number,
  blockedDomains: string[],
): Output {
  const results: (SearchResult | string)[] = []
  const searchCallResults: SearchResult[] = []

  for (const item of response.output ?? []) {
    if (item.type === 'web_search_call') {
      const rawSources = item.action?.sources ?? []
      const hits = dedupeSearchHits(
        rawSources
          .map(source => ({
            title: source.title?.trim() || source.url?.trim() || 'Untitled source',
            url: source.url?.trim() || '',
          }))
          .filter(source => source.url.length > 0)
          .filter(source => !matchesBlockedDomain(source.url, blockedDomains)),
      )

      if (hits.length > 0) {
        searchCallResults.push({
          tool_use_id: item.id ?? `web_search_${searchCallResults.length + 1}`,
          content: hits,
        })
      }
      continue
    }

    if (item.type === 'message') {
      const { text, annotations } = getMessageOutputText(item)
      if (text) {
        results.push(text)
      }

      const citedHits = dedupeSearchHits(
        annotations
          .filter(
            (annotation): annotation is OpenAIOutputTextAnnotation & {
              type: 'url_citation'
              title?: string
              url: string
            } =>
              annotation.type === 'url_citation' &&
              typeof annotation.url === 'string' &&
              annotation.url.length > 0,
          )
          .map(annotation => ({
            title: annotation.title?.trim() || annotation.url,
            url: annotation.url,
          }))
          .filter(source => !matchesBlockedDomain(source.url, blockedDomains)),
      )

      if (
        citedHits.length > 0 &&
        !searchCallResults.some(existing =>
          citedHits.every(hit =>
            existing.content.some(existingHit => existingHit.url === hit.url),
          ),
        )
      ) {
        searchCallResults.push({
          tool_use_id: `citations_${searchCallResults.length + 1}`,
          content: citedHits,
        })
      }
    }
  }

  results.push(...searchCallResults)

  return {
    query,
    results,
    durationSeconds,
  }
}

async function runOpenAIWebSearch(
  input: Input,
  model: string,
  signal: AbortSignal,
  onProgress?: (progress: {
    toolUseID: string
    data: WebSearchProgress
  }) => void,
): Promise<Output> {
  const startTime = performance.now()
  const normalizedAllowedDomains = (input.allowed_domains ?? []).map(
    normalizeDomainFilter,
  )
  const normalizedBlockedDomains = (input.blocked_domains ?? []).map(
    normalizeDomainFilter,
  )

  onProgress?.({
    toolUseID: 'search-progress-1',
    data: {
      type: 'query_update',
      query: input.query,
    },
  })

  const instructions = [
    'You are executing a web search tool call inside a coding agent.',
    'Search the web for the user query and return a concise factual summary.',
    'Prefer the most relevant and current sources.',
    normalizedBlockedDomains.length > 0
      ? `Do not rely on or cite these blocked domains: ${normalizedBlockedDomains.join(', ')}.`
      : null,
  ]
    .filter(Boolean)
    .join('\n')

  const request: Record<string, unknown> = {
    model,
    instructions,
    input: input.query,
    tools: [
      {
        type: 'web_search',
        ...(normalizedAllowedDomains.length > 0
          ? {
              filters: {
                allowed_domains: normalizedAllowedDomains,
              },
            }
          : {}),
        external_web_access: true,
      },
    ],
    include: ['web_search_call.action.sources'],
    max_tool_calls: 8,
    tool_choice: 'required',
    store: false,
  }

  const payload = await fetchOpenAIJson<OpenAIWebSearchResponse>('/responses', {
    method: 'POST',
    body: request,
    signal,
  })
  const durationSeconds = (performance.now() - startTime) / 1000
  const output = makeOutputFromOpenAIWebSearchResponse(
    payload,
    input.query,
    durationSeconds,
    normalizedBlockedDomains,
  )

  output.results.forEach((result, index) => {
    if (typeof result === 'string') return
    onProgress?.({
      toolUseID: result.tool_use_id || `search-progress-${index + 2}`,
      data: {
        type: 'search_results_received',
        resultCount: result.content.length,
        query: input.query,
      },
    })
  })

  return output
}

function buildFallbackSearchQuery(input: Input): string {
  const allowed = (input.allowed_domains ?? [])
    .map(normalizeDomainFilter)
    .filter(Boolean)
  const blocked = (input.blocked_domains ?? [])
    .map(normalizeDomainFilter)
    .filter(Boolean)

  const allowClause =
    allowed.length > 0
      ? allowed.map(domain => `site:${domain}`).join(' OR ') + ' '
      : ''
  const blockClause =
    blocked.length > 0
      ? ' ' + blocked.map(domain => `-site:${domain}`).join(' ')
      : ''

  return `${allowClause}${input.query}${blockClause}`.trim()
}

function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced?.[1]?.trim() || trimmed
}

function extractUrlsFromText(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)>\]]+/g) ?? []
  return [...new Set(matches.map(match => match.trim()))]
}

function normalizeParsedSearchResults(parsed: unknown): GrokSearchResult[] {
  if (!Array.isArray(parsed)) {
    throw new Error('Unexpected grok-search result format')
  }

  const textWrappedResults = parsed.filter(
    (item): item is { type: 'text'; text: string } =>
      typeof item === 'object' &&
      item !== null &&
      'type' in item &&
      item.type === 'text' &&
      'text' in item &&
      typeof item.text === 'string',
  )
  if (textWrappedResults.length > 0) {
    const nestedText = textWrappedResults.map(item => item.text).join('\n').trim()
    return parseGrokSearchResults(nestedText)
  }

  return parsed
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
    )
    .map(item => ({
      title:
        (typeof item.title === 'string' && item.title.trim()) ||
        (typeof item.url === 'string' && item.url.trim()) ||
        'Untitled result',
      url: typeof item.url === 'string' ? item.url.trim() : '',
      description:
        typeof item.description === 'string'
          ? item.description.trim()
          : typeof item.summary === 'string'
            ? item.summary.trim()
            : undefined,
    }))
    .filter(item => item.url.length > 0)
}

function parseGrokSearchResults(rawText: string): GrokSearchResult[] {
  const stripped = stripMarkdownCodeFence(rawText)
  const parsed = jsonParse(stripped) as unknown
  return normalizeParsedSearchResults(parsed)
}

function parseGrokSearchPayload(rawText: string): {
  summary: string | null
  results: GrokSearchResult[]
} {
  const stripped = stripMarkdownCodeFence(rawText)
  const parsed = jsonParse(stripped) as unknown

  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'content' in parsed &&
    typeof parsed.content === 'string'
  ) {
    const summary = parsed.content.trim()
    const results = extractUrlsFromText(summary).map(url => ({
      title: url,
      url,
    }))
    return { summary: summary || null, results }
  }

  return {
    summary: null,
    results: normalizeParsedSearchResults(parsed),
  }
}

function findGrokSearchClient(
  context: Pick<ToolUseContext, 'getAppState'>,
): ConnectedMCPServer | undefined {
  const appState = context.getAppState()
  const client = appState.mcp.clients.find(
    candidate =>
      candidate.type === 'connected' &&
      candidate.name.toLowerCase().includes('grok-search'),
  )

  return client?.type === 'connected' ? (client as ConnectedMCPServer) : undefined
}

async function summarizeSearchResults(
  results: GrokSearchResult[],
  signal: AbortSignal,
  model: string,
): Promise<string | null> {
  if (results.length === 0) return null

  const prompt = [
    'Summarize these search results in 2-4 concise sentences.',
    'Only use the provided results.',
    'Do not invent facts that are not present in the snippets.',
    '',
    jsonStringify(results.slice(0, 8)),
  ].join('\n')

  const response = await queryWithModel({
    systemPrompt: asSystemPrompt([
      'You summarize search results for an internal web-search tool.',
    ]),
    userPrompt: prompt,
    signal,
    options: {
      model,
      querySource: 'web_search_tool',
      enablePromptCaching: false,
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
    },
  })

  const text = response.message.content
    .filter(block => block.type === 'text')
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()

  return text || null
}

async function runMcpFallbackWebSearch(
  input: Input,
  context: ToolUseContext,
  model: string,
  onProgress?: (progress: {
    toolUseID: string
    data: WebSearchProgress
  }) => void,
): Promise<Output> {
  const grokClient = findGrokSearchClient(context)
  if (!grokClient) {
    throw new Error(
      'WebSearch failed through the Responses provider and no grok-search MCP server is connected for fallback.',
    )
  }

  const startTime = performance.now()
  const searchQuery = buildFallbackSearchQuery(input)

  onProgress?.({
    toolUseID: 'search-progress-fallback',
    data: {
      type: 'query_update',
      query: searchQuery,
    },
  })

  const mcpResult = await callMCPToolWithUrlElicitationRetry({
    client: grokClient,
    clientConnection: grokClient,
    tool: 'web_search',
    args: {
      query: searchQuery,
    },
    signal: context.abortController.signal,
    setAppState: context.setAppState,
    handleElicitation: context.handleElicitation,
  })

  const rawText =
    typeof mcpResult.content === 'string'
      ? mcpResult.content.trim()
      : (mcpResult.content ?? [])
          .filter(
            (block): block is { type: 'text'; text: string } =>
              typeof block === 'object' &&
              block !== null &&
              'type' in block &&
              block.type === 'text' &&
              'text' in block &&
              typeof block.text === 'string',
          )
          .map(block => block.text)
          .join('\n')
          .trim()

  const payload = parseGrokSearchPayload(rawText)
  const parsedResults = payload.results
  const summary =
    payload.summary ??
    (await summarizeSearchResults(
      parsedResults,
      context.abortController.signal,
      model,
    ))

  onProgress?.({
    toolUseID: 'search-progress-fallback-results',
    data: {
      type: 'search_results_received',
      resultCount: parsedResults.length,
      query: searchQuery,
    },
  })

  const durationSeconds = (performance.now() - startTime) / 1000
  return {
    query: input.query,
    results: [
      ...(summary ? [summary] : []),
      {
        tool_use_id: `mcp_web_search_${Date.now()}`,
        content: parsedResults.map(result => ({
          title: result.title,
          url: result.url,
        })),
      },
    ],
    durationSeconds,
  }
}

export const WebSearchTool = buildTool({
  name: WEB_SEARCH_TOOL_NAME,
  searchHint: 'search the web for current information',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description(input) {
    return `Claude wants to search the web for: ${input.query}`
  },
  userFacingName() {
    return 'Web Search'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Searching for ${summary}` : 'Searching the web'
  },
  isEnabled() {
    const provider = getAPIProvider()
    const model = getMainLoopModel()

    // Enable for firstParty
    if (provider === 'firstParty') {
      return true
    }

    // Enable for Vertex AI with supported models (Claude 4.0+)
    if (provider === 'vertex') {
      const supportsWebSearch =
        model.includes('claude-opus-4') ||
        model.includes('claude-sonnet-4') ||
        model.includes('claude-haiku-4')

      return supportsWebSearch
    }

    // Foundry only ships models that already support Web Search
    if (provider === 'foundry') {
      return true
    }

    return false
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.query
  },
  async checkPermissions(_input): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: 'WebSearchTool requires permission.',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: WEB_SEARCH_TOOL_NAME }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    }
  },
  async prompt() {
    return getWebSearchPrompt()
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  extractSearchText() {
    // renderToolResultMessage shows only "Did N searches in Xs" chrome —
    // the results[] content never appears on screen. Heuristic would index
    // string entries in results[] (phantom match). Nothing to search.
    return ''
  },
  async validateInput(input) {
    const { query, allowed_domains, blocked_domains } = input
    if (!query.length) {
      return {
        result: false,
        message: 'Error: Missing query',
        errorCode: 1,
      }
    }
    if (allowed_domains?.length && blocked_domains?.length) {
      return {
        result: false,
        message:
          'Error: Cannot specify both allowed_domains and blocked_domains in the same request',
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async call(input, context, _canUseTool, _parentMessage, onProgress) {
    const startTime = performance.now()
    const { query } = input

    if (isOpenAIResponsesBackendEnabled()) {
      const useHaiku = getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_plum_vx3',
        false,
      )

      const model = resolveOpenAIModel(
        useHaiku ? getSmallFastModel() : context.options.mainLoopModel,
      )

      try {
        return {
          data: await runOpenAIWebSearch(
            input,
            model,
            context.abortController.signal,
            onProgress,
          ),
        }
      } catch (error) {
        logError(error)
        return {
          data: await runMcpFallbackWebSearch(
            input,
            context,
            model,
            onProgress,
          ),
        }
      }
    }

    const userMessage = createUserMessage({
      content: 'Perform a web search for the query: ' + query,
    })
    const toolSchema = makeToolSchema(input)

    const useHaiku = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_plum_vx3',
      false,
    )

    const appState = context.getAppState()
    const modelBackend = getModelBackend()
    const queryStream = modelBackend.streamTurn({
      messages: [userMessage],
      systemPrompt: asSystemPrompt([
        'You are an assistant for performing a web search tool use',
      ]),
      thinkingConfig: useHaiku
        ? { type: 'disabled' as const }
        : context.options.thinkingConfig,
      tools: [],
      signal: context.abortController.signal,
      options: {
        getToolPermissionContext: async () => appState.toolPermissionContext,
        model: useHaiku ? getSmallFastModel() : context.options.mainLoopModel,
        toolChoice: useHaiku ? { type: 'tool', name: 'web_search' } : undefined,
        isNonInteractiveSession: context.options.isNonInteractiveSession,
        hasAppendSystemPrompt: !!context.options.appendSystemPrompt,
        extraToolSchemas: [toolSchema],
        querySource: 'web_search_tool',
        agents: context.options.agentDefinitions.activeAgents,
        mcpTools: [],
        agentId: context.agentId,
        effortValue: appState.effortValue,
      },
    })

    const allContentBlocks: BetaContentBlock[] = []
    let currentToolUseId = null
    let currentToolUseJson = ''
    let progressCounter = 0
    const toolUseQueries = new Map() // Map of tool_use_id to query

    for await (const event of queryStream) {
      if (event.type === 'assistant') {
        allContentBlocks.push(...event.message.content)
        continue
      }

      // Track tool use ID when server_tool_use starts
      if (
        event.type === 'stream_event' &&
        event.event?.type === 'content_block_start'
      ) {
        const contentBlock = event.event.content_block
        if (contentBlock && contentBlock.type === 'server_tool_use') {
          currentToolUseId = contentBlock.id
          currentToolUseJson = ''
          // Note: The ServerToolUseBlock doesn't contain input.query
          // The actual query comes through input_json_delta events
          continue
        }
      }

      // Accumulate JSON for current tool use
      if (
        currentToolUseId &&
        event.type === 'stream_event' &&
        event.event?.type === 'content_block_delta'
      ) {
        const delta = event.event.delta
        if (delta?.type === 'input_json_delta' && delta.partial_json) {
          currentToolUseJson += delta.partial_json

          // Try to extract query from partial JSON for progress updates
          try {
            // Look for a complete query field
            const queryMatch = currentToolUseJson.match(
              /"query"\s*:\s*"((?:[^"\\]|\\.)*)"/,
            )
            if (queryMatch && queryMatch[1]) {
              // The regex properly handles escaped characters
              const query = jsonParse('"' + queryMatch[1] + '"')

              if (
                !toolUseQueries.has(currentToolUseId) ||
                toolUseQueries.get(currentToolUseId) !== query
              ) {
                toolUseQueries.set(currentToolUseId, query)
                progressCounter++
                if (onProgress) {
                  onProgress({
                    toolUseID: `search-progress-${progressCounter}`,
                    data: {
                      type: 'query_update',
                      query,
                    },
                  })
                }
              }
            }
          } catch {
            // Ignore parsing errors for partial JSON
          }
        }
      }

      // Yield progress when search results come in
      if (
        event.type === 'stream_event' &&
        event.event?.type === 'content_block_start'
      ) {
        const contentBlock = event.event.content_block
        if (contentBlock && contentBlock.type === 'web_search_tool_result') {
          // Get the actual query that was used for this search
          const toolUseId = contentBlock.tool_use_id
          const actualQuery = toolUseQueries.get(toolUseId) || query
          const content = contentBlock.content

          progressCounter++
          if (onProgress) {
            onProgress({
              toolUseID: toolUseId || `search-progress-${progressCounter}`,
              data: {
                type: 'search_results_received',
                resultCount: Array.isArray(content) ? content.length : 0,
                query: actualQuery,
              },
            })
          }
        }
      }
    }

    // Process the final result
    const endTime = performance.now()
    const durationSeconds = (endTime - startTime) / 1000

    const data = makeOutputFromSearchResponse(
      allContentBlocks,
      query,
      durationSeconds,
    )
    return { data }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const { query, results } = output

    let formattedOutput = `Web search results for query: "${query}"\n\n`

    // Process the results array - it can contain both string summaries and search result objects.
    // Guard against null/undefined entries that can appear after JSON round-tripping
    // (e.g., from compaction or transcript deserialization).
    ;(results ?? []).forEach(result => {
      if (result == null) {
        return
      }
      if (typeof result === 'string') {
        // Text summary
        formattedOutput += result + '\n\n'
      } else {
        // Search result with links
        if (result.content?.length > 0) {
          formattedOutput += `Links: ${jsonStringify(result.content)}\n\n`
        } else {
          formattedOutput += 'No links found.\n\n'
        }
      }
    })

    formattedOutput +=
      '\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.'

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formattedOutput.trim(),
    }
  },
} satisfies ToolDef<InputSchema, Output, WebSearchProgress>)
