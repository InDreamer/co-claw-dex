import { isOpenAIResponsesBackendEnabled } from '../../services/modelBackend/openaiCodexConfig.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  AGENT_MODEL_OPTIONS,
  type AgentModelAlias,
} from '../../utils/model/agent.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

function normalizeOptionalAgentString(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : undefined
}

function isAgentModelToken(value: string): value is AgentModelAlias {
  return (AGENT_MODEL_OPTIONS as readonly string[]).includes(value)
}

export function normalizeAgentInvocationInput({
  subagentType,
  model,
  activeAgents,
}: {
  subagentType?: string
  model?: AgentModelAlias
  activeAgents: AgentDefinition[]
}): {
  subagentType?: string
  model?: AgentModelAlias
} {
  const normalizedSubagentType = normalizeOptionalAgentString(subagentType)
  if (!normalizedSubagentType) {
    return {
      subagentType: undefined,
      model,
    }
  }

  const hasMatchingAgent = activeAgents.some(
    agent => agent.agentType === normalizedSubagentType,
  )
  if (
    !isOpenAIResponsesBackendEnabled() ||
    hasMatchingAgent ||
    !isAgentModelToken(normalizedSubagentType)
  ) {
    return {
      subagentType: normalizedSubagentType,
      model,
    }
  }

  logForDebugging(
    `[AgentTool] Treating subagent_type='${normalizedSubagentType}' as a misplaced model token and falling back to ${GENERAL_PURPOSE_AGENT.agentType}.`,
  )
  return {
    subagentType: GENERAL_PURPOSE_AGENT.agentType,
    model: model ?? normalizedSubagentType,
  }
}
