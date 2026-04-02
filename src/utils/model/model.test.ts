import { afterEach, describe, expect, test } from 'bun:test'
import {
  getMarketingNameForModel,
  getPublicModelDisplayName,
} from './model.js'

const originalModelBackend = process.env.CLAUDE_CODE_MODEL_BACKEND

afterEach(() => {
  if (originalModelBackend === undefined) {
    delete process.env.CLAUDE_CODE_MODEL_BACKEND
  } else {
    process.env.CLAUDE_CODE_MODEL_BACKEND = originalModelBackend
  }
})

describe('model display isolation', () => {
  test('does not leak OpenAI catalog labels into Claude backend display paths', () => {
    process.env.CLAUDE_CODE_MODEL_BACKEND = 'claude'

    expect(getPublicModelDisplayName('sonnet')).toBeNull()
    expect(getPublicModelDisplayName('haiku')).toBeNull()
    expect(getMarketingNameForModel('haiku')).toBeUndefined()
  })

  test('still exposes OpenAI catalog labels on the OpenAI backend', () => {
    delete process.env.CLAUDE_CODE_MODEL_BACKEND

    expect(getPublicModelDisplayName('gpt-5-mini')).toBe('GPT-5 Mini')
  })
})
