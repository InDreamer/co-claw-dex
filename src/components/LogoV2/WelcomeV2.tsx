import React from 'react'
import {
  BRAND_ACCENT_COLOR,
  BRAND_NAME,
  BRAND_SUBTITLE,
  BRAND_TAGLINE,
} from '../../constants/brand.js'
import { Box, Text } from '../../ink.js'
import { Clawd } from './Clawd.js'

const WELCOME_V2_WIDTH = 58
const DIVIDER = '·'.repeat(WELCOME_V2_WIDTH)

export function WelcomeV2(): React.ReactNode {
  return (
    <Box width={WELCOME_V2_WIDTH} flexDirection="column" alignItems="center">
      <Text>
        <Text color={BRAND_ACCENT_COLOR}>{BRAND_NAME} </Text>
        <Text dimColor>v{MACRO.VERSION}</Text>
      </Text>
      <Text color={BRAND_ACCENT_COLOR}>{DIVIDER}</Text>
      <Box marginY={1}>
        <Clawd />
      </Box>
      <Text bold>{BRAND_TAGLINE}</Text>
      <Box marginTop={1}>
        <Text dimColor>{BRAND_SUBTITLE}</Text>
      </Box>
    </Box>
  )
}
