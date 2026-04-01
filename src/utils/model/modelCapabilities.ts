import { readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import isEqual from 'lodash-es/isEqual.js'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { z } from 'zod/v4'
import { OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { getAnthropicClient } from '../../services/api/client.js'
import {
  isOpenAIResponsesBackendEnabled,
  resolveOpenAIConfiguredContextWindow,
  resolveOpenAIModel,
} from '../../services/modelBackend/openaiCodexConfig.js'
import { fetchOpenAIJson } from '../../services/modelBackend/openaiApi.js'
import { getKnownOpenAIContextWindow } from '../../services/modelBackend/openaiModelCatalog.js'
import type { OpenAIModelListResponse } from '../../services/modelBackend/openaiResponsesTypes.js'
import { isClaudeAISubscriber } from '../auth.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { safeParseJSON } from '../json.js'
import { lazySchema } from '../lazySchema.js'
import { isEssentialTrafficOnly } from '../privacyLevel.js'
import { jsonStringify } from '../slowOperations.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'

// .strip() — don't persist internal-only fields (mycro_deployments etc.) to disk
const ModelCapabilitySchema = lazySchema(() =>
  z
    .object({
      id: z.string(),
      max_input_tokens: z.number().optional(),
      max_tokens: z.number().optional(),
    })
    .strip(),
)

const CacheFileSchema = lazySchema(() =>
  z.object({
    models: z.array(ModelCapabilitySchema()),
    timestamp: z.number(),
  }),
)

export type ModelCapability = z.infer<ReturnType<typeof ModelCapabilitySchema>>

function getCacheDir(): string {
  return join(getClaudeConfigHomeDir(), 'cache')
}

function getCachePath(): string {
  return join(getCacheDir(), 'model-capabilities.json')
}

function isModelCapabilitiesEligible(): boolean {
  if (isOpenAIResponsesBackendEnabled()) return true
  if (process.env.USER_TYPE !== 'ant') return false
  if (getAPIProvider() !== 'firstParty') return false
  if (!isFirstPartyAnthropicBaseUrl()) return false
  return true
}

// Longest-id-first so substring match prefers most specific; secondary key for stable isEqual
function sortForMatching(models: ModelCapability[]): ModelCapability[] {
  return [...models].sort(
    (a, b) => b.id.length - a.id.length || a.id.localeCompare(b.id),
  )
}

// Keyed on cache path so tests that set CLAUDE_CONFIG_DIR get a fresh read
const loadCache = memoize(
  (path: string): ModelCapability[] | null => {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- memoized; called from sync getContextWindowForModel
      const raw = readFileSync(path, 'utf-8')
      const parsed = CacheFileSchema().safeParse(safeParseJSON(raw, false))
      return parsed.success ? parsed.data.models : null
    } catch {
      return null
    }
  },
  path => path,
)

function findMatchingModelCapability(
  models: ModelCapability[],
  model: string,
): ModelCapability | undefined {
  const normalizedModel = model.toLowerCase()
  const exact = models.find(c => c.id.toLowerCase() === normalizedModel)
  if (exact) return exact
  return models.find(c => normalizedModel.includes(c.id.toLowerCase()))
}

function getConfiguredOpenAIModelCapability(
  model: string,
): ModelCapability | undefined {
  const normalizedModel = resolveOpenAIModel(model)
  const maxInputTokens =
    resolveOpenAIConfiguredContextWindow(normalizedModel) ??
    getKnownOpenAIContextWindow(normalizedModel)

  if (!maxInputTokens) {
    return undefined
  }

  return {
    id: normalizedModel,
    max_input_tokens: maxInputTokens,
  }
}

async function writeModelCapabilitiesCache(
  models: ModelCapability[],
): Promise<void> {
  const path = getCachePath()
  const sortedModels = sortForMatching(models)
  if (isEqual(loadCache(path), sortedModels)) {
    logForDebugging('[modelCapabilities] cache unchanged, skipping write')
    return
  }

  await mkdir(getCacheDir(), { recursive: true })
  await writeFile(path, jsonStringify({ models: sortedModels, timestamp: Date.now() }), {
    encoding: 'utf-8',
    mode: 0o600,
  })
  loadCache.cache.delete(path)
  logForDebugging(`[modelCapabilities] cached ${sortedModels.length} models`)
}

async function refreshOpenAIModelCapabilities(): Promise<void> {
  const payload = await fetchOpenAIJson<OpenAIModelListResponse>('/models')
  const discoveredModels = (payload.data ?? [])
    .map(entry => {
      const maxInputTokens =
        resolveOpenAIConfiguredContextWindow(entry.id) ??
        getKnownOpenAIContextWindow(entry.id)

      const capability: ModelCapability = { id: entry.id }
      if (maxInputTokens) {
        capability.max_input_tokens = maxInputTokens
      }
      return capability
    })
    .filter(model => model.id.trim().length > 0)

  const configuredModel = getConfiguredOpenAIModelCapability(resolveOpenAIModel(''))
  const mergedModels = configuredModel
    ? discoveredModels.some(model => model.id === configuredModel.id)
      ? discoveredModels.map(model =>
          model.id === configuredModel.id ? { ...model, ...configuredModel } : model,
        )
      : [...discoveredModels, configuredModel]
    : discoveredModels

  if (mergedModels.length === 0) return
  await writeModelCapabilitiesCache(mergedModels)
}

export function getModelCapability(model: string): ModelCapability | undefined {
  if (!isModelCapabilitiesEligible()) return undefined
  const cached = loadCache(getCachePath())

  if (isOpenAIResponsesBackendEnabled()) {
    const configured = getConfiguredOpenAIModelCapability(model)
    if ((!cached || cached.length === 0) && configured) {
      return configured
    }

    const merged = [
      ...(cached ?? []),
      ...(configured &&
      !(cached ?? []).some(
        entry => entry.id.toLowerCase() === configured.id.toLowerCase(),
      )
        ? [configured]
        : []),
    ]
    return merged.length > 0
      ? findMatchingModelCapability(merged, model)
      : undefined
  }

  if (!cached || cached.length === 0) return undefined
  return findMatchingModelCapability(cached, model)
}

export async function refreshModelCapabilities(): Promise<void> {
  if (!isModelCapabilitiesEligible()) return
  if (isEssentialTrafficOnly()) return

  try {
    if (isOpenAIResponsesBackendEnabled()) {
      await refreshOpenAIModelCapabilities()
      return
    }

    const anthropic = await getAnthropicClient({ maxRetries: 1 })
    const betas = isClaudeAISubscriber() ? [OAUTH_BETA_HEADER] : undefined
    const parsed: ModelCapability[] = []
    for await (const entry of anthropic.models.list({ betas })) {
      const result = ModelCapabilitySchema().safeParse(entry)
      if (result.success) parsed.push(result.data)
    }
    if (parsed.length === 0) return

    await writeModelCapabilitiesCache(parsed)
  } catch (error) {
    logForDebugging(
      `[modelCapabilities] fetch failed: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  }
}
