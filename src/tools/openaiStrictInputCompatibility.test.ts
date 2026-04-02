import { describe, expect, test } from 'bun:test'
import { BashTool } from './BashTool/BashTool.js'
import { FileReadTool } from './FileReadTool/FileReadTool.js'
import { GrepTool } from './GrepTool/GrepTool.js'

describe('OpenAI strict input compatibility', () => {
  test('accepts nullable placeholders for Read optional fields', () => {
    const parsed = FileReadTool.inputSchema.safeParse({
      file_path: '/tmp/example.txt',
      offset: null,
      limit: null,
      pages: null,
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({
        file_path: '/tmp/example.txt',
        offset: undefined,
        limit: undefined,
        pages: undefined,
      })
    }
  })

  test('accepts nullable placeholders for Bash optional fields', () => {
    const parsed = BashTool.inputSchema.safeParse({
      command: 'ls',
      timeout: null,
      description: null,
      dangerouslyDisableSandbox: null,
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.timeout).toBeUndefined()
      expect(parsed.data.description).toBeUndefined()
      expect(parsed.data.dangerouslyDisableSandbox).toBeUndefined()
    }
  })

  test('accepts nullable placeholders for Grep optional fields', () => {
    const parsed = GrepTool.inputSchema.safeParse({
      pattern: 'needle',
      path: null,
      glob: null,
      output_mode: null,
      '-B': null,
      '-A': null,
      '-C': null,
      context: null,
      '-n': null,
      '-i': null,
      type: null,
      head_limit: null,
      offset: null,
      multiline: null,
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.path).toBeUndefined()
      expect(parsed.data.output_mode).toBeUndefined()
      expect(parsed.data.head_limit).toBeUndefined()
      expect(parsed.data.multiline).toBeUndefined()
    }
  })
})
