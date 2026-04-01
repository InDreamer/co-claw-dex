import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { parseEffortValue } from '../effort.js'
import { updateHooksConfigSnapshot } from '../hooks/hooksConfigSnapshot.js'
import {
  createDisabledBypassPermissionsContext,
  findOverlyBroadBashPermissions,
  isBypassPermissionsModeDisabled,
  removeDangerousPermissions,
  transitionPlanAutoMode,
} from '../permissions/permissionSetup.js'
import { syncPermissionRulesFromDisk } from '../permissions/permissions.js'
import { loadAllPermissionRulesFromDisk } from '../permissions/permissionsLoader.js'
import type { SettingSource } from './constants.js'
import { getInitialSettings } from './settings.js'

/**
 * Apply a settings change to app state. Re-reads settings from disk,
 * reloads permissions and hooks, and pushes the new state.
 *
 * Used by both the interactive path (AppState.tsx via useSettingsChange) and
 * the headless/SDK path (print.ts direct subscribe) so that managed-settings
 * / policy changes are fully applied in both modes.
 *
 * The settings cache is reset by the notifier (changeDetector.fanOut) before
 * listeners are iterated, so getInitialSettings() here reads fresh disk
 * state. Previously this function reset the cache itself, which — combined
 * with useSettingsChange's own reset — caused N disk reloads per notification
 * for N subscribers.
 *
 * Side-effects like clearing auth caches and applying env vars are handled by
 * `onChangeAppState` which fires when `settings` changes in state.
 */
export function applySettingsChange(
  source: SettingSource,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  const newSettings = getInitialSettings()

  logForDebugging(`Settings changed from ${source}, updating app state`)

  const updatedRules = loadAllPermissionRulesFromDisk()
  updateHooksConfigSnapshot()

  setAppState(prev => {
    let newContext = syncPermissionRulesFromDisk(
      prev.toolPermissionContext,
      updatedRules,
    )

    // Ant-only: re-strip overly broad Bash allow rules after settings sync
    if (
      process.env.USER_TYPE === 'ant' &&
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent'
    ) {
      const overlyBroad = findOverlyBroadBashPermissions(updatedRules, [])
      if (overlyBroad.length > 0) {
        newContext = removeDangerousPermissions(newContext, overlyBroad)
      }
    }

    if (
      newContext.isBypassPermissionsModeAvailable &&
      isBypassPermissionsModeDisabled()
    ) {
      newContext = createDisabledBypassPermissionsContext(newContext)
    }

    newContext = transitionPlanAutoMode(newContext)

    // Sync effortLevel from settings to top-level AppState when it changes
    // (e.g. via applyFlagSettings from IDE). Only propagate if the setting
    // itself changed — otherwise unrelated settings churn (e.g. tips dismissal
    // on startup) would clobber a --effort CLI flag value held in AppState.
    const prevEffort = prev.settings.effortLevel
    const newEffort = newSettings.effortLevel
    const effortChanged = prevEffort !== newEffort
    const prevParsedEffort = parseEffortValue(prevEffort)
    const parsedEffort = parseEffortValue(newEffort)
    const previousNormalizedEffort =
      typeof prevParsedEffort === 'string' ? prevParsedEffort : undefined
    const normalizedEffort =
      typeof parsedEffort === 'string' ? parsedEffort : undefined
    const shouldClearEffortValue =
      effortChanged &&
      normalizedEffort === undefined &&
      prev.effortValue === previousNormalizedEffort

    return {
      ...prev,
      settings: newSettings,
      toolPermissionContext: newContext,
      // Propagate a defined disk value immediately. When the disk key is
      // removed, only clear AppState.effortValue if it was previously sourced
      // from the same persisted setting; this preserves session-scoped
      // overrides such as --effort while still letting external settings edits
      // clear the active effort when appropriate.
      ...(effortChanged && normalizedEffort !== undefined
        ? { effortValue: normalizedEffort }
        : shouldClearEffortValue
          ? { effortValue: undefined }
          : {}),
    }
  })
}
