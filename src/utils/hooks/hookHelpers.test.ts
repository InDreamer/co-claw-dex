import { describe, expect, test } from 'bun:test'
import { hookResponseSchema } from './hookHelpers.js'

describe('hookResponseSchema', () => {
  test('accepts a successful hook response with null reason', () => {
    const parsed = hookResponseSchema().safeParse({
      ok: true,
      reason: null,
    })

    expect(parsed.success).toBe(true)
  })

  test('accepts a blocking hook response with string reason', () => {
    const parsed = hookResponseSchema().safeParse({
      ok: false,
      reason: 'blocked by policy',
    })

    expect(parsed.success).toBe(true)
  })

  test('rejects mismatched ok/reason combinations', () => {
    expect(
      hookResponseSchema().safeParse({
        ok: true,
        reason: 'should be null',
      }).success,
    ).toBe(false)

    expect(
      hookResponseSchema().safeParse({
        ok: false,
        reason: null,
      }).success,
    ).toBe(false)
  })
})
