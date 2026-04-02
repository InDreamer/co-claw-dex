import type {
  OpenAIResponseAnnotation,
  OpenAIResponseBuiltinToolItem,
  OpenAIResponseCustomToolCall,
  OpenAIResponseFunctionCall,
  OpenAIResponseMessage,
  OpenAIResponseReasoningItem,
} from './openaiResponsesTypes.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function extractTextSegments(
  value: unknown,
  allowedTypes?: ReadonlySet<string>,
): string[] {
  const segments: string[] = []
  const visit = (entry: unknown): void => {
    if (typeof entry === 'string') {
      if (entry.length > 0) {
        segments.push(entry)
      }
      return
    }

    if (!isRecord(entry)) {
      return
    }

    const type = typeof entry.type === 'string' ? entry.type : undefined
    if (allowedTypes && type && !allowedTypes.has(type)) {
      return
    }

    if (typeof entry.text === 'string' && entry.text.length > 0) {
      segments.push(entry.text)
      return
    }

    if (typeof entry.refusal === 'string' && entry.refusal.length > 0) {
      segments.push(entry.refusal)
      return
    }

    if (typeof entry.transcript === 'string' && entry.transcript.length > 0) {
      segments.push(entry.transcript)
      return
    }

    if (typeof entry.summary === 'string' && entry.summary.length > 0) {
      segments.push(entry.summary)
    }
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      visit(entry)
    }
  } else {
    visit(value)
  }

  return segments
}

export function extractOpenAIResponseMessageText(
  item: Pick<OpenAIResponseMessage, 'content'>,
): string {
  const segments: string[] = []
  for (const part of item.content ?? []) {
    if (!isRecord(part)) {
      continue
    }

    const type = typeof part.type === 'string' ? part.type : undefined
    if (type !== 'output_text' && type !== 'output_audio' && type !== 'refusal') {
      continue
    }

    segments.push(...extractTextSegments(part))
  }

  return segments.join('').trim()
}

function normalizeOpenAIAnnotation(
  annotation: OpenAIResponseAnnotation,
): Record<string, unknown> {
  return {
    ...annotation,
    type: annotation.type || 'annotation',
  }
}

export function buildOpenAIContentPartKey(
  itemId: string,
  contentIndex: number,
): string {
  return `${itemId}:${contentIndex}`
}

export function extractOpenAIResponseMessageBlocks(
  item: Pick<OpenAIResponseMessage, 'id' | 'content'>,
  streamedAnnotations = new Map<string, OpenAIResponseAnnotation[]>(),
): Array<{
  type: 'text'
  text: string
  citations: Record<string, unknown>[]
}> {
  const blocks: Array<{
    type: 'text'
    text: string
    citations: Record<string, unknown>[]
  }> = []

  for (const [contentIndex, part] of (item.content ?? []).entries()) {
    if (!isRecord(part)) {
      continue
    }

    const type = typeof part.type === 'string' ? part.type : undefined
    if (type !== 'output_text' && type !== 'output_audio' && type !== 'refusal') {
      continue
    }

    const text = extractTextSegments(part).join('').trim()
    if (!text) {
      continue
    }

    const annotations = Array.isArray(part.annotations)
      ? (part.annotations.filter(isRecord) as OpenAIResponseAnnotation[])
      : []
    const fallbackAnnotations =
      typeof item.id === 'string'
        ? streamedAnnotations.get(buildOpenAIContentPartKey(item.id, contentIndex))
        : undefined
    const citationSource =
      annotations.length > 0 ? annotations : (fallbackAnnotations ?? [])

    blocks.push({
      type: 'text',
      text,
      citations: citationSource.map(normalizeOpenAIAnnotation),
    })
  }

  return blocks
}

export function extractOpenAIResponseReasoningText(
  item: Pick<OpenAIResponseReasoningItem, 'summary' | 'content'>,
): string {
  const summarySegments = extractTextSegments(item.summary)
  if (summarySegments.length > 0) {
    return summarySegments.join('\n\n').trim()
  }

  const contentSegments = extractTextSegments(
    item.content,
    new Set(['output_text', 'reasoning_text', 'summary_text']),
  )
  if (contentSegments.length > 0) {
    return contentSegments.join('\n\n').trim()
  }

  return ''
}

export function parseOpenAIResponseFunctionArguments(
  functionCall: Pick<OpenAIResponseFunctionCall, 'arguments'>,
): unknown {
  try {
    return JSON.parse(functionCall.arguments || '{}')
  } catch {
    return { raw_arguments: functionCall.arguments || '' }
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readStringLength(value: unknown): number | undefined {
  return typeof value === 'string' && value.length > 0 ? value.length : undefined
}

function countArray(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map(entry => readString(entry))
    .filter((entry): entry is string => entry !== undefined)
}

function readNamedPreview(value: unknown, limit = 3): string | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const preview = value
    .map(entry => {
      if (isRecord(entry)) {
        return (
          readString(entry.name) ??
          readString(entry.title) ??
          readString(entry.filename) ??
          readString(entry.url) ??
          readString(entry.file_id)
        )
      }

      return readString(entry)
    })
    .filter((entry): entry is string => entry !== undefined)

  if (preview.length === 0) {
    return undefined
  }

  const head = preview.slice(0, limit).join(', ')
  const remainder = preview.length - limit
  return remainder > 0 ? `${head} (+${remainder} more)` : head
}

function readTypePreview(value: unknown, limit = 4): string | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const types = [
    ...new Set(
      value
        .map(entry => (isRecord(entry) ? readString(entry.type) : undefined))
        .filter((entry): entry is string => entry !== undefined),
    ),
  ]

  if (types.length === 0) {
    return undefined
  }

  const head = types.slice(0, limit).join(', ')
  const remainder = types.length - limit
  return remainder > 0 ? `${head} (+${remainder} more)` : head
}

function collectNestedStringValues(
  value: unknown,
  key: string,
  limit = 3,
): string[] {
  const results: string[] = []
  const seen = new Set<string>()

  const visit = (entry: unknown): void => {
    if (results.length >= limit) {
      return
    }

    if (Array.isArray(entry)) {
      for (const child of entry) {
        visit(child)
        if (results.length >= limit) {
          return
        }
      }
      return
    }

    if (!isRecord(entry)) {
      return
    }

    const direct = readString(entry[key])
    if (direct && !seen.has(direct)) {
      seen.add(direct)
      results.push(direct)
      if (results.length >= limit) {
        return
      }
    }

    for (const child of Object.values(entry)) {
      if (typeof child === 'object' && child !== null) {
        visit(child)
        if (results.length >= limit) {
          return
        }
      }
    }
  }

  visit(value)
  return results
}

function pushDetail(
  lines: string[],
  label: string,
  value: string | number | undefined,
): void {
  if (value === undefined) {
    return
  }
  lines.push(`${label}: ${value}`)
}

function formatMultilineDetail(
  label: string,
  value: string | undefined,
  limit = 1200,
): string | undefined {
  if (!value) {
    return undefined
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  const clipped =
    trimmed.length > limit ? `${trimmed.slice(0, limit)}\n[truncated]` : trimmed
  return `${label}:\n${clipped}`
}

function formatRawMultilineDetail(
  label: string,
  value: string | undefined,
  limit = 1200,
): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined
  }

  const clipped =
    value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value
  return `${label}:\n${clipped}`
}

const displayOnlyNativeItemTypes = new Set([
  'custom_tool_call',
  'code_interpreter_call',
  'computer_call',
  'computer_call_output',
  'file_search_call',
  'image_generation_call',
  'mcp_call',
  'mcp_list_tools',
  'mcp_tool_call',
  'web_search_call',
])

export function isOpenAIDisplayOnlyNativeItemType(
  type: string | undefined,
): type is
  | OpenAIResponseCustomToolCall['type']
  | OpenAIResponseBuiltinToolItem['type'] {
  return type !== undefined && displayOnlyNativeItemTypes.has(type)
}

function stringifyPreview(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value === 'string') {
    return value
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value)
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return undefined
  }
}

function pushPreviewDetail(
  lines: string[],
  label: string,
  value: unknown,
  limit = 600,
): void {
  const block = formatMultilineDetail(label, stringifyPreview(value), limit)
  if (block) {
    lines.push(block)
  }
}

export function summarizeOpenAINativeStreamItem(
  item: OpenAIResponseBuiltinToolItem | OpenAIResponseCustomToolCall,
): string | undefined {
  const lines = [`[OpenAI native item: ${item.type}]`]

  switch (item.type) {
    case 'custom_tool_call':
      pushDetail(lines, 'name', readString(item.name))
      pushDetail(lines, 'call_id', readString(item.call_id))
      pushDetail(lines, 'status', readString(item.status))
      return lines.join('\n')
    case 'web_search_call': {
      const action = isRecord(item.action) ? item.action : undefined
      pushDetail(lines, 'action', readString(action?.type))
      pushDetail(
        lines,
        'query',
        readString(action?.query) || readStringArray(action?.queries).join(', '),
      )
      pushDetail(lines, 'status', readString(item.status))
      pushDetail(lines, 'sources', countArray(action?.sources))
      return lines.join('\n')
    }
    case 'file_search_call': {
      const record = item as Record<string, unknown>
      pushDetail(
        lines,
        'query',
        readString(record.query) || readString(record.search_query),
      )
      pushDetail(lines, 'status', readString(item.status))
      pushDetail(lines, 'results', countArray(record.results))
      return lines.join('\n')
    }
    case 'image_generation_call': {
      const record = item as Record<string, unknown>
      pushDetail(lines, 'status', readString(item.status))
      pushDetail(
        lines,
        'partial_images',
        readNumber(record.partial_image_count),
      )
      // Never inline the base64 payload into transcript text; keep only
      // lightweight metadata so display fidelity doesn't become transcript noise.
      pushDetail(lines, 'result_bytes', readStringLength(record.result))
      return lines.join('\n')
    }
    case 'mcp_list_tools': {
      const record = item as Record<string, unknown>
      pushDetail(lines, 'server_label', readString(record.server_label))
      pushDetail(lines, 'status', readString(item.status))
      pushDetail(lines, 'tools', countArray(record.tools))
      return lines.join('\n')
    }
    case 'mcp_call':
    case 'mcp_tool_call': {
      const record = item as Record<string, unknown>
      pushDetail(lines, 'server_label', readString(record.server_label))
      pushDetail(lines, 'name', readString(record.name))
      pushDetail(lines, 'tool_name', readString(record.tool_name))
      pushDetail(lines, 'status', readString(item.status))
      return lines.join('\n')
    }
    case 'code_interpreter_call':
      pushDetail(lines, 'status', readString(item.status))
      pushDetail(lines, 'outputs', countArray((item as Record<string, unknown>).outputs))
      pushDetail(
        lines,
        'output_types',
        readTypePreview((item as Record<string, unknown>).outputs),
      )
      return lines.join('\n')
    case 'computer_call':
    case 'computer_call_output':
      pushDetail(lines, 'status', readString(item.status))
      pushPreviewDetail(lines, 'action', (item as Record<string, unknown>).action, 240)
      pushDetail(
        lines,
        'image_urls',
        collectNestedStringValues(
          (item as Record<string, unknown>).output,
          'image_url',
        ).length || undefined,
      )
      return lines.join('\n')
    default:
      return `${lines[0]}\nstatus: ${readString(item.status) ?? 'unknown'}`
  }
}

export function buildOpenAICustomToolCallStreamText(
  item: Pick<OpenAIResponseCustomToolCall, 'type' | 'name' | 'call_id' | 'status' | 'input'>,
  inputOverride?: string,
): string | undefined {
  const summary = summarizeOpenAINativeStreamItem(item)
  const inputBlock = formatRawMultilineDetail(
    'input',
    inputOverride !== undefined ? inputOverride : item.input,
  )

  if (!summary) {
    return inputBlock
  }

  return inputBlock ? `${summary}\n${inputBlock}` : summary
}

export function summarizeOpenAINativeOutputItem(
  item: OpenAIResponseBuiltinToolItem | OpenAIResponseCustomToolCall,
): string | undefined {
  // These items stay display-only on the Claude Code side. We summarize them
  // into transcript text so OpenAI-native tool activity is visible without
  // changing the local runtime's execution authority.
  const lines = [`[OpenAI native item: ${item.type}]`]

  switch (item.type) {
    case 'custom_tool_call': {
      pushDetail(lines, 'name', readString(item.name))
      pushDetail(lines, 'call_id', readString(item.call_id))
      pushDetail(lines, 'status', readString(item.status))
      pushPreviewDetail(lines, 'input', item.input)
      return lines.join('\n')
    }
    case 'web_search_call': {
      const action = isRecord(item.action) ? item.action : undefined
      pushDetail(lines, 'action', readString(action?.type))
      const query = readString(action?.query)
      const queries = readStringArray(action?.queries).join(', ')
      pushDetail(lines, 'query', query ?? queries)
      pushDetail(lines, 'status', readString(item.status))
      pushDetail(lines, 'sources', countArray(action?.sources))
      pushDetail(
        lines,
        'source_preview',
        readNamedPreview(action?.sources),
      )
      pushDetail(
        lines,
        'page_url',
        readString(action?.url) ?? readString(action?.page_url),
      )
      pushDetail(lines, 'pattern', readString(action?.pattern))
      return lines.join('\n')
    }
    case 'file_search_call': {
      const record = item as Record<string, unknown>
      const query =
        readString(record.query) ||
        readString(record.search_query)
      pushDetail(lines, 'query', query)
      pushDetail(lines, 'status', readString(item.status))
      pushDetail(lines, 'results', countArray(record.results))
      pushDetail(lines, 'result_preview', readNamedPreview(record.results))
      return lines.join('\n')
    }
    case 'image_generation_call': {
      const record = item as Record<string, unknown>
      pushDetail(lines, 'status', readString(item.status))
      pushDetail(
        lines,
        'partial_images',
        readNumber(record.partial_image_count),
      )
      // Preserve revised prompt visibility, but keep the binary image payload
      // summarized as byte length instead of dumping base64 into the transcript.
      pushDetail(lines, 'result_bytes', readStringLength(record.result))
      const revisedPrompt = formatMultilineDetail(
        'revised_prompt',
        readString(record.revised_prompt),
        600,
      )
      if (revisedPrompt) {
        lines.push(revisedPrompt)
      }
      return lines.join('\n')
    }
    case 'mcp_list_tools': {
      const record = item as Record<string, unknown>
      pushDetail(lines, 'server_label', readString(record.server_label))
      pushDetail(lines, 'status', readString(item.status))
      pushDetail(lines, 'tools', countArray(record.tools))
      pushDetail(lines, 'tool_preview', readNamedPreview(record.tools))
      return lines.join('\n')
    }
    case 'mcp_call':
    case 'mcp_tool_call': {
      const record = item as Record<string, unknown>
      pushDetail(lines, 'server_label', readString(record.server_label))
      pushDetail(lines, 'name', readString(record.name))
      pushDetail(lines, 'tool_name', readString(record.tool_name))
      pushDetail(lines, 'status', readString(item.status))
      pushPreviewDetail(lines, 'arguments', record.arguments)
      pushPreviewDetail(lines, 'input', record.input)
      pushPreviewDetail(
        lines,
        'result',
        record.output ?? record.result ?? record.response,
      )
      return lines.join('\n')
    }
    case 'code_interpreter_call': {
      const outputs = (item as Record<string, unknown>).outputs
      pushDetail(lines, 'status', readString(item.status))
      pushDetail(lines, 'outputs', countArray(outputs))
      pushDetail(lines, 'output_types', readTypePreview(outputs))
      pushDetail(lines, 'output_preview', readNamedPreview(outputs))
      pushPreviewDetail(
        lines,
        'input',
        (item as Record<string, unknown>).input ??
          (item as Record<string, unknown>).code,
      )
      return lines.join('\n')
    }
    case 'computer_call':
    case 'computer_call_output': {
      const output = (item as Record<string, unknown>).output
      const imageUrls = collectNestedStringValues(output, 'image_url')
      pushDetail(lines, 'status', readString(item.status))
      pushPreviewDetail(lines, 'action', (item as Record<string, unknown>).action)
      pushDetail(lines, 'image_urls', imageUrls.length || undefined)
      pushDetail(
        lines,
        'image_url_preview',
        imageUrls.length > 0 ? imageUrls.join(', ') : undefined,
      )
      pushPreviewDetail(
        lines,
        'output',
        output,
      )
      return lines.join('\n')
    }
    default:
      return `${lines[0]}\nstatus: ${readString(item.status) ?? 'unknown'}`
  }
}
