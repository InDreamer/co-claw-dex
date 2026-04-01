import { spawnSync } from 'node:child_process'
import {
  cpSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const rootDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
const distDir = join(rootDir, 'dist')
const outFile = join(distDir, 'cli.js')
const vendorDir = join(rootDir, 'vendor')
const distVendorDir = join(distDir, 'vendor')
const strayOutFile = join(rootDir, 'src', 'entrypoints', 'cli.js')
const strayMapFile = join(rootDir, 'src', 'entrypoints', 'cli.js.map')

const defines = {
  'MACRO.VERSION': packageJson.version,
  'MACRO.BUILD_TIME': new Date().toISOString(),
  'MACRO.PACKAGE_URL': packageJson.name,
  'MACRO.NATIVE_PACKAGE_URL': packageJson.name,
  'MACRO.FEEDBACK_CHANNEL': packageJson.bugs?.url ?? packageJson.homepage,
  'MACRO.ISSUES_EXPLAINER': 'open an issue',
  'MACRO.VERSION_CHANGELOG': '',
}

const externals = [
  '@ant/*',
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/mcpb',
  '@anthropic-ai/sandbox-runtime',
  '@anthropic-ai/sandbox-runtime/*',
  'audio-capture.node',
  'modifiers-napi',
]

rmSync(distDir, { force: true, recursive: true })
mkdirSync(distDir, { recursive: true })
rmSync(strayOutFile, { force: true })
rmSync(strayMapFile, { force: true })

const args = [
  'build',
  'src/entrypoints/cli.tsx',
  '--target=node',
  '--format=esm',
  '--sourcemap=linked',
  '--outdir',
  distDir,
  '--root',
  join(rootDir, 'src', 'entrypoints'),
  '--entry-naming',
  '[name].[ext]',
]

for (const [key, value] of Object.entries(defines)) {
  args.push('--define', `${key}=${JSON.stringify(value)}`)
}

for (const external of externals) {
  args.push('--external', external)
}

const result = spawnSync('bun', args, {
  cwd: rootDir,
  stdio: 'inherit',
})

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

const built = readFileSync(outFile, 'utf8')
const shebang = '#!/usr/bin/env node\n'
writeFileSync(outFile, built.startsWith(shebang) ? built : `${shebang}${built}`)
chmodSync(outFile, 0o755)

cpSync(vendorDir, distVendorDir, { recursive: true })

for (const ripgrepBinary of [
  join(distVendorDir, 'ripgrep', 'x64-darwin', 'rg'),
  join(distVendorDir, 'ripgrep', 'arm64-darwin', 'rg'),
  join(distVendorDir, 'ripgrep', 'x64-linux', 'rg'),
  join(distVendorDir, 'ripgrep', 'arm64-linux', 'rg'),
]) {
  try {
    chmodSync(ripgrepBinary, 0o755)
  } catch {
    // Ignore missing platform binaries
  }
}
