const GPT_5_CONTEXT_WINDOW = 272_000
const GPT_OSS_CONTEXT_WINDOW = 128_000

export const OPENAI_CODEX_MODEL_IDS = [
  'gpt-5.4',
  'gpt-5.2',
  'gpt-5.3-codex',
  'gpt-5.4-mini',
] as const

export type OpenAICodexModelId = (typeof OPENAI_CODEX_MODEL_IDS)[number]

export type OpenAICodexModelCatalogEntry = {
  id: OpenAICodexModelId
  label: string
  description: string
  defaultEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
}

const OPENAI_CODEX_MODEL_CATALOG: readonly OpenAICodexModelCatalogEntry[] = [
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'Flagship model for the hardest coding and planning tasks',
    defaultEffort: 'high',
  },
  {
    id: 'gpt-5.2',
    label: 'GPT-5.2',
    description: 'Balanced model for everyday coding work',
    defaultEffort: 'medium',
  },
  {
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    description: 'Codex-tuned model for code-heavy edits and tool use',
    defaultEffort: 'medium',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description: 'Fast lightweight model for quick answers and utility tasks',
    defaultEffort: 'low',
  },
] as const

const OPENAI_LEGACY_MODEL_ALIASES: Record<string, OpenAICodexModelId> = {
  best: 'gpt-5.4',
  opus: 'gpt-5.4',
  'opus[1m]': 'gpt-5.4',
  opusplan: 'gpt-5.4',
  sonnet: 'gpt-5.2',
  'sonnet[1m]': 'gpt-5.2',
  haiku: 'gpt-5.4-mini',
  gpt: 'gpt-5.4',
  'gpt-5': 'gpt-5.4',
}

function normalizeOpenAIModelString(model: string | undefined): string | undefined {
  const normalized = model?.trim().toLowerCase()
  return normalized && normalized.length > 0 ? normalized : undefined
}

export function getOpenAICodexModelCatalog():
  readonly OpenAICodexModelCatalogEntry[] {
  return OPENAI_CODEX_MODEL_CATALOG
}

export function isKnownOpenAICodexModel(
  model: string | undefined,
): model is OpenAICodexModelId {
  const normalized = normalizeOpenAIModelString(model)
  return (
    normalized !== undefined &&
    (OPENAI_CODEX_MODEL_IDS as readonly string[]).includes(normalized)
  )
}

function resolveLegacyOpenAIModelFamily(
  normalizedModel: string,
): OpenAICodexModelId | undefined {
  if (normalizedModel in OPENAI_LEGACY_MODEL_ALIASES) {
    return OPENAI_LEGACY_MODEL_ALIASES[normalizedModel]!
  }
  if (normalizedModel.includes('opus') || normalizedModel.includes('best')) {
    return 'gpt-5.4'
  }
  if (normalizedModel.includes('sonnet')) {
    return 'gpt-5.2'
  }
  if (normalizedModel.includes('haiku')) {
    return 'gpt-5.4-mini'
  }
  return undefined
}

export function normalizeOpenAICompatibleModel(
  model: string | undefined,
): string | undefined {
  const normalized = normalizeOpenAIModelString(model)
  if (!normalized) {
    return undefined
  }

  if (isKnownOpenAICodexModel(normalized)) {
    return normalized
  }

  const legacyFamily = resolveLegacyOpenAIModelFamily(normalized)
  if (legacyFamily) {
    return legacyFamily
  }

  if (normalized.startsWith('claude')) {
    return undefined
  }

  return model?.trim()
}

export function getOpenAICodexModelCatalogEntry(
  model: string | undefined,
): OpenAICodexModelCatalogEntry | undefined {
  const normalized = normalizeOpenAICompatibleModel(model)
  if (!normalized || !isKnownOpenAICodexModel(normalized)) {
    return undefined
  }
  return OPENAI_CODEX_MODEL_CATALOG.find(entry => entry.id === normalized)
}

export function getKnownOpenAIContextWindow(
  model: string,
): number | undefined {
  const normalized =
    normalizeOpenAICompatibleModel(model)?.toLowerCase() ||
    model.trim().toLowerCase()
  if (!normalized) {
    return undefined
  }

  if (normalized.startsWith('gpt-5')) {
    return GPT_5_CONTEXT_WINDOW
  }

  if (normalized.startsWith('gpt-oss-')) {
    return GPT_OSS_CONTEXT_WINDOW
  }

  return undefined
}
