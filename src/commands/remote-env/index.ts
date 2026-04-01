import type { Command } from '../../commands.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { isOpenAIResponsesBackendEnabled } from '../../services/modelBackend/openaiCodexConfig.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'

export default {
  type: 'local-jsx',
  name: 'remote-env',
  description: 'Configure the default remote environment for teleport sessions',
  isEnabled: () =>
    !isOpenAIResponsesBackendEnabled() &&
    isClaudeAISubscriber() &&
    isPolicyAllowed('allow_remote_sessions'),
  get isHidden() {
    return (
      isOpenAIResponsesBackendEnabled() ||
      !isClaudeAISubscriber() ||
      !isPolicyAllowed('allow_remote_sessions')
    )
  },
  load: () => import('./remote-env.js'),
} satisfies Command
