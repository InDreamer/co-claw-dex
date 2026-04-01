import { CLAUDE_OPUS_4_6_CONFIG } from '../model/configs.js'
import { getAPIProvider } from '../model/providers.js'
import {
  isOpenAIResponsesBackendEnabled,
  resolveOpenAIModel,
} from '../../services/modelBackend/openaiCodexConfig.js'

// @[MODEL LAUNCH]: Update the fallback model below.
// When the user has never set teammateDefaultModel in /config, new teammates
// use Opus 4.6. Must be provider-aware so Bedrock/Vertex/Foundry customers get
// the correct model ID.
export function getHardcodedTeammateModelFallback(): string {
  if (isOpenAIResponsesBackendEnabled()) {
    return resolveOpenAIModel('opus')
  }
  return CLAUDE_OPUS_4_6_CONFIG[getAPIProvider()]
}
