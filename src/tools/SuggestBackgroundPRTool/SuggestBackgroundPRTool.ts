import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'

const inputSchema = z.strictObject({})

export const SuggestBackgroundPRTool = buildTool({
  name: 'SuggestBackgroundPR',
  maxResultSizeChars: 8_192,
  isEnabled() {
    return false
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async description() {
    return 'Background PR suggestions are unavailable in this build.'
  },
  get inputSchema() {
    return inputSchema
  },
  async call() {
    throw new Error('SuggestBackgroundPRTool is not available in this build')
  },
})
