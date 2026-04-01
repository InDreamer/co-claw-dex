import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { REPL_TOOL_NAME } from './constants.js'

const inputSchema = z.strictObject({})

export const REPLTool = buildTool({
  name: REPL_TOOL_NAME,
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
    return 'REPL mode is unavailable in this build.'
  },
  get inputSchema() {
    return inputSchema
  },
  async call() {
    throw new Error('REPLTool is not available in this build')
  },
})
