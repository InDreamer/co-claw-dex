import type { Command } from '../../commands.js'
import { isOpenAIResponsesBackendEnabled } from '../../services/modelBackend/openaiCodexConfig.js'
import { hasAnthropicApiKeyAuth } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    description: isOpenAIResponsesBackendEnabled()
      ? 'Validate or explain OpenAI/Codex credentials for this session'
      : hasAnthropicApiKeyAuth()
        ? 'Switch Anthropic accounts'
        : 'Sign in with your Anthropic account',
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    load: () => import('./login.js'),
  }) satisfies Command
