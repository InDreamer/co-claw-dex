type CitationLike = Record<string, unknown>

export type CitationDisplayItem = {
  text: string
  url?: string
}

function isRecord(value: unknown): value is CitationLike {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function formatRange(
  singular: string,
  plural: string,
  start: number | undefined,
  end: number | undefined,
): string | undefined {
  if (start === undefined && end === undefined) {
    return undefined
  }

  if (start !== undefined && end !== undefined) {
    return start === end ? `${singular} ${start}` : `${plural} ${start}-${end}`
  }

  return `${plural} ${start ?? end}`
}

function getCitationLabel(citation: CitationLike): string | undefined {
  const type = readString(citation.type)

  switch (type) {
    case 'url_citation':
    case 'web_search_result_location':
      return readString(citation.title) ?? readString(citation.url) ?? 'Web source'
    case 'file_citation':
      return (
        readString(citation.filename) ??
        readString(citation.title) ??
        readString(citation.file_id) ??
        'File source'
      )
    case 'page_location':
    case 'char_location':
    case 'content_block_location':
      return (
        readString(citation.document_title) ??
        readString(citation.filename) ??
        'Document source'
      )
    case 'search_result_location':
      return (
        readString(citation.title) ??
        readString(citation.source) ??
        'Search result'
      )
    default:
      return (
        readString(citation.title) ??
        readString(citation.filename) ??
        readString(citation.document_title) ??
        readString(citation.name) ??
        readString(citation.url) ??
        type
      )
  }
}

function getCitationDetail(citation: CitationLike): string | undefined {
  const type = readString(citation.type)

  switch (type) {
    case 'file_citation': {
      const index = readNumber(citation.index)
      return index === undefined ? undefined : `match ${index}`
    }
    case 'page_location':
      return formatRange(
        'page',
        'pages',
        readNumber(citation.start_page_number),
        readNumber(citation.end_page_number),
      )
    case 'char_location':
      return formatRange(
        'char',
        'chars',
        readNumber(citation.start_char_index),
        readNumber(citation.end_char_index),
      )
    case 'content_block_location':
    case 'search_result_location':
      return formatRange(
        'block',
        'blocks',
        readNumber(citation.start_block_index),
        readNumber(citation.end_block_index),
      )
    default:
      return undefined
  }
}

function getCitationUrl(citation: CitationLike): string | undefined {
  return readString(citation.url)
}

function buildCitationKey(
  label: string,
  detail: string | undefined,
  url: string | undefined,
  type: string | undefined,
): string {
  return [type ?? '', label, detail ?? '', url ?? ''].join('|')
}

export function buildCitationDisplayItems(
  citations: readonly unknown[] | null | undefined,
  limit = 5,
): {
  items: CitationDisplayItem[]
  overflow: number
} {
  // OpenAI annotations and Claude citations are close but not identical.
  // Normalize them into a compact terminal-friendly list so we preserve
  // source visibility without rewriting markdown inline.
  const items: CitationDisplayItem[] = []
  const seen = new Set<string>()
  let overflow = 0

  for (const citation of citations ?? []) {
    if (!isRecord(citation)) {
      continue
    }

    const label = getCitationLabel(citation)
    if (!label) {
      continue
    }

    const detail = getCitationDetail(citation)
    const url = getCitationUrl(citation)
    const key = buildCitationKey(
      label,
      detail,
      url,
      readString(citation.type),
    )
    if (seen.has(key)) {
      continue
    }
    seen.add(key)

    const text = detail ? `${label} (${detail})` : label
    if (items.length < limit) {
      items.push({ text, url })
    } else {
      overflow++
    }
  }

  return { items, overflow }
}
