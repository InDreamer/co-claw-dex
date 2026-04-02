import { describe, expect, it } from 'vitest'

import {
  getKnownOpenAIContextWindow,
  getOpenAICodexModelCatalogEntry,
  isKnownOpenAICodexModel,
  normalizeOpenAICompatibleModel,
} from '../../../src/services/modelBackend/openaiModelCatalog.ts'

describe('openaiModelCatalog fork contracts', () => {
  it('[P0:model] normalizes the documented legacy aliases to canonical GPT model IDs', () => {
    expect(normalizeOpenAICompatibleModel('best')).toBe('gpt-5.4')
    expect(normalizeOpenAICompatibleModel('opus[1m]')).toBe('gpt-5.4')
    expect(normalizeOpenAICompatibleModel('opusplan')).toBe('gpt-5.4')
    expect(normalizeOpenAICompatibleModel('sonnet')).toBe('gpt-5.2')
    expect(normalizeOpenAICompatibleModel('haiku')).toBe('gpt-5-mini')
    expect(normalizeOpenAICompatibleModel('gpt-5')).toBe('gpt-5.4')
  })

  it('[P0:model] rejects bare Claude-family IDs from OpenAI-compatible normalization unless they hit an explicit legacy alias path', () => {
    expect(normalizeOpenAICompatibleModel('claude')).toBeUndefined()
    expect(normalizeOpenAICompatibleModel('claude-custom')).toBeUndefined()
    expect(isKnownOpenAICodexModel('claude-custom')).toBe(false)
    expect(getOpenAICodexModelCatalogEntry('claude-custom')).toBeUndefined()
  })

  it('[P0:model] preserves unknown OpenAI-compatible IDs while catalog lookup stays limited to known Codex models', () => {
    expect(normalizeOpenAICompatibleModel(' gpt-oss-120b ')).toBe('gpt-oss-120b')
    expect(isKnownOpenAICodexModel(' GPT-5.4-mini ')).toBe(true)
    expect(isKnownOpenAICodexModel('gpt-oss-120b')).toBe(false)

    expect(getOpenAICodexModelCatalogEntry(' opus ')).toMatchObject({
      id: 'gpt-5.4',
      defaultEffort: 'none',
    })
    expect(getOpenAICodexModelCatalogEntry('gpt-oss-120b')).toBeUndefined()
  })

  it('[P0:model] maps context windows for GPT-5.4, generic GPT-5, and GPT-OSS families without inventing unknown sizes', () => {
    expect(getKnownOpenAIContextWindow('gpt-5.4')).toBe(1_000_000)
    expect(getKnownOpenAIContextWindow('gpt-5.3-codex')).toBe(272_000)
    expect(getKnownOpenAIContextWindow('opus')).toBe(1_000_000)
    expect(getKnownOpenAIContextWindow('gpt-oss-120b')).toBe(128_000)
    expect(getKnownOpenAIContextWindow('custom-model')).toBeUndefined()
  })
})
