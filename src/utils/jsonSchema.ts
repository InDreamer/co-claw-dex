import type { ZodTypeAny } from 'zod/v4'
import type { ToolInputJSONSchema } from '../Tool.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

export type JsonSchema = Record<string, unknown>

// OpenAI tool strict mode and text.format strict mode both depend on the same
// JSON Schema discipline, so keep schema extraction/cleanup/compat checks in
// one place instead of letting request builders drift.
type ToolSchemaSource = {
  inputSchema?: ZodTypeAny
  inputJSONSchema?: ToolInputJSONSchema | JsonSchema
  input_schema?: JsonSchema
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneSchemaValue)
  }
  if (!isJsonSchema(value)) {
    return value
  }

  const clone: JsonSchema = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === '$schema') {
      continue
    }
    clone[key] = cloneSchemaValue(nestedValue)
  }
  return clone
}

function schemaTypeIncludes(schema: JsonSchema, expectedType: string): boolean {
  const type = schema.type
  if (typeof type === 'string') {
    return type === expectedType
  }
  return Array.isArray(type) && type.includes(expectedType)
}

function findStrictJsonSchemaIncompatibility(
  schema: JsonSchema,
  path: string,
): string | undefined {
  if (path === '$') {
    const isRootObject =
      schemaTypeIncludes(schema, 'object') ||
      isJsonSchema(schema.properties)
    if (!isRootObject) {
      return '$ must set type: object at the schema root'
    }
    if (Array.isArray(schema.anyOf)) {
      return '$ must not use anyOf at the schema root'
    }
  }

  const properties = isJsonSchema(schema.properties) ? schema.properties : undefined
  const isObjectSchema = schemaTypeIncludes(schema, 'object') || properties !== undefined

  if (isObjectSchema) {
    if (schema.additionalProperties !== false) {
      return `${path} must set additionalProperties: false`
    }

    const propertyKeys = properties ? Object.keys(properties) : []
    const required = Array.isArray(schema.required)
      ? schema.required.filter(
          (key): key is string => typeof key === 'string',
        )
      : []
    const missingRequired = propertyKeys.filter(key => !required.includes(key))
    if (missingRequired.length > 0) {
      return `${path} must require every property (missing: ${missingRequired.join(', ')})`
    }

    if (properties) {
      for (const [propertyName, propertySchema] of Object.entries(properties)) {
        if (!isJsonSchema(propertySchema)) {
          continue
        }
        const nested = findStrictJsonSchemaIncompatibility(
          propertySchema,
          `${path}.properties.${propertyName}`,
        )
        if (nested) {
          return nested
        }
      }
    }
  }

  const items = schema.items
  if (Array.isArray(items)) {
    for (let index = 0; index < items.length; index += 1) {
      const itemSchema = items[index]
      if (!isJsonSchema(itemSchema)) {
        continue
      }
      const nested = findStrictJsonSchemaIncompatibility(
        itemSchema,
        `${path}.items[${index}]`,
      )
      if (nested) {
        return nested
      }
    }
  } else if (isJsonSchema(items)) {
    const nested = findStrictJsonSchemaIncompatibility(items, `${path}.items`)
    if (nested) {
      return nested
    }
  }

  const objectChildren = [
    ['additionalProperties', schema.additionalProperties],
    ['not', schema.not],
    ['if', schema.if],
    ['then', schema.then],
    ['else', schema.else],
  ] as const
  for (const [label, child] of objectChildren) {
    if (!isJsonSchema(child)) {
      continue
    }
    const nested = findStrictJsonSchemaIncompatibility(child, `${path}.${label}`)
    if (nested) {
      return nested
    }
  }

  const arrayChildren = [
    ['allOf', schema.allOf],
    ['anyOf', schema.anyOf],
    ['oneOf', schema.oneOf],
    ['prefixItems', schema.prefixItems],
  ] as const
  for (const [label, child] of arrayChildren) {
    if (!Array.isArray(child)) {
      continue
    }
    for (let index = 0; index < child.length; index += 1) {
      const nestedSchema = child[index]
      if (!isJsonSchema(nestedSchema)) {
        continue
      }
      const nested = findStrictJsonSchemaIncompatibility(
        nestedSchema,
        `${path}.${label}[${index}]`,
      )
      if (nested) {
        return nested
      }
    }
  }

  const definitionChildren = [
    ['definitions', schema.definitions],
    ['$defs', schema.$defs],
  ] as const
  for (const [label, child] of definitionChildren) {
    if (!isJsonSchema(child)) {
      continue
    }
    for (const [key, nestedSchema] of Object.entries(child)) {
      if (!isJsonSchema(nestedSchema)) {
        continue
      }
      const nested = findStrictJsonSchemaIncompatibility(
        nestedSchema,
        `${path}.${label}.${key}`,
      )
      if (nested) {
        return nested
      }
    }
  }

  return undefined
}

export function normalizeJsonSchema(schema: JsonSchema): JsonSchema {
  return cloneSchemaValue(schema) as JsonSchema
}

export function getToolInputJsonSchema(tool: ToolSchemaSource): JsonSchema {
  if (isJsonSchema(tool.inputJSONSchema)) {
    return normalizeJsonSchema(tool.inputJSONSchema)
  }
  if (isJsonSchema(tool.input_schema)) {
    return normalizeJsonSchema(tool.input_schema)
  }
  if (tool.inputSchema) {
    return normalizeJsonSchema(zodToJsonSchema(tool.inputSchema))
  }
  return {}
}

export function getStrictJsonSchemaIncompatibility(
  schema: JsonSchema,
): string | undefined {
  return findStrictJsonSchemaIncompatibility(schema, '$')
}

export function isStrictJsonSchemaCompatible(schema: JsonSchema): boolean {
  return getStrictJsonSchemaIncompatibility(schema) === undefined
}
