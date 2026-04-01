import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'

const inputSchema = z.strictObject({})

export const VerifyPlanExecutionTool = buildTool({
  name: 'VerifyPlanExecution',
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
    return 'Plan verification is unavailable in this build.'
  },
  get inputSchema() {
    return inputSchema
  },
  async call() {
    throw new Error('VerifyPlanExecutionTool is not available in this build')
  },
})
