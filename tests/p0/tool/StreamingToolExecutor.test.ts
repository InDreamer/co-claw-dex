import { beforeEach, describe, expect, it, vi } from 'vitest'

const findToolByNameMock = vi.hoisted(() => vi.fn())
const runToolUseMock = vi.hoisted(() => vi.fn())

vi.mock('../../../src/Tool.js', () => ({
  findToolByName: (...args: unknown[]) => findToolByNameMock(...args),
}))
vi.mock('../../../src/services/tools/toolExecution.js', () => ({
  runToolUse: (...args: unknown[]) => runToolUseMock(...args),
}))
vi.mock('../../../src/utils/messages.js', () => ({
  REJECT_MESSAGE: 'rejected',
  withMemoryCorrectionHint: (message: string) => message,
  createUserMessage: (input: Record<string, unknown>) => ({
    type: 'user',
    message: {
      role: 'user',
      content: input.content,
    },
    toolUseResult: input.toolUseResult,
    sourceToolAssistantUUID: input.sourceToolAssistantUUID,
  }),
}))
vi.mock('../../../src/utils/abortController.js', () => ({
  createChildAbortController: (parent: AbortController) => {
    const child = new AbortController()
    parent.signal.addEventListener(
      'abort',
      () => child.abort(parent.signal.reason),
      { once: true },
    )
    return child
  },
}))

import { StreamingToolExecutor } from '../../../src/services/tools/StreamingToolExecutor.ts'

function makeTool(
  name: string,
  options?: {
    isConcurrencySafe?: boolean
    interruptBehavior?: 'cancel' | 'block'
  },
) {
  return {
    name,
    inputSchema: {
      safeParse: () => ({ success: true, data: { tool: name } }),
    },
    isConcurrencySafe: () => options?.isConcurrencySafe ?? true,
    interruptBehavior: () => options?.interruptBehavior ?? 'block',
  }
}

function makeAssistantMessage(id: string) {
  return {
    uuid: `assistant-${id}`,
    message: { content: [{ type: 'tool_use', id }] },
  } as any
}

function makeContext(tools: any[]) {
  let inProgress = new Set<string>()
  return {
    options: { tools },
    abortController: new AbortController(),
    setInProgressToolUseIDs(
      updater: (prev: Set<string>) => Set<string>,
    ) {
      inProgress = updater(inProgress)
      return inProgress
    },
    setHasInterruptibleToolInProgress: vi.fn(),
  } as any
}

function toolResultMessage(toolUseId: string, text: string, isError: boolean) {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: text,
          is_error: isError,
        },
      ],
    },
    toolUseResult: text,
  }
}

async function collectAsync(generator: AsyncGenerator<any>) {
  const items: any[] = []
  for await (const item of generator) {
    items.push(item)
  }
  return items
}

beforeEach(() => {
  findToolByNameMock.mockReset()
  runToolUseMock.mockReset()
  findToolByNameMock.mockImplementation(
    (allTools: Array<{ name: string }>, name: string) =>
      allTools.find(tool => tool.name === name),
  )
})

describe('StreamingToolExecutor runtime contracts', () => {
  it('[P0:tool] emits an immediate synthetic tool_result when a requested tool is missing', () => {
    findToolByNameMock.mockReturnValue(undefined)

    const executor = new StreamingToolExecutor(
      [] as any,
      vi.fn() as any,
      makeContext([]),
    )
    executor.addTool(
      { id: 'missing-1', name: 'MissingTool', input: {} } as any,
      makeAssistantMessage('missing-1'),
    )

    const results = [...executor.getCompletedResults()]
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      message: {
        type: 'user',
        toolUseResult: 'Error: No such tool available: MissingTool',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'missing-1',
              is_error: true,
            },
          ],
        },
      },
    })
  })

  it('[P0:tool] does not re-yield results that were already consumed via getCompletedResults', async () => {
    findToolByNameMock.mockReturnValue(undefined)

    const executor = new StreamingToolExecutor(
      [] as any,
      vi.fn() as any,
      makeContext([]),
    )
    executor.addTool(
      { id: 'missing-once-1', name: 'MissingTool', input: {} } as any,
      makeAssistantMessage('missing-once-1'),
    )

    const firstPull = [...executor.getCompletedResults()]
    expect(firstPull).toHaveLength(1)
    expect(firstPull[0]).toMatchObject({
      message: { toolUseResult: 'Error: No such tool available: MissingTool' },
    })
    expect([...executor.getCompletedResults()]).toEqual([])
    expect(await collectAsync(executor.getRemainingResults())).toEqual([])
  })

  it('[P0:tool] preserves a sibling result that already completed before a later Bash failure arrives', async () => {
    const tools = [
      makeTool('Read', { isConcurrencySafe: true }),
      makeTool('Bash', { isConcurrencySafe: true }),
    ]

    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      if (toolUse.id === 'read-first-1') {
        yield { message: toolResultMessage(toolUse.id, 'read finished first', false) }
        return
      }
      await new Promise(resolve => setTimeout(resolve, 5))
      yield { message: toolResultMessage(toolUse.id, 'bash failed late', true) }
    })

    const executor = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      makeContext(tools),
    )
    executor.addTool(
      { id: 'read-first-1', name: 'Read', input: { file_path: 'a.txt' } } as any,
      makeAssistantMessage('read-first-1'),
    )
    executor.addTool(
      { id: 'bash-late-1', name: 'Bash', input: { command: 'exit 1' } } as any,
      makeAssistantMessage('bash-late-1'),
    )

    const results = await collectAsync(executor.getRemainingResults())
    expect(results.map(result => result.message?.toolUseResult)).toEqual([
      'read finished first',
      'bash failed late',
    ])
  })

  it('[P0:tool] cancels sibling tool output on Bash errors but lets siblings finish after non-Bash errors', async () => {
    const bashTools = [
      makeTool('Bash', { isConcurrencySafe: true }),
      makeTool('Read', { isConcurrencySafe: true }),
    ]
    runToolUseMock.mockImplementation(async function* (toolUse: { id: string; name: string }) {
      if (toolUse.id === 'bash-1') {
        await new Promise(resolve => setTimeout(resolve, 1))
        yield { message: toolResultMessage(toolUse.id, 'bash failed', true) }
        return
      }
      await new Promise(resolve => setTimeout(resolve, 10))
      yield { message: toolResultMessage(toolUse.id, 'read succeeded', false) }
    })

    const bashExecutor = new StreamingToolExecutor(
      bashTools as any,
      vi.fn() as any,
      makeContext(bashTools),
    )
    bashExecutor.addTool(
      { id: 'bash-1', name: 'Bash', input: { command: 'exit 1' } } as any,
      makeAssistantMessage('bash-1'),
    )
    bashExecutor.addTool(
      { id: 'read-1', name: 'Read', input: { file_path: 'README.md' } } as any,
      makeAssistantMessage('read-1'),
    )

    const bashResults = await collectAsync(bashExecutor.getRemainingResults())
    expect(bashResults.map(result => result.message?.toolUseResult)).toEqual([
      'bash failed',
      'Cancelled: parallel tool call Bash(exit 1) errored',
    ])

    const nonBashTools = [
      makeTool('ReadA', { isConcurrencySafe: true }),
      makeTool('ReadB', { isConcurrencySafe: true }),
    ]
    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      if (toolUse.id === 'read-a') {
        yield { message: toolResultMessage(toolUse.id, 'read A failed', true) }
        return
      }
      yield { message: toolResultMessage(toolUse.id, 'read B succeeded', false) }
    })

    const nonBashExecutor = new StreamingToolExecutor(
      nonBashTools as any,
      vi.fn() as any,
      makeContext(nonBashTools),
    )
    nonBashExecutor.addTool(
      { id: 'read-a', name: 'ReadA', input: { file_path: 'a.txt' } } as any,
      makeAssistantMessage('read-a'),
    )
    nonBashExecutor.addTool(
      { id: 'read-b', name: 'ReadB', input: { file_path: 'b.txt' } } as any,
      makeAssistantMessage('read-b'),
    )

    const nonBashResults = await collectAsync(nonBashExecutor.getRemainingResults())
    expect(nonBashResults.map(result => result.message?.toolUseResult)).toEqual([
      'read A failed',
      'read B succeeded',
    ])
  })

  it('[P0:tool] treats non-interrupt parent aborts as hard user rejections even for block tools', async () => {
    const tools = [makeTool('Blocking', { isConcurrencySafe: true, interruptBehavior: 'block' })]
    const context = makeContext(tools)
    context.abortController.abort('permission_denied')

    const executor = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      context,
    )
    executor.addTool(
      { id: 'blocked-hard-1', name: 'Blocking', input: {} } as any,
      makeAssistantMessage('blocked-hard-1'),
    )

    const results = await collectAsync(executor.getRemainingResults())
    expect(results.map(result => result.message?.toolUseResult)).toEqual([
      'User rejected tool use',
    ])
  })

  it('[P0:tool] turns interrupt-aborted cancel tools into synthetic rejection results but lets block tools finish normally', async () => {
    const cancelTools = [makeTool('Cancelable', { isConcurrencySafe: true, interruptBehavior: 'cancel' })]
    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      yield { message: toolResultMessage(toolUse.id, `done:${toolUse.id}`, false) }
    })

    const cancelContext = makeContext(cancelTools)
    cancelContext.abortController.abort('interrupt')
    const cancelExecutor = new StreamingToolExecutor(
      cancelTools as any,
      vi.fn() as any,
      cancelContext,
    )
    cancelExecutor.addTool(
      { id: 'cancel-1', name: 'Cancelable', input: {} } as any,
      makeAssistantMessage('cancel-1'),
    )

    const cancelResults = await collectAsync(cancelExecutor.getRemainingResults())
    expect(cancelResults.map(result => result.message?.toolUseResult)).toEqual([
      'User rejected tool use',
    ])

    const blockTools = [makeTool('Blocking', { isConcurrencySafe: true, interruptBehavior: 'block' })]
    const blockContext = makeContext(blockTools)
    blockContext.abortController.abort('interrupt')
    const blockExecutor = new StreamingToolExecutor(
      blockTools as any,
      vi.fn() as any,
      blockContext,
    )
    blockExecutor.addTool(
      { id: 'block-1', name: 'Blocking', input: {} } as any,
      makeAssistantMessage('block-1'),
    )

    const blockResults = await collectAsync(blockExecutor.getRemainingResults())
    expect(blockResults.map(result => result.message?.toolUseResult)).toEqual([
      'done:block-1',
    ])
  })

  it('[P0:tool] marks the UI interruptible only when every executing tool is cancel-interruptible, then clears that state on completion', async () => {
    const cancelTools = [
      makeTool('CancelA', { isConcurrencySafe: true, interruptBehavior: 'cancel' }),
      makeTool('CancelB', { isConcurrencySafe: true, interruptBehavior: 'cancel' }),
    ]
    let releaseCancels!: () => void
    const cancelGate = new Promise<void>(resolve => {
      releaseCancels = resolve
    })
    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      await cancelGate
      yield { message: toolResultMessage(toolUse.id, `done:${toolUse.id}`, false) }
    })

    const cancelContext = makeContext(cancelTools)
    const cancelExecutor = new StreamingToolExecutor(
      cancelTools as any,
      vi.fn() as any,
      cancelContext,
    )
    cancelExecutor.addTool(
      { id: 'cancel-a', name: 'CancelA', input: {} } as any,
      makeAssistantMessage('cancel-a'),
    )
    cancelExecutor.addTool(
      { id: 'cancel-b', name: 'CancelB', input: {} } as any,
      makeAssistantMessage('cancel-b'),
    )

    await Promise.resolve()
    expect(cancelContext.setHasInterruptibleToolInProgress).toHaveBeenCalledWith(
      true,
    )

    releaseCancels()
    await collectAsync(cancelExecutor.getRemainingResults())
    expect(cancelContext.setHasInterruptibleToolInProgress).toHaveBeenLastCalledWith(
      false,
    )

    const mixedTools = [
      makeTool('Cancelable', { isConcurrencySafe: true, interruptBehavior: 'cancel' }),
      makeTool('Blocking', { isConcurrencySafe: true, interruptBehavior: 'block' }),
    ]
    let releaseMixed!: () => void
    const mixedGate = new Promise<void>(resolve => {
      releaseMixed = resolve
    })
    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      await mixedGate
      yield { message: toolResultMessage(toolUse.id, `done:${toolUse.id}`, false) }
    })

    const mixedContext = makeContext(mixedTools)
    const mixedExecutor = new StreamingToolExecutor(
      mixedTools as any,
      vi.fn() as any,
      mixedContext,
    )
    mixedExecutor.addTool(
      { id: 'mixed-cancel', name: 'Cancelable', input: {} } as any,
      makeAssistantMessage('mixed-cancel'),
    )
    mixedExecutor.addTool(
      { id: 'mixed-block', name: 'Blocking', input: {} } as any,
      makeAssistantMessage('mixed-block'),
    )

    await Promise.resolve()
    expect(mixedContext.setHasInterruptibleToolInProgress).toHaveBeenCalledWith(
      false,
    )
    releaseMixed()
    await collectAsync(mixedExecutor.getRemainingResults())
  })

  it('[P0:tool] does not let later safe tools leapfrog a queued non-concurrent tool that arrived behind an executing safe tool', async () => {
    const tools = [
      makeTool('SafeA', { isConcurrencySafe: true }),
      makeTool('Write', { isConcurrencySafe: false }),
      makeTool('SafeB', { isConcurrencySafe: true }),
    ]
    const started: string[] = []
    let releaseSafeA!: () => void
    const safeAGate = new Promise<void>(resolve => {
      releaseSafeA = resolve
    })

    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      started.push(toolUse.id)
      if (toolUse.id === 'safe-a') {
        await safeAGate
      }
      yield { message: toolResultMessage(toolUse.id, `done:${toolUse.id}`, false) }
    })

    const executor = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      makeContext(tools),
    )
    executor.addTool(
      { id: 'safe-a', name: 'SafeA', input: {} } as any,
      makeAssistantMessage('safe-a'),
    )
    executor.addTool(
      { id: 'write-queued', name: 'Write', input: { file_path: 'x.txt' } } as any,
      makeAssistantMessage('write-queued'),
    )
    executor.addTool(
      { id: 'safe-b', name: 'SafeB', input: {} } as any,
      makeAssistantMessage('safe-b'),
    )

    await Promise.resolve()
    expect(started).toEqual(['safe-a'])

    releaseSafeA()
    const results = await collectAsync(executor.getRemainingResults())
    expect(started).toEqual(['safe-a', 'write-queued', 'safe-b'])
    expect(results.map(result => result.message?.toolUseResult)).toEqual([
      'done:safe-a',
      'done:write-queued',
      'done:safe-b',
    ])
  })

  it('[P0:tool] does not surface a later already-completed result until an earlier non-concurrent tool finishes, preserving output order', async () => {
    const tools = [makeTool('Write', { isConcurrencySafe: false })]
    const started: string[] = []
    let releaseWrite!: () => void
    const writeGate = new Promise<void>(resolve => {
      releaseWrite = resolve
    })

    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      started.push(toolUse.id)
      await writeGate
      yield { message: toolResultMessage(toolUse.id, `done:${toolUse.id}`, false) }
    })

    const executor = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      makeContext(tools),
    )
    executor.addTool(
      { id: 'write-order-1', name: 'Write', input: { file_path: 'x.txt' } } as any,
      makeAssistantMessage('write-order-1'),
    )
    executor.addTool(
      { id: 'missing-behind-write-1', name: 'MissingTool', input: {} } as any,
      makeAssistantMessage('missing-behind-write-1'),
    )

    await Promise.resolve()
    expect(started).toEqual(['write-order-1'])
    expect([...executor.getCompletedResults()]).toEqual([])

    releaseWrite()
    const results = await collectAsync(executor.getRemainingResults())
    expect(results.map(result => result.message?.toolUseResult)).toEqual([
      'done:write-order-1',
      'Error: No such tool available: MissingTool',
    ])
  })

  it('[P0:tool] keeps later safe tools queued behind an executing non-concurrent tool until exclusive access is released', async () => {
    const tools = [
      makeTool('Write', { isConcurrencySafe: false }),
      makeTool('Read', { isConcurrencySafe: true }),
    ]
    const started: string[] = []
    let releaseWrite!: () => void
    const writeGate = new Promise<void>(resolve => {
      releaseWrite = resolve
    })

    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      started.push(toolUse.id)
      if (toolUse.id === 'write-1') {
        await writeGate
      }
      yield { message: toolResultMessage(toolUse.id, `done:${toolUse.id}`, false) }
    })

    const executor = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      makeContext(tools),
    )
    executor.addTool(
      { id: 'write-1', name: 'Write', input: { file_path: 'x.txt' } } as any,
      makeAssistantMessage('write-1'),
    )
    executor.addTool(
      { id: 'read-1', name: 'Read', input: { file_path: 'x.txt' } } as any,
      makeAssistantMessage('read-1'),
    )

    await Promise.resolve()
    expect(started).toEqual(['write-1'])

    releaseWrite()
    const results = await collectAsync(executor.getRemainingResults())
    expect(started).toEqual(['write-1', 'read-1'])
    expect(results.map(result => result.message?.toolUseResult)).toEqual([
      'done:write-1',
      'done:read-1',
    ])
  })

  it('[P0:tool] leaves getUpdatedContext unchanged after concurrent-safe tools emit context modifiers, since concurrent context updates are not applied', async () => {
    const tools = [
      makeTool('ReadA', { isConcurrencySafe: true }),
      makeTool('ReadB', { isConcurrencySafe: true }),
    ]
    const context = makeContext(tools)
    ;(context as any).committedToolIds = []
    const executor = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      context,
    )

    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      yield {
        message: toolResultMessage(toolUse.id, `done:${toolUse.id}`, false),
        contextModifier: {
          toolUseID: toolUse.id,
          modifyContext: (current: any) => ({
            ...current,
            committedToolIds: [...(current.committedToolIds ?? []), toolUse.id],
          }),
        },
      }
    })

    executor.addTool(
      { id: 'read-concurrent-context-a', name: 'ReadA', input: { file_path: 'a.txt' } } as any,
      makeAssistantMessage('read-concurrent-context-a'),
    )
    executor.addTool(
      { id: 'read-concurrent-context-b', name: 'ReadB', input: { file_path: 'b.txt' } } as any,
      makeAssistantMessage('read-concurrent-context-b'),
    )

    await collectAsync(executor.getRemainingResults())
    expect(executor.getUpdatedContext()).toMatchObject({ committedToolIds: [] })
  })

  it('[P0:tool] applies non-concurrent context modifiers to getUpdatedContext after execution completes', async () => {
    const tools = [makeTool('Write', { isConcurrencySafe: false })]
    const context = makeContext(tools)
    const executor = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      context,
    )

    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      yield {
        message: toolResultMessage(toolUse.id, `done:${toolUse.id}`, false),
        contextModifier: {
          modifyContext: (current: any) => ({
            ...current,
            committedToolIds: [...(current.committedToolIds ?? []), toolUse.id],
          }),
        },
      }
    })

    executor.addTool(
      { id: 'write-context-1', name: 'Write', input: { file_path: 'x.txt' } } as any,
      makeAssistantMessage('write-context-1'),
    )

    await collectAsync(executor.getRemainingResults())
    expect(executor.getUpdatedContext()).toMatchObject({
      committedToolIds: ['write-context-1'],
    })
  })

  it('[P0:tool] exposes pending progress through getCompletedResults before the final result is ready and does not duplicate that progress later', async () => {
    const tools = [makeTool('Read', { isConcurrencySafe: true })]
    let releaseResult!: () => void
    const resultGate = new Promise<void>(resolve => {
      releaseResult = resolve
    })
    let progressHandledResolve!: () => void
    const progressHandled = new Promise<void>(resolve => {
      progressHandledResolve = resolve
    })

    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      yield {
        message: { type: 'progress', content: `progress:${toolUse.id}` },
      }
      progressHandledResolve()
      await resultGate
      yield { message: toolResultMessage(toolUse.id, `done:${toolUse.id}`, false) }
    })

    const executor = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      makeContext(tools),
    )
    executor.addTool(
      { id: 'read-progress-1', name: 'Read', input: { file_path: 'x.txt' } } as any,
      makeAssistantMessage('read-progress-1'),
    )

    await progressHandled
    expect([...executor.getCompletedResults()]).toEqual([
      {
        message: { type: 'progress', content: 'progress:read-progress-1' },
        newContext: expect.any(Object),
      },
    ])
    expect([...executor.getCompletedResults()]).toEqual([])

    releaseResult()
    const results = await collectAsync(executor.getRemainingResults())
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      message: { type: 'user', toolUseResult: 'done:read-progress-1' },
    })
  })

  it('[P0:tool] surfaces already-buffered sibling progress before a later Bash failure cancels the sibling result', async () => {
    const tools = [
      makeTool('Bash', { isConcurrencySafe: true }),
      makeTool('Read', { isConcurrencySafe: true }),
    ]
    let progressHandledResolve!: () => void
    const progressHandled = new Promise<void>(resolve => {
      progressHandledResolve = resolve
    })
    let releaseRead!: () => void
    const readGate = new Promise<void>(resolve => {
      releaseRead = resolve
    })

    runToolUseMock.mockImplementation(async function* (toolUse: { id: string; name: string }) {
      if (toolUse.id === 'read-progress-1') {
        yield {
          message: { type: 'progress', content: 'progress:read-progress-1' },
        }
        progressHandledResolve()
        await readGate
        yield {
          message: toolResultMessage(toolUse.id, 'read succeeded unexpectedly', false),
        }
        return
      }

      await progressHandled
      yield { message: toolResultMessage(toolUse.id, 'bash failed', true) }
      releaseRead()
    })

    const executor = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      makeContext(tools),
    )
    executor.addTool(
      { id: 'bash-fail-1', name: 'Bash', input: { command: 'exit 1' } } as any,
      makeAssistantMessage('bash-fail-1'),
    )
    executor.addTool(
      { id: 'read-progress-1', name: 'Read', input: { file_path: 'x.txt' } } as any,
      makeAssistantMessage('read-progress-1'),
    )

    const results = await collectAsync(executor.getRemainingResults())
    expect(results[0]).toMatchObject({
      message: { type: 'progress', content: 'progress:read-progress-1' },
    })
    expect(results.slice(1).map(result => result.message?.toolUseResult)).toEqual([
      'bash failed',
      'Cancelled: parallel tool call Bash(exit 1) errored',
    ])
  })

  it('[P0:tool] discarding after progress was already consumed suppresses the later final result', async () => {
    const tools = [makeTool('Read', { isConcurrencySafe: true })]
    let progressHandledResolve!: () => void
    const progressHandled = new Promise<void>(resolve => {
      progressHandledResolve = resolve
    })
    let releaseResult!: () => void
    const resultGate = new Promise<void>(resolve => {
      releaseResult = resolve
    })

    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      yield {
        message: { type: 'progress', content: `progress:${toolUse.id}` },
      }
      progressHandledResolve()
      await resultGate
      yield { message: toolResultMessage(toolUse.id, `done:${toolUse.id}`, false) }
    })

    const executor = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      makeContext(tools),
    )
    executor.addTool(
      { id: 'read-discard-1', name: 'Read', input: { file_path: 'x.txt' } } as any,
      makeAssistantMessage('read-discard-1'),
    )

    await progressHandled
    expect([...executor.getCompletedResults()]).toEqual([
      {
        message: { type: 'progress', content: 'progress:read-discard-1' },
        newContext: expect.any(Object),
      },
    ])

    executor.discard()
    releaseResult()
    expect(await collectAsync(executor.getRemainingResults())).toEqual([])
    expect([...executor.getCompletedResults()]).toEqual([])
  })

  it('[P0:tool] orders an earlier completed result before a later buffered progress event when both are visible together', async () => {
    const tools = [
      makeTool('ReadA', { isConcurrencySafe: true }),
      makeTool('ReadB', { isConcurrencySafe: true }),
    ]
    let releaseSecondResult!: () => void
    const secondResultGate = new Promise<void>(resolve => {
      releaseSecondResult = resolve
    })

    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      if (toolUse.id === 'read-a-order-1') {
        await new Promise(resolve => setTimeout(resolve, 1))
        yield { message: toolResultMessage(toolUse.id, 'done:read-a-order-1', false) }
        return
      }

      yield {
        message: { type: 'progress', content: 'progress:read-b-order-1' },
      }
      await secondResultGate
      yield { message: toolResultMessage(toolUse.id, 'done:read-b-order-1', false) }
    })

    const executor = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      makeContext(tools),
    )
    executor.addTool(
      { id: 'read-a-order-1', name: 'ReadA', input: { file_path: 'a.txt' } } as any,
      makeAssistantMessage('read-a-order-1'),
    )
    executor.addTool(
      { id: 'read-b-order-1', name: 'ReadB', input: { file_path: 'b.txt' } } as any,
      makeAssistantMessage('read-b-order-1'),
    )

    await new Promise(resolve => setTimeout(resolve, 10))
    const visible = [...executor.getCompletedResults()]
    expect(visible).toMatchObject([
      {
        message: { type: 'user', toolUseResult: 'done:read-a-order-1' },
      },
      {
        message: { type: 'progress', content: 'progress:read-b-order-1' },
      },
    ])

    releaseSecondResult()
    const remaining = await collectAsync(executor.getRemainingResults())
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({
      message: { type: 'user', toolUseResult: 'done:read-b-order-1' },
    })
  })

  it('[P0:tool] yields an earlier safe tool\'s buffered progress before a later safe sibling\'s completed result when both become visible together', async () => {
    const tools = [
      makeTool('ReadA', { isConcurrencySafe: true }),
      makeTool('ReadB', { isConcurrencySafe: true }),
    ]
    let releaseFirstResult!: () => void
    const firstResultGate = new Promise<void>(resolve => {
      releaseFirstResult = resolve
    })

    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      if (toolUse.id === 'read-progress-first-1') {
        yield {
          message: { type: 'progress', content: 'progress:read-progress-first-1' },
        }
        await firstResultGate
        yield {
          message: toolResultMessage(toolUse.id, 'done:read-progress-first-1', false),
        }
        return
      }

      yield { message: toolResultMessage(toolUse.id, 'done:read-complete-second-1', false) }
    })

    const executor = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      makeContext(tools),
    )
    executor.addTool(
      { id: 'read-progress-first-1', name: 'ReadA', input: { file_path: 'a.txt' } } as any,
      makeAssistantMessage('read-progress-first-1'),
    )
    executor.addTool(
      { id: 'read-complete-second-1', name: 'ReadB', input: { file_path: 'b.txt' } } as any,
      makeAssistantMessage('read-complete-second-1'),
    )

    await new Promise(resolve => setTimeout(resolve, 10))
    const visible = [...executor.getCompletedResults()]
    expect(visible).toMatchObject([
      {
        message: { type: 'progress', content: 'progress:read-progress-first-1' },
      },
      {
        message: { type: 'user', toolUseResult: 'done:read-complete-second-1' },
      },
    ])

    releaseFirstResult()
    const remaining = await collectAsync(executor.getRemainingResults())
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({
      message: { type: 'user', toolUseResult: 'done:read-progress-first-1' },
    })
  })

  it('[P0:tool] discarding after one sibling result was already consumed preserves that earlier delivery but suppresses the still-pending sibling output', async () => {
    const tools = [
      makeTool('ReadA', { isConcurrencySafe: true }),
      makeTool('ReadB', { isConcurrencySafe: true }),
    ]
    let releaseSecond!: () => void
    const secondGate = new Promise<void>(resolve => {
      releaseSecond = resolve
    })

    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      if (toolUse.id === 'read-fast-consumed-1') {
        yield {
          message: toolResultMessage(toolUse.id, 'done:read-fast-consumed-1', false),
        }
        return
      }
      await secondGate
      yield {
        message: toolResultMessage(toolUse.id, 'done:read-slow-suppressed-1', false),
      }
    })

    const executor = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      makeContext(tools),
    )
    executor.addTool(
      { id: 'read-fast-consumed-1', name: 'ReadA', input: { file_path: 'fast.txt' } } as any,
      makeAssistantMessage('read-fast-consumed-1'),
    )
    executor.addTool(
      { id: 'read-slow-suppressed-1', name: 'ReadB', input: { file_path: 'slow.txt' } } as any,
      makeAssistantMessage('read-slow-suppressed-1'),
    )

    let firstVisible: any[] = []
    for (let attempt = 0; attempt < 20; attempt += 1) {
      firstVisible = [...executor.getCompletedResults()]
      if (firstVisible.length > 0) break
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(firstVisible).toMatchObject([
      {
        message: { type: 'user', toolUseResult: 'done:read-fast-consumed-1' },
      },
    ])

    executor.discard()
    releaseSecond()
    expect(await collectAsync(executor.getRemainingResults())).toEqual([])
    expect([...executor.getCompletedResults()]).toEqual([])
  })

  it('[P0:tool] yields progress before final results and discard suppresses any residual output', async () => {
    const tools = [makeTool('Read', { isConcurrencySafe: true })]

    runToolUseMock.mockImplementation(async function* (toolUse: { id: string }) {
      yield {
        message: { type: 'progress', content: `progress:${toolUse.id}` },
      }
      await new Promise(resolve => setTimeout(resolve, 5))
      yield { message: toolResultMessage(toolUse.id, `done:${toolUse.id}`, false) }
    })

    const executor = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      makeContext(tools),
    )
    executor.addTool(
      { id: 'read-1', name: 'Read', input: { file_path: 'x.txt' } } as any,
      makeAssistantMessage('read-1'),
    )

    const results = await collectAsync(executor.getRemainingResults())
    expect(results.map(result => result.message?.type)).toEqual(['progress', 'user'])
    expect(results.map(result => result.message?.toolUseResult ?? result.message?.content)).toEqual([
      'progress:read-1',
      'done:read-1',
    ])

    const discarded = new StreamingToolExecutor(
      tools as any,
      vi.fn() as any,
      makeContext(tools),
    )
    discarded.addTool(
      { id: 'read-2', name: 'Read', input: { file_path: 'y.txt' } } as any,
      makeAssistantMessage('read-2'),
    )
    discarded.discard()

    expect([...discarded.getCompletedResults()]).toEqual([])
    expect(await collectAsync(discarded.getRemainingResults())).toEqual([])
  })
})
