import React, { useEffect } from 'react'
import { homedir } from 'os'
import { join } from 'path'
import { Box, Text } from '../../ink.js'

type NewInstallWizardProps = {
  defaultDir: string
  onInstalled: (dir: string) => void
  onCancel: () => void
  onError: (message: string) => void
}

export async function computeDefaultInstallDir(): Promise<string> {
  return join(homedir(), '.claude-assistant')
}

export function NewInstallWizard({
  defaultDir,
  onCancel,
}: NewInstallWizardProps): React.ReactNode {
  useEffect(() => {
    onCancel()
  }, [onCancel])

  return (
    <Box flexDirection="column">
      <Text dimColor>Assistant install wizard is unavailable.</Text>
      <Text dimColor>{defaultDir}</Text>
    </Box>
  )
}
