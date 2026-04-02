const GPT_5_4_CONTEXT_WINDOW = 1_000_000
const GPT_5_CONTEXT_WINDOW = 272_000
const GPT_OSS_CONTEXT_WINDOW = 128_000

export const OPENAI_CODEX_MODEL_IDS = [
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5-mini',
] as const

export type OpenAICodexModelId = (typeof OPENAI_CODEX_MODEL_IDS)[number]

export type OpenAICodexModelCatalogEntry = {
  id: OpenAICodexModelId
  label: string
  description: string
  defaultEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  supportedEffortLevels: readonly (
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
  )[]
}

const OPENAI_CODEX_MODEL_CATALOG: readonly OpenAICodexModelCatalogEntry[] = [
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    description:
      'Recommended default for coding, planning, and broader general-purpose work',
    defaultEffort: 'none',
    supportedEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description:
      'Strongest mini model for coding, computer use, and helper/subagent work',
    defaultEffort: 'none',
    supportedEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    description:
      'Coding-specialized alternative optimized for agentic coding tasks',
    defaultEffort: 'medium',
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.2',
    label: 'GPT-5.2',
    description:
      'Previous frontier general-purpose model for preserving older GPT-5.2 behavior',
    defaultEffort: 'none',
    supportedEffortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.2-codex',
    label: 'GPT-5.2 Codex',
    description:
      'Previous Codex-tuned coding model for agentic coding workflows',
    defaultEffort: 'medium',
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5-mini',
    label: 'GPT-5 Mini',
    description:
      'Small GPT-5 model for helper agents, routing, and lightweight tasks',
    defaultEffort: 'medium',
    supportedEffortLevels: ['minimal', 'low', 'medium', 'high'],
  },
] as const

const OPENAI_LEGACY_MODEL_ALIASES: Record<string, OpenAICodexModelId> = {
  best: 'gpt-5.4',
  opus: 'gpt-5.4',
  'opus[1m]': 'gpt-5.4',
  opusplan: 'gpt-5.4',
  sonnet: 'gpt-5.2',
  'sonnet[1m]': 'gpt-5.2',
  haiku: 'gpt-5-mini',
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
  return undefined
}

export function normalizeOpenAICompatibleModel(
  model: string | undefined,
): string | undefined {
  const normalized = normalizeOpenAIModelString(model)
  if (!normalized) {
    return undefined
  }

  if (normalized.startsWith('claude')) {
    return undefined
  }

  if (isKnownOpenAICodexModel(normalized)) {
    return normalized
  }

  const legacyFamily = resolveLegacyOpenAIModelFamily(normalized)
  if (legacyFamily) {
    return legacyFamily
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

export function getOpenAICodexSupportedEffortLevels(
  model: string | undefined,
):
  | readonly ('none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh')[]
  | undefined {
  return getOpenAICodexModelCatalogEntry(model)?.supportedEffortLevels
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

  // Current official docs explicitly call out GPT-5.4 and GPT-5.4 pro as the
  // 1M-context GPT-5 family variants.
  if (
    normalized === 'gpt-5.4' ||
    normalized === 'gpt-5.4-pro' ||
    /^gpt-5\.4-\d{4}-\d{2}-\d{2}$/.test(normalized) ||
    /^gpt-5\.4-pro-\d{4}-\d{2}-\d{2}$/.test(normalized)
  ) {
    return GPT_5_4_CONTEXT_WINDOW
  }

  if (normalized.startsWith('gpt-5')) {
    return GPT_5_CONTEXT_WINDOW
  }

  if (normalized.startsWith('gpt-oss-')) {
    return GPT_OSS_CONTEXT_WINDOW
  }

  return undefined
}
