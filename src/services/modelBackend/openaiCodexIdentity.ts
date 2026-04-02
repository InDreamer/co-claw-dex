import { randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import os from 'os'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { getSessionId } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { gitExe } from '../../utils/git.js'
import { getHeadForDir, getRemoteUrlForDir } from '../../utils/git/gitFilesystem.js'

const TURN_METADATA_TTL_MS = 1000

let cachedVersion: string | null = null
let cachedVersionPromise: Promise<string> | undefined
let cachedWorkspaceMetadata:
  | {
      key: string
      expiresAt: number
      value?: Record<string, unknown>
      promise?: Promise<Record<string, unknown>>
    }
  | undefined
let lastTurnTimestamp = 0
let lastTurnSequence = 0

type OpenAICodexIdentity = {
  originator: string
  userAgent: string
}

type TurnMetadataBody = {
  instructions?: unknown
  prompt_cache_key?: unknown
  stream?: unknown
}

export async function getOpenAICodexIdentity(
  isNonInteractiveSession: boolean,
): Promise<OpenAICodexIdentity> {
  const originator = isNonInteractiveSession ? 'codex_exec' : 'codex_cli_rs'
  const version = await getOpenAICodexClientVersion()
  const platform = getOpenAICodexPlatformLabel()
  const terminal = getOpenAICodexTerminalLabel()
  const modeLabel = isNonInteractiveSession ? 'codex-exec' : 'codex-cli-rs'

  return {
    originator,
    userAgent: `${originator}/${version} (${platform}; ${process.arch})${terminal ? ` ${terminal}` : ''} (${modeLabel}; ${version})`,
  }
}

export function shouldAttachOpenAICodexTurnMetadata(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false
  }

  const candidate = body as TurnMetadataBody
  return (
    typeof candidate.instructions === 'string' ||
    typeof candidate.prompt_cache_key === 'string' ||
    candidate.stream === true
  )
}

export function resolveOpenAICodexSessionId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined
  }

  const promptCacheKey =
    'prompt_cache_key' in body ? body.prompt_cache_key : undefined

  return typeof promptCacheKey === 'string' && promptCacheKey.trim()
    ? promptCacheKey
    : undefined
}

export async function buildOpenAICodexTurnMetadata(
  body: unknown,
): Promise<string | undefined> {
  if (!shouldAttachOpenAICodexTurnMetadata(body)) {
    return undefined
  }

  const cwd = getCwd()
  const sessionId = resolveOpenAICodexSessionId(body) ?? getSessionId()
  const key = cwd
  const now = Date.now()

  if (
    cachedWorkspaceMetadata &&
    cachedWorkspaceMetadata.key === key &&
    cachedWorkspaceMetadata.expiresAt > now
  ) {
    if (cachedWorkspaceMetadata.value !== undefined) {
      return JSON.stringify(
        buildTurnMetadataPayload(
          cwd,
          sessionId,
          cachedWorkspaceMetadata.value,
        ),
      )
    }
    if (cachedWorkspaceMetadata.promise) {
      const workspaceEntry = await cachedWorkspaceMetadata.promise
      return JSON.stringify(
        buildTurnMetadataPayload(cwd, sessionId, workspaceEntry),
      )
    }
  }

  const promise = computeWorkspaceMetadata(cwd)
  cachedWorkspaceMetadata = {
    key,
    expiresAt: now + TURN_METADATA_TTL_MS,
    promise,
  }

  const workspaceEntry = await promise
  cachedWorkspaceMetadata = {
    key,
    expiresAt: Date.now() + TURN_METADATA_TTL_MS,
    value: workspaceEntry,
  }
  return JSON.stringify(buildTurnMetadataPayload(cwd, sessionId, workspaceEntry))
}

async function computeWorkspaceMetadata(
  cwd: string,
): Promise<Record<string, unknown>> {
  const [head, originUrl, upstreamUrl, hasChanges] = await Promise.all([
    getHeadForDir(cwd).catch(() => null),
    getRemoteUrlForDir(cwd).catch(() => null),
    getAdditionalRemoteUrl(cwd, 'upstream').catch(() => null),
    getWorkspaceHasChanges(cwd).catch(() => undefined),
  ])

  const workspaceEntry: Record<string, unknown> = {}
  const associatedRemoteUrls = {
    ...(originUrl ? { origin: originUrl } : {}),
    ...(upstreamUrl ? { upstream: upstreamUrl } : {}),
  }
  if (Object.keys(associatedRemoteUrls).length > 0) {
    workspaceEntry.associated_remote_urls = associatedRemoteUrls
  }
  if (head) {
    workspaceEntry.latest_git_commit_hash = head
  }
  if (hasChanges !== undefined) {
    workspaceEntry.has_changes = hasChanges
  }

  return workspaceEntry
}

function buildTurnMetadataPayload(
  cwd: string,
  sessionId: string,
  workspaceEntry: Record<string, unknown>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    session_id: sessionId,
    turn_id: createUuidV7(),
    workspaces: {
      [cwd]: workspaceEntry,
    },
  }

  if (process.platform === 'darwin') {
    metadata.sandbox = 'seatbelt'
  }
  return metadata
}

async function getAdditionalRemoteUrl(
  cwd: string,
  remoteName: string,
): Promise<string | null> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['config', '--get', `remote.${remoteName}.url`],
    {
      cwd,
      preserveOutputOnError: false,
    },
  )
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null
}

async function getWorkspaceHasChanges(cwd: string): Promise<boolean | undefined> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['--no-optional-locks', 'status', '--short'],
    {
      cwd,
      preserveOutputOnError: false,
    },
  )
  if (result.code !== 0) {
    return undefined
  }
  return result.stdout.trim().length > 0
}

async function getOpenAICodexClientVersion(): Promise<string> {
  if (cachedVersion) {
    return cachedVersion
  }
  if (cachedVersionPromise) {
    return cachedVersionPromise
  }

  cachedVersionPromise = (async () => {
    const codexVersion = await getInstalledCodexVersion()
    if (codexVersion) {
      cachedVersion = codexVersion
      return cachedVersion
    }

    const macroVersion =
      typeof MACRO !== 'undefined' && typeof MACRO.VERSION === 'string'
        ? MACRO.VERSION.trim()
        : ''
    if (macroVersion) {
      cachedVersion = macroVersion
      return cachedVersion
    }

    const envVersion = process.env.npm_package_version?.trim()
    if (envVersion) {
      cachedVersion = envVersion
      return cachedVersion
    }

    const moduleDir = dirname(fileURLToPath(import.meta.url))
    const candidates = [
      resolve(moduleDir, '../../../package.json'),
      resolve(dirname(process.argv[1] ?? process.cwd()), 'package.json'),
      resolve(process.cwd(), 'package.json'),
    ]

    for (const candidate of candidates) {
      try {
        if (!existsSync(candidate)) {
          continue
        }
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
          version?: unknown
        }
        if (typeof parsed.version === 'string' && parsed.version.trim()) {
          cachedVersion = parsed.version.trim()
          return cachedVersion
        }
      } catch {
        continue
      }
    }

    cachedVersion = 'unknown'
    return cachedVersion
  })()

  const version = await cachedVersionPromise
  cachedVersionPromise = undefined
  return version
}

function getOpenAICodexPlatformLabel(): string {
  if (process.platform === 'darwin') {
    return `Mac OS ${os.release()}`
  }
  return process.platform
}

function getOpenAICodexTerminalLabel(): string {
  const termProgram = process.env.TERM_PROGRAM?.trim()
  if (!termProgram) {
    return ''
  }
  const version = process.env.TERM_PROGRAM_VERSION?.trim()
  return version ? `${termProgram}/${version}` : termProgram
}

async function getInstalledCodexVersion(): Promise<string | undefined> {
  const result = await execFileNoThrow('codex', ['--version'], {
    useCwd: false,
    preserveOutputOnError: false,
  })
  if (result.code !== 0) {
    return undefined
  }
  const match = result.stdout.match(/(\d+\.\d+\.\d+)/)
  return match?.[1]
}

function createUuidV7(): string {
  const now = Date.now()
  if (now === lastTurnTimestamp) {
    lastTurnSequence = (lastTurnSequence + 1) & 0x0fff
  } else {
    lastTurnTimestamp = now
    lastTurnSequence = randomBytes(2).readUInt16BE(0) & 0x0fff
  }

  const bytes = randomBytes(16)
  let timestamp = BigInt(now)
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(timestamp & 0xffn)
    timestamp >>= 8n
  }

  bytes[6] = 0x70 | ((lastTurnSequence >> 8) & 0x0f)
  bytes[7] = lastTurnSequence & 0xff
  bytes[8] = 0x80 | (bytes[8] & 0x3f)

  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
