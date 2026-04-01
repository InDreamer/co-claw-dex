import type { Message, SystemMessage } from '../../types/message.js'

export const SNIP_NUDGE_TEXT =
  'Context cleanup is unavailable in this build.'

export function isSnipRuntimeEnabled(): boolean {
  return false
}

export function shouldNudgeForSnips(_messages: Message[]): boolean {
  return false
}

export function snipCompactIfNeeded(
  messages: Message[],
  _options?: { force?: boolean },
): {
  messages: Message[]
  tokensFreed: number
  boundaryMessage?: SystemMessage
} {
  return {
    messages,
    tokensFreed: 0,
  }
}
