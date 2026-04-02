import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(
  fileURLToPath(new URL('../package.json', import.meta.url)),
)
const releaseDir = join(rootDir, '.release')
const assetsDir = join(releaseDir, 'assets')
const installerShell = join(rootDir, 'scripts', 'installers', 'install.sh')
const installerPowerShell = join(
  rootDir,
  'scripts',
  'installers',
  'install.ps1',
)

rmSync(releaseDir, { force: true, recursive: true })
mkdirSync(assetsDir, { recursive: true })

const packResult = spawnSync('npm', ['pack', '--pack-destination', assetsDir], {
  cwd: rootDir,
  encoding: 'utf8',
  stdio: 'pipe',
})

if (packResult.status !== 0) {
  process.stderr.write(packResult.stdout)
  process.stderr.write(packResult.stderr)
  process.exit(packResult.status ?? 1)
}

const packedFile = packResult.stdout
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean)
  .at(-1)

if (!packedFile) {
  throw new Error('npm pack did not return an archive name')
}

renameSync(join(assetsDir, packedFile), join(assetsDir, 'clawdex.tgz'))
copyFileSync(installerShell, join(assetsDir, 'install.sh'))
copyFileSync(installerPowerShell, join(assetsDir, 'install.ps1'))

const releaseFiles = ['clawdex.tgz', 'install.sh', 'install.ps1']
const checksums = releaseFiles.map(file => {
  const hash = createHash('sha256')
    .update(readFileSync(join(assetsDir, file)))
    .digest('hex')
  return `${hash}  ${file}`
})

writeFileSync(join(assetsDir, 'SHA256SUMS'), `${checksums.join('\n')}\n`)
