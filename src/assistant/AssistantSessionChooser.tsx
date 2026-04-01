import React, { useEffect } from 'react'
import { Box, Text } from '../ink.js'

type SessionLike = {
  id?: string
}

type Props = {
  sessions: SessionLike[]
  onSelect: (id: string) => void
  onCancel: () => void
}

export function AssistantSessionChooser({
  sessions,
  onCancel,
}: Props): React.ReactNode {
  useEffect(() => {
    onCancel()
  }, [onCancel])

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Assistant session chooser is unavailable in this build.
      </Text>
      <Text dimColor>{`sessions: ${sessions.length}`}</Text>
    </Box>
  )
}
