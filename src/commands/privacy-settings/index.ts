import type { Command } from '../../commands.js'
import { isOpenAIResponsesBackendEnabled } from '../../services/modelBackend/openaiCodexConfig.js'
import { isConsumerSubscriber } from '../../utils/auth.js'

const privacySettings = {
  type: 'local-jsx',
  name: 'privacy-settings',
  description: 'View and update your privacy settings',
  isEnabled: () => {
    return !isOpenAIResponsesBackendEnabled() && isConsumerSubscriber()
  },
  load: () => import('./privacy-settings.js'),
} satisfies Command

export default privacySettings
