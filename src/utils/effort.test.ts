import { describe, expect, test } from 'bun:test'
import {
  getCompatibleEffortLevelForModel,
  resolveAppliedEffort,
} from './effort.js'

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
})
