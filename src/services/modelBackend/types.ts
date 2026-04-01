import type { queryModelWithStreaming } from '../api/claude.js'

export type ModelBackendId = 'claude' | 'openaiResponses'

export type StreamTurnParams = Parameters<typeof queryModelWithStreaming>[0]
export type ModelBackendStream = ReturnType<typeof queryModelWithStreaming>

export interface ModelBackend {
  readonly id: ModelBackendId
  streamTurn(params: StreamTurnParams): ModelBackendStream
  getMaxOutputTokens(model: string): number
}
