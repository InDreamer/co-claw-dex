import { afterEach, describe, expect, test } from 'bun:test'
import {
  getSupportedEffortLevelsForModel,
  getCompatibleEffortLevelForModel,
  modelSupportsEffort,
  resolveAppliedEffort,
} from './effort.js'

const originalModelBackend = process.env.CLAUDE_CODE_MODEL_BACKEND

afterEach(() => {
  if (originalModelBackend === undefined) {
    delete process.env.CLAUDE_CODE_MODEL_BACKEND
  } else {
    process.env.CLAUDE_CODE_MODEL_BACKEND = originalModelBackend
  }
})

describe('effort compatibility', () => {
  test('maps none to minimal for GPT-5 Mini instead of low', () => {
    expect(getCompatibleEffortLevelForModel('gpt-5-mini', 'none')).toBe(
      'minimal',
    )
    expect(resolveAppliedEffort('gpt-5-mini', 'none')).toBe('minimal')
  })

  test('keeps minimal on models that support it directly', () => {
    expect(getCompatibleEffortLevelForModel('gpt-5-mini', 'minimal')).toBe(
      'minimal',
    )
  })

  test('still maps xhigh to high when the model stops at high', () => {
    expect(getCompatibleEffortLevelForModel('gpt-5-mini', 'xhigh')).toBe(
      'high',
    )
  })

  test('maps minimal to low on non-OpenAI models that do not expose minimal', () => {
    expect(
      getCompatibleEffortLevelForModel(
        'claude-sonnet-4-6-20250929',
        'minimal',
      ),
    ).toBe('low')
    expect(resolveAppliedEffort('claude-sonnet-4-6-20250929', 'minimal')).toBe(
      'low',
    )
  })

  test('returns no supported effort levels for models without effort support', () => {
    process.env.CLAUDE_CODE_MODEL_BACKEND = 'claude'
    expect(modelSupportsEffort('haiku')).toBe(false)
    expect(getSupportedEffortLevelsForModel('haiku')).toEqual([])
  })
})
