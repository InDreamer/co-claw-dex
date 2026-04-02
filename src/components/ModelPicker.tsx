import capitalize from 'lodash-es/capitalize.js'
import * as React from 'react'
import { useState } from 'react'
import { BRAND_NAME } from 'src/constants/brand.js'
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { isOpenAIResponsesBackendEnabled } from 'src/services/modelBackend/openaiCodexConfig.js'
import {
  FAST_MODE_MODEL_DISPLAY,
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
} from 'src/utils/fastMode.js'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import {
  convertEffortValueToLevel,
  type EffortLevel,
  getCompatibleEffortLevelForModel,
  getDefaultEffortForModel,
  getSupportedEffortLevelsForModel,
  modelSupportsEffort,
  parseEffortValue,
  resolvePickerEffortPersistence,
  toPersistableEffort,
} from '../utils/effort.js'
import {
  getDefaultMainLoopModel,
  type ModelSetting,
  modelDisplayString,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import { getModelOptions } from '../utils/model/modelOptions.js'
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Select } from './CustomSelect/index.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Pane } from './design-system/Pane.js'
import { effortLevelToSymbol } from './EffortIndicator.js'

export type Props = {
  initial: string | null
  sessionModel?: ModelSetting
  onSelect: (model: string | null, effort: EffortLevel | undefined) => void
  onCancel?: () => void
  isStandaloneCommand?: boolean
  showFastModeNotice?: boolean
  headerText?: string
  skipSettingsWrite?: boolean
}

const NO_PREFERENCE = '__NO_PREFERENCE__'

export function ModelPicker({
  initial,
  sessionModel,
  onSelect,
  onCancel,
  isStandaloneCommand,
  showFastModeNotice,
  headerText,
  skipSettingsWrite,
}: Props): React.ReactNode {
  const setAppState = useSetAppState()
  const exitState = useExitOnCtrlCDWithKeybindings()
  const initialValue = initial === null ? NO_PREFERENCE : initial
  const [focusedValue, setFocusedValue] = useState(initialValue)
  const isFastMode = useAppState(s => (isFastModeEnabled() ? s.fastMode : false))
  const [hasToggledEffort, setHasToggledEffort] = useState(false)
  const effortValue = useAppState(s => s.effortValue)
  const [effort, setEffort] = useState<EffortLevel | undefined>(
    effortValue !== undefined ? convertEffortValueToLevel(effortValue) : undefined,
  )

  const modelOptions = getModelOptions(isFastMode ?? false)
  const optionsWithInitial =
    initial !== null && !modelOptions.some(opt => opt.value === initial)
      ? [
          ...modelOptions,
          {
            value: initial,
            label: modelDisplayString(initial),
            description: 'Current model',
          },
        ]
      : modelOptions

  const selectOptions = optionsWithInitial.map(opt => ({
    ...opt,
    value: opt.value === null ? NO_PREFERENCE : opt.value,
  }))
  const initialFocusValue = selectOptions.some(opt => opt.value === initialValue)
    ? initialValue
    : (selectOptions[0]?.value ?? undefined)
  const visibleCount = Math.min(10, selectOptions.length)
  const hiddenCount = Math.max(0, selectOptions.length - visibleCount)
  const focusedModelName = selectOptions.find(
    opt => opt.value === focusedValue,
  )?.label
  const focusedModel = resolveOptionModel(focusedValue)
  const supportedEffortLevels = focusedModel
    ? getSupportedEffortLevelsForModel(focusedModel)
    : []
  const focusedSupportsEffort = supportedEffortLevels.length > 0
  const focusedDefaultEffort = getDefaultEffortLevelForOption(focusedValue)
  const displayEffort =
    (focusedModel
      ? getCompatibleEffortLevelForModel(focusedModel, effort)
      : effort) ?? focusedDefaultEffort

  const handleFocus = (value: string): void => {
    setFocusedValue(value)
    if (!hasToggledEffort && effortValue === undefined) {
      setEffort(getDefaultEffortLevelForOption(value))
    }
  }

  const handleCycleEffort = (direction: 'left' | 'right'): void => {
    if (!focusedSupportsEffort) {
      return
    }
    const currentLevel =
      (focusedModel
        ? getCompatibleEffortLevelForModel(
            focusedModel,
            effort ?? focusedDefaultEffort,
          )
        : effort ?? focusedDefaultEffort) ?? focusedDefaultEffort
    setEffort(cycleEffortLevel(currentLevel, direction, supportedEffortLevels))
    setHasToggledEffort(true)
  }

  useKeybindings(
    {
      'modelPicker:decreaseEffort': () => handleCycleEffort('left'),
      'modelPicker:increaseEffort': () => handleCycleEffort('right'),
    },
    { context: 'ModelPicker' },
  )

  const handleSelect = (value: string): void => {
    logEvent('tengu_model_command_menu_effort', {
      effort: effort as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    if (!skipSettingsWrite) {
      const priorPersisted = getPersistedEffortLevel()
      const effortLevel = resolvePickerEffortPersistence(
        effort,
        getDefaultEffortLevelForOption(value),
        priorPersisted,
        hasToggledEffort,
      )
      const persistable = toPersistableEffort(effortLevel)
      if (persistable !== undefined) {
        updateSettingsForSource('userSettings', {
          effortLevel: persistable,
        })
      }
      setAppState(prev => ({
        ...prev,
        effortValue: effortLevel,
      }))
    }

    const selectedModel = resolveOptionModel(value)
    const selectedEffort =
      hasToggledEffort && selectedModel && modelSupportsEffort(selectedModel)
        ? getCompatibleEffortLevelForModel(selectedModel, effort)
        : undefined

    if (value === NO_PREFERENCE) {
      onSelect(null, selectedEffort)
      return
    }
    onSelect(value, selectedEffort)
  }

  const pickerHeader =
    headerText ??
    (isOpenAIResponsesBackendEnabled()
      ? `Switch between Codex models. Applies to this session and future ${BRAND_NAME} sessions. For other model names, specify with --model.`
      : 'Switch between Claude models. Applies to this session and future Claude Code sessions. For other/previous model names, specify with --model.')

  const content = (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color="remember" bold>
          Select model
        </Text>
        <Text dimColor>{pickerHeader}</Text>
        {sessionModel ? (
          <Text dimColor>
            Currently using {modelDisplayString(sessionModel)} for this session
            {' '}(
            set by plan mode). Selecting a model will clear that override.
          </Text>
        ) : null}
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="column">
          <Select
            defaultValue={initialValue}
            defaultFocusValue={initialFocusValue}
            options={selectOptions}
            onChange={handleSelect}
            onFocus={handleFocus}
            onCancel={onCancel ?? (() => {})}
            visibleOptionCount={visibleCount}
          />
        </Box>
        {hiddenCount > 0 ? (
          <Box paddingLeft={3}>
            <Text dimColor>and {hiddenCount} more...</Text>
          </Box>
        ) : null}
      </Box>

      <Box marginBottom={1} flexDirection="column">
        {focusedSupportsEffort ? (
          <Text dimColor>
            <EffortLevelIndicator effort={displayEffort} />{' '}
            {formatEffortLabel(displayEffort)} effort
            {displayEffort === focusedDefaultEffort ? ' (default)' : ''}{' '}
            <Text color="subtle">{supportedEffortHint(supportedEffortLevels)}</Text>
          </Text>
        ) : (
          <Text color="subtle">
            <EffortLevelIndicator effort={undefined} /> Effort not supported
            {focusedModelName ? ` for ${focusedModelName}` : ''}
          </Text>
        )}
      </Box>

      {isFastModeEnabled() ? (
        showFastModeNotice ? (
          <Box marginBottom={1}>
            <Text dimColor>
              Fast mode is <Text bold>ON</Text> and available with{' '}
              {FAST_MODE_MODEL_DISPLAY} only (/fast). Switching to other models
              {' '}turn off fast mode.
            </Text>
          </Box>
        ) : isFastModeAvailable() && !isFastModeCooldown() ? (
          <Box marginBottom={1}>
            <Text dimColor>
              Use <Text bold>/fast</Text> to turn on Fast mode (
              {FAST_MODE_MODEL_DISPLAY} only).
            </Text>
          </Box>
        ) : null
      ) : null}

      {isStandaloneCommand ? (
        <Text dimColor italic>
          {exitState.pending ? (
            <>Press {exitState.keyName} again to exit</>
          ) : (
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="select:cancel"
                context="Select"
                fallback="Esc"
                description="exit"
              />
            </Byline>
          )}
        </Text>
      ) : null}
    </Box>
  )

  if (!isStandaloneCommand) {
    return content
  }

  return <Pane color="permission">{content}</Pane>
}

function getPersistedEffortLevel(): EffortLevel | undefined {
  const persisted = getSettingsForSource('userSettings')?.effortLevel
  const parsed = parseEffortValue(persisted)
  return typeof parsed === 'string' ? parsed : undefined
}

function resolveOptionModel(value?: string): string | undefined {
  if (!value) return undefined
  return value === NO_PREFERENCE
    ? getDefaultMainLoopModel()
    : parseUserSpecifiedModel(value)
}

function EffortLevelIndicator({
  effort,
}: {
  effort: EffortLevel | undefined
}): React.ReactNode {
  return <Text color={effort ? 'claude' : 'subtle'}>{effortLevelToSymbol(effort ?? 'low')}</Text>
}

function cycleEffortLevel(
  current: EffortLevel,
  direction: 'left' | 'right',
  levels: readonly EffortLevel[],
): EffortLevel {
  if (levels.length === 0) {
    return current
  }
  const idx = levels.indexOf(current)
  const fallbackLevel = levels.includes('high')
    ? 'high'
    : levels[levels.length - 1]!
  const currentIndex = idx !== -1 ? idx : levels.indexOf(fallbackLevel)
  if (direction === 'right') {
    return levels[(currentIndex + 1) % levels.length]!
  }
  return levels[(currentIndex - 1 + levels.length) % levels.length]!
}

function supportedEffortHint(levels: readonly EffortLevel[]): string {
  if (levels.length <= 1) {
    return ''
  }
  return `(${levels.map(formatEffortLabel).join(' / ')} · ← → to adjust)`
}

function formatEffortLabel(level?: EffortLevel): string {
  if (!level) return 'Low'
  if (level === 'xhigh') return 'XHigh'
  return capitalize(level)
}

function getDefaultEffortLevelForOption(value?: string): EffortLevel {
  const resolved = resolveOptionModel(value) ?? getDefaultMainLoopModel()
  const defaultValue = getDefaultEffortForModel(resolved)
  return defaultValue !== undefined
    ? convertEffortValueToLevel(defaultValue)
    : 'high'
}
