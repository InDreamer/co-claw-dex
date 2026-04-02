import { afterEach, describe, expect, test } from 'bun:test'
import {
  getAgentModel,
  getAgentModelDisplay,
  getAgentModelOptions,
} from './agent.js'

const originalModelBackend = process.env.CLAUDE_CODE_MODEL_BACKEND

afterEach(() => {
  if (originalModelBackend === undefined) {
    delete process.env.CLAUDE_CODE_MODEL_BACKEND
  } else {
    process.env.CLAUDE_CODE_MODEL_BACKEND = originalModelBackend
  }
})

describe('agent model options and display', () => {
  test('exposes the OpenAI catalog for agent model options on the OpenAI backend', () => {
    delete process.env.CLAUDE_CODE_MODEL_BACKEND

    const values = getAgentModelOptions().map(option => option.value)

    expect(values).toContain('gpt-5.4')
    expect(values).toContain('gpt-5.4-mini')
    expect(values).toContain('gpt-5-mini')
    expect(values).toContain('inherit')
    expect(values).not.toContain('sonnet')
  })

  test('keeps Claude-family options on the Claude backend', () => {
    process.env.CLAUDE_CODE_MODEL_BACKEND = 'claude'

    expect(getAgentModelOptions().map(option => option.value)).toEqual([
      'sonnet',
      'opus',
      'haiku',
      'inherit',
    ])
  })

  test('renders haiku as a GPT label only on the OpenAI backend', () => {
    delete process.env.CLAUDE_CODE_MODEL_BACKEND
    expect(getAgentModelDisplay('haiku')).toBe('GPT-5 Mini')

    process.env.CLAUDE_CODE_MODEL_BACKEND = 'claude'
    const claudeDisplay = getAgentModelDisplay('haiku')
    expect(claudeDisplay).toContain('Haiku')
    expect(claudeDisplay).not.toContain('GPT')
  })

  test('lets a tool-specified model override a built-in helper default', () => {
    delete process.env.CLAUDE_CODE_MODEL_BACKEND

    expect(getAgentModel('gpt-5.4-mini', 'gpt-5.4', 'gpt-5-mini')).toBe(
      'gpt-5-mini',
    )
  })
})
