export type CacheEditsBlock = {
  type: 'cache_edits'
  toolUseIds?: string[]
}

export type PinnedCacheEdits = {
  userMessageIndex: number
  block: CacheEditsBlock
}

export type CachedMCState = {
  pinnedEdits: PinnedCacheEdits[]
  registeredTools: Set<string>
}

export function createCachedMCState(): CachedMCState {
  return {
    pinnedEdits: [],
    registeredTools: new Set(),
  }
}

export function registerToolResult(
  state: CachedMCState,
  toolUseId: string,
): void {
  state.registeredTools.add(toolUseId)
}

export function registerToolMessage(): void {}

export function getToolResultsToDelete(): string[] {
  return []
}

export function createCacheEditsBlock(): CacheEditsBlock | null {
  return null
}

export function isCachedMicrocompactEnabled(): boolean {
  return false
}

export function isModelSupportedForCacheEditing(): boolean {
  return false
}

export function getCachedMCConfig(): { supportedModels: string[] } {
  return { supportedModels: [] }
}
