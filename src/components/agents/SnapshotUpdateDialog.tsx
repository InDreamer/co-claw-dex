import React, { useEffect } from 'react'
import { Box, Text } from '../../ink.js'

type Props = {
  agentType: string
  scope: string
  snapshotTimestamp: string
  onComplete: (choice: 'merge' | 'keep' | 'replace') => void
  onCancel: () => void
}

export function SnapshotUpdateDialog({
  agentType,
  scope,
  snapshotTimestamp,
  onCancel,
}: Props): React.ReactNode {
  useEffect(() => {
    onCancel()
  }, [onCancel])

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Snapshot updates are unavailable in this build.
      </Text>
      <Text dimColor>{`${agentType}:${scope}:${snapshotTimestamp}`}</Text>
    </Box>
  )
}
