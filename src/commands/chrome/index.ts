import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { isClaudeInChromeRuntimeAvailable } from '../../utils/claudeInChrome/setup.js'

const command: Command = {
  name: 'chrome',
  description: 'Claude in Chrome (Beta) settings',
  isEnabled: () =>
    isClaudeInChromeRuntimeAvailable() && !getIsNonInteractiveSession(),
  type: 'local-jsx',
  load: () => import('./chrome.js'),
}

export default command
