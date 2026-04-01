import type { Command } from '../../commands.js'
import { isOpenAIResponsesBackendEnabled } from '../../services/modelBackend/openaiCodexConfig.js'

const status = {
  type: 'local-jsx',
  name: 'status',
  description: isOpenAIResponsesBackendEnabled()
    ? 'Show Claude Code status including OpenAI/Codex model, provider, credentials, and tool statuses'
    : 'Show Claude Code status including version, model, account, API connectivity, and tool statuses',
  immediate: true,
  load: () => import('./status.js'),
} satisfies Command

export default status
