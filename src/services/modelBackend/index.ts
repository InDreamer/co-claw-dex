import { claudeModelBackend } from './claudeBackend.js'
import { openaiResponsesModelBackend } from './openaiResponsesBackend.js'
import type { ModelBackend, ModelBackendId } from './types.js'

function normalizeModelBackendId(value: string | undefined): ModelBackendId {
  switch (value?.toLowerCase()) {
    case 'claude':
      return 'claude'
    case 'openai':
    case 'responses':
    case 'openairesponses':
    case 'codex':
      return 'openaiResponses'
    default:
      return 'openaiResponses'
  }
}

export function getConfiguredModelBackendId(): ModelBackendId {
  return normalizeModelBackendId(
    process.env.CUBENCE_MODEL_BACKEND ??
      process.env.CLAUDE_CODE_MODEL_BACKEND,
  )
}

export function getModelBackend(): ModelBackend {
  switch (getConfiguredModelBackendId()) {
    case 'openaiResponses':
      return openaiResponsesModelBackend
    case 'claude':
    default:
      return claudeModelBackend
  }
}
