import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'

const inputSchema = z.strictObject({})

export const TungstenTool = buildTool({
  name: 'Tmux',
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
    return 'Tmux-backed terminal automation is unavailable in this build.'
  },
  get inputSchema() {
    return inputSchema
  },
  async call() {
    throw new Error('TungstenTool is not available in this build')
  },
})
