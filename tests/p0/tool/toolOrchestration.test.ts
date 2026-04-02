import { beforeEach, describe, expect, it, vi } from 'vitest'

const findToolByNameMock = vi.hoisted(() => vi.fn())
const runToolUseMock = vi.hoisted(() => vi.fn())

vi.mock('../../../src/Tool.js', () => ({
  findToolByName: (...args: unknown[]) => findToolByNameMock(...args),
}))
vi.mock('../../../src/services/tools/toolExecution.js', () => ({
  runToolUse: (...args: unknown[]) => runToolUseMock(...args),
}))

import { runTools } from '../../../src/services/tools/toolOrchestration.ts'

function makeTool(
  name: string,
  options?: {
    safeParseSuccess?: boolean
    isConcurrencySafe?: boolean | (() => boolean)
  },
) {
  return {
    name,
    inputSchema: {
      safeParse: () =>
        options?.safeParseSuccess === false
          ? { success: false }
          : { success: true, data: { tool: name } },
    },
    isConcurrencySafe:
      typeof options?.isConcurrencySafe === 'function'
        ? options.isConcurrencySafe
        : () => options?.isConcurrencySafe ?? false,
  }
}

function makeAssistantMessages(ids: string[]) {
  return ids.map(id => ({
    message: { content: [{ type: 'tool_use', id }] },
  })) as any[]
}

function makeContext(tools: any[]) {
  let inProgress = new Set<string>()
  return {
    order: [] as string[],
    options: { tools },
    setInProgressToolUseIDs(
      updater: (prev: Set<string>) => Set<string>,
    ) {
      inProgress = updater(inProgress)
      return inProgress
    },
  }
}

async function collectUpdates(generator: AsyncGenerator<any>) {
  const updates: any[] = []
  for await (const update of generator) {
    updates.push(update)
  }
  return updates
}

beforeEach(() => {
  findToolByNameMock.mockReset()
  runToolUseMock.mockReset()
  findToolByNameMock.mockImplementation(
    (allTools: Array<{ name: string }>, name: string) =>
      allTools.find(tool => tool.name === name),
  )
})

describe('toolOrchestration runtime contracts', () => {
  it('[P0:tool] runs consecutive concurrency-safe tools concurrently but applies queued context modifiers in original block order', async () => {
    const tools = [
      makeTool('safe-a', { isConcurrencySafe: true }),
      makeTool('safe-b', { isConcurrencySafe: true }),
    ]

    let inFlight = 0
    let maxInFlight = 0
    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, toolUse.id === 'a' ? 20 : 1))
      yield {
        message: { type: 'system', content: `done:${toolUse.id}` },
        contextModifier: {
          toolUseID: toolUse.id,
          modifyContext: (context: any) => ({
            ...context,
            order: [...context.order, toolUse.id],
          }),
        },
      }
      inFlight -= 1
    })

    const updates = await collectUpdates(
      runTools(
        [
          { id: 'a', name: 'safe-a', input: {} },
          { id: 'b', name: 'safe-b', input: {} },
        ] as any,
        makeAssistantMessages(['a', 'b']) as any,
        vi.fn() as any,
        makeContext(tools) as any,
      ),
    )

    expect(maxInFlight).toBe(2)
    expect(
      updates
        .filter(update => update.message)
        .map(update => update.message.content),
    ).toEqual(['done:b', 'done:a'])
    expect(updates[0].newContext.order).toEqual([])
    expect(updates[1].newContext.order).toEqual([])
    expect(updates.at(-1)?.message).toBeUndefined()
    expect(updates.at(-1)?.newContext.order).toEqual(['a', 'b'])
  })

  it('[P0:tool] conservatively downgrades parse failures to serial execution, then keeps a following safe tool in a deferred single-tool safe batch', async () => {
    const tools = [
      makeTool('parse-fails', { safeParseSuccess: false }),
      makeTool('safe-next', { isConcurrencySafe: true }),
    ]

    let inFlight = 0
    let maxInFlight = 0
    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      yield {
        message: { type: 'system', content: `step:${toolUse.id}` },
        contextModifier:
          toolUse.id === 'bad'
            ? {
                modifyContext: (context: any) => ({
                  ...context,
                  order: [...context.order, toolUse.id],
                }),
              }
            : {
                toolUseID: toolUse.id,
                modifyContext: (context: any) => ({
                  ...context,
                  order: [...context.order, toolUse.id],
                }),
              },
      }
      inFlight -= 1
    })

    const updates = await collectUpdates(
      runTools(
        [
          { id: 'bad', name: 'parse-fails', input: {} },
          { id: 'good', name: 'safe-next', input: {} },
        ] as any,
        makeAssistantMessages(['bad', 'good']) as any,
        vi.fn() as any,
        makeContext(tools) as any,
      ),
    )

    expect(maxInFlight).toBe(1)
    expect(
      updates
        .filter(update => update.message)
        .map(update => update.message.content),
    ).toEqual(['step:bad', 'step:good'])
    expect(updates[0].newContext.order).toEqual(['bad'])
    expect(updates[1].newContext.order).toEqual(['bad'])
    expect(updates.at(-1)?.message).toBeUndefined()
    expect(updates.at(-1)?.newContext.order).toEqual(['bad', 'good'])
  })

  it('[P0:tool] conservatively downgrades thrown isConcurrencySafe checks to the same serial-then-deferred-safe behavior', async () => {
    const tools = [
      makeTool('throws', {
        isConcurrencySafe: () => {
          throw new Error('shell parse failed')
        },
      }),
      makeTool('safe-next', { isConcurrencySafe: true }),
    ]

    let inFlight = 0
    let maxInFlight = 0
    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      yield {
        message: { type: 'system', content: `step:${toolUse.id}` },
        contextModifier:
          toolUse.id === 'throwing'
            ? {
                modifyContext: (context: any) => ({
                  ...context,
                  order: [...context.order, toolUse.id],
                }),
              }
            : {
                toolUseID: toolUse.id,
                modifyContext: (context: any) => ({
                  ...context,
                  order: [...context.order, toolUse.id],
                }),
              },
      }
      inFlight -= 1
    })

    const updates = await collectUpdates(
      runTools(
        [
          { id: 'throwing', name: 'throws', input: {} },
          { id: 'good', name: 'safe-next', input: {} },
        ] as any,
        makeAssistantMessages(['throwing', 'good']) as any,
        vi.fn() as any,
        makeContext(tools) as any,
      ),
    )

    expect(maxInFlight).toBe(1)
    expect(
      updates
        .filter(update => update.message)
        .map(update => update.message.content),
    ).toEqual(['step:throwing', 'step:good'])
    expect(updates[0].newContext.order).toEqual(['throwing'])
    expect(updates[1].newContext.order).toEqual(['throwing'])
    expect(updates.at(-1)?.message).toBeUndefined()
    expect(updates.at(-1)?.newContext.order).toEqual(['throwing', 'good'])
  })
})
