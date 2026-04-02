import { basename } from 'path'

const GENERIC_CLI_NAMES = new Set([
  '',
  'bun',
  'bunx',
  'cli',
  'node',
  'npm',
  'npx',
  'ts-node',
  'tsx',
])

function normalizeCommandName(candidate: string): string {
  return candidate.replace(/\.(cmd|cjs|exe|js|mjs|ps1)$/i, '').trim()
}

export function getCliCommandName(): string {
  const override = normalizeCommandName(process.env.CLAWDEX_CLI_NAME || '')
  if (override) {
    return override
  }

  const raw = basename(process.argv[1] || process.execPath || '')
  const normalized = normalizeCommandName(raw)
  if (GENERIC_CLI_NAMES.has(normalized)) {
    return 'clawdex'
  }
  return normalized || 'clawdex'
}

export function formatCliCommand(args = ''): string {
  const base = getCliCommandName()
  return args ? `${base} ${args}` : base
}
