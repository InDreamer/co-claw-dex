// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isUltrathinkEnabled } from './thinking.js'
import { getInitialSettings } from './settings/settings.js'
import { isProSubscriber, isMaxSubscriber, isTeamSubscriber } from './auth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import {
  getOpenAICodexModelCatalogEntry,
  getOpenAICodexSupportedEffortLevels,
} from '../services/modelBackend/openaiModelCatalog.js'
import {
  isOpenAIResponsesBackendEnabled,
  resolveOpenAIReasoningEffort,
} from '../services/modelBackend/openaiCodexConfig.js'
import { getAPIProvider } from './model/providers.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { isEnvTruthy } from './envUtils.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'

export type { EffortLevel }

export const EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly EffortLevel[]

export const LEGACY_EFFORT_LEVELS = [...EFFORT_LEVELS, 'max'] as const

export type EffortValue = EffortLevel | number

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports the effort parameter.
export function modelSupportsEffort(model: string): boolean {
  const m = model.toLowerCase()
  if (isOpenAIResponsesBackendEnabled() && getOpenAICodexModelCatalogEntry(model)) {
    return true
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  const supported3P = get3PModelCapabilityOverride(model, 'effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  // Supported by a subset of Claude 4 models
  if (m.includes('opus-4-6') || m.includes('sonnet-4-6')) {
    return true
  }
  // Exclude any other known legacy models (haiku, older opus/sonnet variants)
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return false
  }

  // IMPORTANT: Do not change the default effort support without notifying
  // the model launch DRI and research. This is a sensitive setting that can
  // greatly affect model quality and bashing.

  // Default to true for unknown model strings on 1P.
  // Do not default to true for 3P as they have different formats for their
  // model strings (ex. anthropics/claude-code#30795)
  return getAPIProvider() === 'firstParty'
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports 'xhigh' effort.
export function modelSupportsXHighEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'max_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  const openAIModel = isOpenAIResponsesBackendEnabled()
    ? getOpenAICodexModelCatalogEntry(model)
    : undefined
  if (openAIModel) {
    return openAIModel.supportedEffortLevels.includes('xhigh')
  }
  if (model.toLowerCase().includes('opus-4-6')) {
    return true
  }
  if (process.env.USER_TYPE === 'ant' && resolveAntModel(model)) {
    return true
  }
  return false
}

export const modelSupportsMaxEffort = modelSupportsXHighEffort

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase()
  if (str === 'max') {
    return 'xhigh'
  }
  if (str === 'minimal') {
    return 'minimal'
  }
  if (isEffortLevel(str)) {
    return str
  }
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * Numeric values are model-default only and not persisted.
 * Legacy 'max' is normalized to 'xhigh' before persistence.
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  if (typeof value === 'string') {
    const parsed = parseEffortValue(value)
    return typeof parsed === 'string' ? parsed : undefined
  }
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  const parsed = parseEffortValue(getInitialSettings().effortLevel)
  return typeof parsed === 'string' ? parsed : undefined
}

/**
 * Decide what effort level (if any) to persist when the user selects a model
 * in ModelPicker. Keeps an explicit prior /effort choice sticky even when it
 * matches the picked model's default, while letting purely-default and
 * session-ephemeral effort (CLI --effort, EffortCallout default) fall through
 * to undefined so it follows future model-default changes.
 *
 * priorPersisted must come from userSettings on disk
 * (getSettingsForSource('userSettings')?.effortLevel), NOT merged settings
 * (project/policy layers would leak into the user's global settings.json)
 * and NOT AppState.effortValue (includes session-scoped sources that
 * deliberately do not write to settings.json).
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
  return envOverride?.toLowerCase() === 'unset' ||
    envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

/**
 * Resolve the effort value that will actually be sent to the API for a given
 * model, following the full precedence chain:
 *   env CLAUDE_CODE_EFFORT_LEVEL → appState.effortValue → model default
 *
 * Returns undefined when no effort parameter should be sent (env set to
 * 'unset', or no default exists for the model).
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const providerDefaultEffort =
    appStateEffortValue === undefined &&
    isOpenAIResponsesBackendEnabled() &&
    getOpenAICodexModelCatalogEntry(model)
      ? resolveOpenAIReasoningEffort()
      : undefined
  const resolved =
    envOverride ??
    appStateEffortValue ??
    providerDefaultEffort ??
    getDefaultEffortForModel(model)
  return resolveCompatibleEffortForModel(model, resolved)
}

/**
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar and /effort output (CC-1088).
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

/**
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Returns empty string if the user hasn't explicitly set an effort value.
 * Delegates to resolveAppliedEffort() so the displayed level matches what
 * the API actually receives (including max→high clamp for non-Opus models).
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) return ''
  return ` with ${convertEffortValueToLevel(resolved)} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // Runtime guard: value may come from remote config (GrowthBook) where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    if (value === 'max') return 'xhigh'
    return isEffortLevel(value) ? value : 'high'
  }
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    if (value <= 50) return 'low'
    if (value <= 85) return 'medium'
    if (value <= 100) return 'high'
    return 'xhigh'
  }
  return 'high'
}

/**
 * Get user-facing description for effort levels
 *
 * @param level The effort level to describe
 * @returns Human-readable description
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'none':
      return 'Minimal reasoning for the fastest possible response'
    case 'minimal':
      return 'Fastest reasoning mode that still keeps a small planning budget'
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'xhigh':
      return 'Maximum reasoning depth for the hardest tasks'
  }
}

/**
 * Get user-facing description for effort values (both string and numeric)
 *
 * @param value The effort value to describe
 * @returns Human-readable description
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    return `[ANT-ONLY] Numeric effort value of ${value}`
  }

  if (typeof value === 'string') {
    return getEffortLevelDescription(value)
  }
  return 'Balanced approach with standard implementation and testing'
}

export type OpusDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT: OpusDefaultEffortConfig = {
  enabled: true,
  dialogTitle: 'We recommend medium effort by default',
  dialogDescription:
    'Effort determines how long the model reasons before responding. We recommend medium effort for most tasks to balance speed, quality, and rate limits. Use ultrathink to trigger high effort when needed.',
}

export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  const config = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_grey_step2',
    OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
  )
  return {
    ...OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
    ...config,
  }
}

// @[MODEL LAUNCH]: Update the default effort levels for new models
export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  if (process.env.USER_TYPE === 'ant') {
    const config = getAntModelOverrideConfig()
    const isDefaultModel =
      config?.defaultModel !== undefined &&
      model.toLowerCase() === config.defaultModel.toLowerCase()
    if (isDefaultModel && config?.defaultModelEffortLevel) {
      return config.defaultModelEffortLevel
    }
    const antModel = resolveAntModel(model)
    if (antModel) {
      if (antModel.defaultEffortLevel) {
        return antModel.defaultEffortLevel
      }
      if (antModel.defaultEffortValue !== undefined) {
        return antModel.defaultEffortValue
      }
    }
    // Always default ants to undefined/high
    return undefined
  }

  const openAIModel = isOpenAIResponsesBackendEnabled()
    ? getOpenAICodexModelCatalogEntry(model)
    : undefined
  if (openAIModel) {
    return openAIModel.defaultEffort
  }

  // IMPORTANT: Do not change the default effort level without notifying
  // the model launch DRI and research. Default effort is a sensitive setting
  // that can greatly affect model quality and bashing.

  // Default effort on Opus 4.6 to medium for Pro.
  // Max/Team also get medium when the tengu_grey_step2 config is enabled.
  if (model.toLowerCase().includes('opus-4-6')) {
    if (isProSubscriber()) {
      return 'medium'
    }
    if (
      getOpusDefaultEffortConfig().enabled &&
      (isMaxSubscriber() || isTeamSubscriber())
    ) {
      return 'medium'
    }
  }

  // When ultrathink feature is on, default effort to medium (ultrathink bumps to high)
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }

  // Fallback to undefined, which means we don't set an effort level. This
  // should resolve to high effort level in the API.
  return undefined
}

export function getSupportedEffortLevelsForModel(
  model: string,
): readonly EffortLevel[] {
  const openAILevels = isOpenAIResponsesBackendEnabled()
    ? getOpenAICodexSupportedEffortLevels(model)
    : undefined
  if (openAILevels) {
    return openAILevels as readonly EffortLevel[]
  }
  if (!modelSupportsEffort(model)) {
    return []
  }
  return modelSupportsXHighEffort(model)
    ? ['none', 'low', 'medium', 'high', 'xhigh']
    : ['none', 'low', 'medium', 'high']
}

export function getCompatibleEffortLevelForModel(
  model: string,
  effort: EffortLevel | undefined,
): EffortLevel | undefined {
  const resolved = resolveCompatibleEffortForModel(model, effort)
  return typeof resolved === 'string' ? convertEffortValueToLevel(resolved) : undefined
}

function resolveCompatibleEffortForModel(
  model: string,
  effort: EffortValue | undefined,
): EffortValue | undefined {
  if (effort === undefined || typeof effort === 'number') {
    return effort
  }

  const openAIModel = isOpenAIResponsesBackendEnabled()
    ? getOpenAICodexModelCatalogEntry(model)
    : undefined
  if (openAIModel) {
    if (openAIModel.supportedEffortLevels.includes(effort)) {
      return effort
    }
    if (
      (effort === 'minimal' || effort === 'none') &&
      openAIModel.supportedEffortLevels.includes('none')
    ) {
      return 'none'
    }
    if (
      (effort === 'minimal' || effort === 'none') &&
      openAIModel.supportedEffortLevels.includes('minimal')
    ) {
      return 'minimal'
    }
    if (
      (effort === 'minimal' || effort === 'none') &&
      openAIModel.supportedEffortLevels.includes('low')
    ) {
      return 'low'
    }
    if (
      effort === 'xhigh' &&
      openAIModel.supportedEffortLevels.includes('high')
    ) {
      return 'high'
    }
    return openAIModel.defaultEffort
  }

  if (effort === 'minimal') {
    return 'low'
  }
  if (effort === 'xhigh' && !modelSupportsXHighEffort(model)) {
    return 'high'
  }
  return effort
}
