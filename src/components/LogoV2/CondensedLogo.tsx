import * as React from 'react'
import { useEffect } from 'react'
import { BRAND_ACCENT_COLOR, BRAND_NAME } from '../../constants/brand.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { getEffortSuffix } from '../../utils/effort.js'
import {
  formatModelAndBilling,
  getLogoDisplayData,
  truncatePath,
} from '../../utils/logoV2Utils.js'
import { renderModelSetting } from '../../utils/model/model.js'
import { OffscreenFreeze } from '../OffscreenFreeze.js'
import { Clawd } from './Clawd.js'
import {
  GuestPassesUpsell,
  incrementGuestPassesSeenCount,
  useShowGuestPassesUpsell,
} from './GuestPassesUpsell.js'
import {
  OverageCreditUpsell,
  incrementOverageCreditUpsellSeenCount,
  useShowOverageCreditUpsell,
} from './OverageCreditUpsell.js'

export function CondensedLogo(): React.ReactNode {
  const { columns } = useTerminalSize()
  const agent = useAppState(s => s.agent)
  const effortValue = useAppState(s => s.effortValue)
  const model = useMainLoopModel()
  const modelDisplayName = renderModelSetting(model)
  const {
    version,
    cwd,
    billingType,
    agentName: agentNameFromSettings,
  } = getLogoDisplayData()
  const agentName = agent ?? agentNameFromSettings
  const showGuestPassesUpsell = useShowGuestPassesUpsell()
  const showOverageCreditUpsell = useShowOverageCreditUpsell()

  useEffect(() => {
    if (showGuestPassesUpsell) {
      incrementGuestPassesSeenCount()
    }
  }, [showGuestPassesUpsell])

  useEffect(() => {
    if (showOverageCreditUpsell && !showGuestPassesUpsell) {
      incrementOverageCreditUpsellSeenCount()
    }
  }, [showGuestPassesUpsell, showOverageCreditUpsell])

  const textWidth = Math.max(columns - 15, 20)
  const effortSuffix = getEffortSuffix(model, effortValue)
  const { shouldSplit, truncatedModel, truncatedBilling } =
    formatModelAndBilling(modelDisplayName + effortSuffix, billingType, textWidth)
  const cwdAvailableWidth = agentName
    ? textWidth - 1 - stringWidth(agentName) - 3
    : textWidth
  const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10))
  const pathLine = agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd

  return (
    <OffscreenFreeze>
      <Box flexDirection="row" gap={2} alignItems="center">
        <Clawd />
        <Box flexDirection="column">
          <Text bold>
            <Text color={BRAND_ACCENT_COLOR}>{BRAND_NAME}</Text>{' '}
            <Text dimColor>v{version}</Text>
          </Text>
          {shouldSplit ? (
            <>
              <Text dimColor>{truncatedModel}</Text>
              <Text dimColor>{truncatedBilling}</Text>
            </>
          ) : (
            <Text dimColor>
              {truncatedModel} · {truncatedBilling}
            </Text>
          )}
          <Text dimColor>{pathLine}</Text>
          {showGuestPassesUpsell ? <GuestPassesUpsell /> : null}
          {!showGuestPassesUpsell && showOverageCreditUpsell ? (
            <OverageCreditUpsell maxWidth={textWidth} twoLine />
          ) : null}
        </Box>
      </Box>
    </OffscreenFreeze>
  )
}
