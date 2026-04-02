import { describe, expect, test } from 'bun:test'
import { getHookResponseJsonSchema } from './hooks/hookHelpers.js'
import { getStrictJsonSchemaIncompatibility } from './jsonSchema.js'

describe('jsonSchema strict compatibility', () => {
  test('rejects root anyOf schemas for OpenAI structured outputs', () => {
    const incompatibility = getStrictJsonSchemaIncompatibility({
      anyOf: [
        {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          additionalProperties: false,
        },
      ],
    })

    expect(incompatibility).toBe('$ must set type: object at the schema root')
  })

  test('accepts the hook response schema on the strict OpenAI path', () => {
    expect(
      getStrictJsonSchemaIncompatibility(
        getHookResponseJsonSchema() as Record<string, unknown>,
      ),
    ).toBeUndefined()
  })
})
