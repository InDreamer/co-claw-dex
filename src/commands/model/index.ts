import type { Command } from '../../commands.js'
import { BRAND_NAME } from '../../constants/brand.js'
import { isOpenAIResponsesBackendEnabled } from '../../services/modelBackend/openaiCodexConfig.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { getMainLoopModel, renderModelName } from '../../utils/model/model.js'

export default {
  type: 'local-jsx',
  name: 'model',
  get description() {
    return isOpenAIResponsesBackendEnabled()
      ? `Set the AI model for ${BRAND_NAME} (currently ${renderModelName(getMainLoopModel())})`
      : `Set the AI model for Claude Code (currently ${renderModelName(getMainLoopModel())})`
  },
  argumentHint: '[model]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./model.js'),
} satisfies Command
