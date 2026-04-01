import * as React from 'react'
import { BRAND_MASCOT_COLOR } from '../../constants/brand.js'
import { Box, Text } from '../../ink.js'

export type ClawdPose =
  | 'default'
  | 'arms-up'
  | 'look-left'
  | 'look-right'

const MASCOT_LINES: Record<ClawdPose, string[]> = {
  default: [
    '  █                   ',
    '    █                 ',
    '      █    ████       ',
    '    █                 ',
    '  █                   ',
  ],
  'look-left': [
    '  █                   ',
    '    █                 ',
    '      █    ████       ',
    '    █                 ',
    '  █                   ',
  ],
  'look-right': [
    '  █                   ',
    '    █                 ',
    '      █    ████       ',
    '    █                 ',
    '  █                   ',
  ],
  'arms-up': [
    '  █                   ',
    '    █                 ',
    '      █    ████       ',
    '    █                 ',
    '  █                   ',
  ],
}

export function Clawd({
  pose = 'default',
}: {
  pose?: ClawdPose
}): React.ReactNode {
  return (
    <Box flexDirection="column" alignItems="center">
      {MASCOT_LINES[pose].map((line, index) => (
        <Text
          key={`${pose}-${index}`}
          color={BRAND_MASCOT_COLOR}
          dim={index === MASCOT_LINES[pose].length - 1}
        >
          {line}
        </Text>
      ))}
    </Box>
  )
}
