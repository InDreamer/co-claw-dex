import type { Message } from '../../types/message.js'

type CollapseStats = {
  collapsedSpans: number
  collapsedMessages: number
  stagedSpans: number
  health: {
    totalErrors: number
    totalEmptySpawns: number
    emptySpawnWarningEmitted: boolean
  }
}

const EMPTY_STATS: CollapseStats = {
  collapsedSpans: 0,
  collapsedMessages: 0,
  stagedSpans: 0,
  health: {
    totalErrors: 0,
    totalEmptySpawns: 0,
    emptySpawnWarningEmitted: false,
  },
}

export function subscribe(_listener: () => void): () => void {
  return () => {}
}

export function getStats(): CollapseStats {
  return EMPTY_STATS
}

export function isContextCollapseEnabled(): boolean {
  return false
}

export async function applyCollapsesIfNeeded(
  messages: Message[],
): Promise<{ messages: Message[] }> {
  return { messages }
}

export function recoverFromOverflow(messages: Message[]): {
  committed: number
  messages: Message[]
} {
  return {
    committed: 0,
    messages,
  }
}

export function isWithheldPromptTooLong(): boolean {
  return false
}

export function resetContextCollapse(): void {}
