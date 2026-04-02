import { describe, expect, test } from 'bun:test'
import {
  getOpenAICodexModelCatalogEntry,
  normalizeOpenAICompatibleModel,
} from './openaiModelCatalog.js'

describe('openaiModelCatalog normalization', () => {
  test('keeps Claude family model strings out of OpenAI legacy alias mapping', () => {
    expect(
      normalizeOpenAICompatibleModel('claude-sonnet-4-6-20250929'),
    ).toBeUndefined()
    expect(normalizeOpenAICompatibleModel('claude-opus-4-6')).toBeUndefined()
    expect(getOpenAICodexModelCatalogEntry('claude-sonnet-4-6-20250929')).toBeUndefined()
  })

  test('still maps bare legacy aliases onto the OpenAI catalog', () => {
    expect(normalizeOpenAICompatibleModel('sonnet')).toBe('gpt-5.2')
    expect(normalizeOpenAICompatibleModel('haiku')).toBe('gpt-5-mini')
  })
})
