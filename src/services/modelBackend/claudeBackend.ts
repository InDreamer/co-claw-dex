import {
  getMaxOutputTokensForModel,
  queryModelWithStreaming,
} from '../api/claude.js'
import type { ModelBackend } from './types.js'

export const claudeModelBackend: ModelBackend = {
  id: 'claude',
  streamTurn(params) {
    return queryModelWithStreaming(params)
  },
  getMaxOutputTokens(model) {
    return getMaxOutputTokensForModel(model)
  },
}
