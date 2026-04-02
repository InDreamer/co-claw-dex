import { describe, expect, it, vi } from 'vitest'

const isToolSearchEnabledOptimisticMock = vi.hoisted(() => vi.fn())
const isToolSearchToolAvailableMock = vi.hoisted(() => vi.fn())
const extractDiscoveredToolNamesMock = vi.hoisted(() => vi.fn())

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))
vi.mock('../../../src/services/analytics/index.js', () => ({
  logEvent: vi.fn(),
}))
vi.mock('../../../src/services/analytics/metadata.js', () => ({
  extractMcpToolDetails: vi.fn(),
  extractSkillName: vi.fn(),
  extractToolInputForTelemetry: vi.fn(),
  getFileExtensionForAnalytics: vi.fn(),
  getFileExtensionsFromBashCommand: vi.fn(),
  isToolDetailsLoggingEnabled: vi.fn(() => false),
  mcpToolDetailsForAnalytics: vi.fn(() => ({})),
  sanitizeToolNameForAnalytics: vi.fn((name: string) => name),
}))
vi.mock('../../../src/bootstrap/state.js', () => ({
  addToToolDuration: vi.fn(),
  getCodeEditToolDecisionCounter: vi.fn(() => 0),
  getStatsStore: vi.fn(() => ({})),
}))
vi.mock('../../../src/hooks/toolPermission/permissionLogging.js', () => ({
  buildCodeEditToolAttributes: vi.fn(() => ({})),
  isCodeEditingTool: vi.fn(() => false),
}))
vi.mock('../../../src/Tool.js', () => ({
  findToolByName: vi.fn(),
}))
vi.mock('../../../src/tools/BashTool/bashPermissions.js', () => ({
  startSpeculativeClassifierCheck: vi.fn(),
}))
vi.mock('../../../src/tools/BashTool/toolName.js', () => ({
  BASH_TOOL_NAME: 'Bash',
}))
vi.mock('../../../src/tools/FileEditTool/constants.js', () => ({
  FILE_EDIT_TOOL_NAME: 'Edit',
}))
vi.mock('../../../src/tools/FileReadTool/prompt.js', () => ({
  FILE_READ_TOOL_NAME: 'Read',
}))
vi.mock('../../../src/tools/FileWriteTool/constants.js', () => ({
  FILE_WRITE_TOOL_NAME: 'Write',
}))
vi.mock('../../../src/tools/NotebookEditTool/constants.js', () => ({
  NOTEBOOK_EDIT_TOOL_NAME: 'NotebookEdit',
}))
vi.mock('../../../src/tools/PowerShellTool/toolName.js', () => ({
  POWERSHELL_TOOL_NAME: 'PowerShell',
}))
vi.mock('../../../src/tools/shared/gitOperationTracking.js', () => ({
  parseGitCommitId: vi.fn(),
}))
vi.mock('../../../src/tools/ToolSearchTool/prompt.js', () => ({
  isDeferredTool: (tool: { shouldDefer?: boolean }) => tool.shouldDefer === true,
  TOOL_SEARCH_TOOL_NAME: 'ToolSearch',
}))
vi.mock('../../../src/tools.js', () => ({
  getAllBaseTools: vi.fn(() => []),
}))
vi.mock('../../../src/utils/array.js', () => ({
  count: vi.fn(() => 0),
}))
vi.mock('../../../src/utils/attachments.js', () => ({
  createAttachmentMessage: vi.fn(),
}))
vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: vi.fn(),
}))
vi.mock('../../../src/utils/hooks.js', () => ({
  executePermissionDeniedHooks: vi.fn(),
}))
vi.mock('../../../src/utils/log.js', () => ({
  logError: vi.fn(),
}))
vi.mock('../../../src/utils/messages.js', () => ({
  CANCEL_MESSAGE: 'cancelled',
  createProgressMessage: vi.fn(),
  createStopHookSummaryMessage: vi.fn(),
  createToolResultStopMessage: vi.fn(),
  createUserMessage: vi.fn((input: Record<string, unknown>) => input),
  withMemoryCorrectionHint: (message: string) => message,
}))
vi.mock('../../../src/utils/sessionActivity.js', () => ({
  startSessionActivity: vi.fn(),
  stopSessionActivity: vi.fn(),
}))
vi.mock('../../../src/utils/slowOperations.js', () => ({
  jsonStringify: (value: unknown) => JSON.stringify(value),
}))
vi.mock('../../../src/utils/stream.js', () => ({
  Stream: class MockStream {},
}))
vi.mock('../../../src/utils/telemetry/events.js', () => ({
  logOTelEvent: vi.fn(),
}))
vi.mock('../../../src/utils/telemetry/sessionTracing.js', () => ({
  addToolContentEvent: vi.fn(),
  endToolBlockedOnUserSpan: vi.fn(),
  endToolExecutionSpan: vi.fn(),
  endToolSpan: vi.fn(),
  isBetaTracingEnabled: vi.fn(() => false),
  startToolBlockedOnUserSpan: vi.fn(),
  startToolExecutionSpan: vi.fn(),
  startToolSpan: vi.fn(),
}))
vi.mock('../../../src/utils/toolErrors.js', () => ({
  formatError: vi.fn(),
  formatZodValidationError: vi.fn(),
}))
vi.mock('../../../src/utils/toolResultStorage.js', () => ({
  processPreMappedToolResultBlock: vi.fn(),
  processToolResultBlock: vi.fn(),
}))
vi.mock('../../../src/utils/toolSearch.js', () => ({
  extractDiscoveredToolNames: (...args: unknown[]) =>
    extractDiscoveredToolNamesMock(...args),
  isToolSearchEnabledOptimistic: (...args: unknown[]) =>
    isToolSearchEnabledOptimisticMock(...args),
  isToolSearchToolAvailable: (...args: unknown[]) =>
    isToolSearchToolAvailableMock(...args),
}))
vi.mock('../../../src/services/mcp/client.js', () => ({
  McpAuthError: class McpAuthError extends Error {},
  McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS: class McpToolCallError extends Error {},
}))
vi.mock('../../../src/services/mcp/mcpStringUtils.js', () => ({
  mcpInfoFromString: vi.fn(() => undefined),
}))
vi.mock('../../../src/services/mcp/normalization.js', () => ({
  normalizeNameForMCP: vi.fn((name: string) => name),
}))
vi.mock('../../../src/services/mcp/utils.js', () => ({
  getLoggingSafeMcpBaseUrl: vi.fn(() => undefined),
  getMcpServerScopeFromToolName: vi.fn(() => undefined),
  isMcpTool: vi.fn(() => false),
}))
vi.mock('../../../src/services/tools/toolHooks.js', () => ({
  resolveHookPermissionDecision: vi.fn(),
  runPostToolUseFailureHooks: vi.fn(),
  runPostToolUseHooks: vi.fn(),
  runPreToolUseHooks: vi.fn(),
}))

import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../../src/utils/errors.ts'
import {
  buildSchemaNotSentHint,
  classifyToolError,
} from '../../../src/services/tools/toolExecution.ts'

describe('toolExecution helper contracts', () => {
  it('[P0:tool] classifies telemetry-safe tool errors using the telemetry message and truncates it for stable reporting', () => {
    const telemetryMessage = 'x'.repeat(240)
    const error =
      new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        'full message with extra detail',
        telemetryMessage,
      )

    expect(classifyToolError(error)).toBe(telemetryMessage.slice(0, 200))
  })

  it('[P0:tool] truncates long stable error names so telemetry buckets stay bounded and predictable', () => {
    const longName =
      'VerySpecificToolFailureNameThatShouldStillBeClampedForTelemetrySafetyAndStability'
    const longNamedError = new Error('very verbose failure name')
    longNamedError.name = longName

    expect(classifyToolError(longNamedError)).toBe(longName.slice(0, 60))
  })

  it('[P0:tool] classifies errno, stable named errors, generic errors, and non-errors into conservative public buckets', () => {
    const errnoError = new Error('missing file') as Error & { code?: string }
    errnoError.code = 'ENOENT'
    expect(classifyToolError(errnoError)).toBe('Error:ENOENT')

    const namedError = new Error('shell failed')
    namedError.name = 'ShellError'
    expect(classifyToolError(namedError)).toBe('ShellError')

    const genericError = new Error('boom')
    genericError.name = 'nJT'
    expect(classifyToolError(genericError)).toBe('Error')
    expect(classifyToolError('not an error')).toBe('UnknownError')
  })

  it('[P0:tool] suppresses the deferred-tool schema hint when a compact boundary already carried that tool in discovered metadata', () => {
    isToolSearchEnabledOptimisticMock.mockReturnValue(true)
    isToolSearchToolAvailableMock.mockReturnValue(true)
    extractDiscoveredToolNamesMock.mockImplementation((messages: any[]) => {
      const discovered = new Set<string>()
      for (const message of messages) {
        if (message.type === 'system' && message.subtype === 'compact_boundary') {
          for (const name of message.compactMetadata?.preCompactDiscoveredTools ?? []) {
            discovered.add(name)
          }
        }
      }
      return discovered
    })

    const messages = [
      {
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        compactMetadata: {
          preCompactDiscoveredTools: ['DeferredTool'],
        },
      },
    ] as any[]

    expect(
      buildSchemaNotSentHint(
        { name: 'DeferredTool', shouldDefer: true } as any,
        messages as any,
        [{ name: 'ToolSearch' }],
      ),
    ).toBeNull()
  })

  it('[P0:tool] suppresses the deferred-tool schema hint when ToolSearch itself is unavailable to call', () => {
    isToolSearchEnabledOptimisticMock.mockReturnValue(true)
    isToolSearchToolAvailableMock.mockReturnValue(false)
    extractDiscoveredToolNamesMock.mockReturnValue(new Set())

    expect(
      buildSchemaNotSentHint(
        { name: 'DeferredTool', shouldDefer: true } as any,
        [] as any,
        [{ name: 'Read' }],
      ),
    ).toBeNull()
  })

  it('[P0:tool] only emits the deferred-tool schema hint when ToolSearch is available, enabled, and the tool was not already discovered from real message shapes', () => {
    isToolSearchEnabledOptimisticMock.mockReturnValue(true)
    isToolSearchToolAvailableMock.mockImplementation(
      (tools: Array<{ name: string }>) =>
        tools.some(tool => tool.name === 'ToolSearch'),
    )
    extractDiscoveredToolNamesMock.mockImplementation((messages: any[]) => {
      const discovered = new Set<string>()
      for (const message of messages) {
        if (message.type === 'system' && message.subtype === 'compact_boundary') {
          for (const name of message.compactMetadata?.preCompactDiscoveredTools ?? []) {
            discovered.add(name)
          }
          continue
        }
        if (message.type !== 'user' || !Array.isArray(message.message?.content)) {
          continue
        }
        for (const block of message.message.content) {
          if (block.type !== 'tool_result' || !Array.isArray(block.content)) {
            continue
          }
          for (const item of block.content) {
            if (item.type === 'tool_reference' && typeof item.tool_name === 'string') {
              discovered.add(item.tool_name)
            }
          }
        }
      }
      return discovered
    })

    const messages = [
      {
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        compactMetadata: {
          preCompactDiscoveredTools: ['AlreadyLoadedFromCompact'],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-search-1',
              is_error: false,
              content: [
                {
                  type: 'tool_reference',
                  tool_name: 'AlreadyLoadedFromToolSearch',
                },
              ],
            },
          ],
        },
      },
    ] as any[]

    const tools = [{ name: 'ToolSearch' }, { name: 'DeferredTool' }]
    const deferredTool = { name: 'DeferredTool', shouldDefer: true } as any

    expect(buildSchemaNotSentHint(deferredTool, messages as any, tools)).toContain(
      'call ToolSearch with query "select:DeferredTool"',
    )
    expect(
      buildSchemaNotSentHint(
        { name: 'AlreadyLoadedFromToolSearch', shouldDefer: true } as any,
        messages as any,
        tools,
      ),
    ).toBeNull()
    expect(
      buildSchemaNotSentHint(
        { name: 'ImmediateTool', shouldDefer: false } as any,
        messages as any,
        tools,
      ),
    ).toBeNull()

    isToolSearchEnabledOptimisticMock.mockReturnValue(false)
    expect(buildSchemaNotSentHint(deferredTool, messages as any, tools)).toBeNull()
  })
})
