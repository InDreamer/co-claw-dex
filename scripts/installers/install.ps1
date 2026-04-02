$ErrorActionPreference = 'Stop'

param(
  [string]$ApiKey = $env:OPENAI_API_KEY,
  [string]$BaseUrl = $(if ($env:CLAWDEX_BASE_URL) { $env:CLAWDEX_BASE_URL } else { 'https://api.openai.com/v1' }),
  [string]$Model = $(if ($env:CLAWDEX_MODEL) { $env:CLAWDEX_MODEL } else { 'gpt-5.4' }),
  [string]$PackageUrl = $(if ($env:CLAWDEX_PACKAGE_URL) { $env:CLAWDEX_PACKAGE_URL } else { 'https://github.com/InDreamer/co-claw-dex/releases/latest/download/clawdex.tgz' }),
  [string]$InstallRoot = $(if ($env:CLAWDEX_INSTALL_ROOT) { $env:CLAWDEX_INSTALL_ROOT } else { Join-Path $HOME '.clawdex' }),
  [string]$CodexHome = $(if ($env:CLAWDEX_CODEX_HOME) { $env:CLAWDEX_CODEX_HOME } else { Join-Path $HOME '.codex' }),
  [switch]$SkipConfig,
  [switch]$ForceConfig,
  [switch]$NoPath,
  [switch]$Quiet
)

$NodeVersion = if ($env:CLAWDEX_NODE_VERSION) { $env:CLAWDEX_NODE_VERSION } else { 'v20.19.0' }
$NodeDir = Join-Path $InstallRoot 'runtime\node'
$CurrentDir = Join-Path $InstallRoot 'current'
$BinDir = Join-Path $InstallRoot 'bin'
$CmdLauncher = Join-Path $BinDir 'clawdex.cmd'
$CompatLauncher = Join-Path $BinDir 'claude-codex.cmd'
$PowerShellLauncher = Join-Path $BinDir 'clawdex.ps1'

function Write-Log {
  param([string]$Message)
  if (-not $Quiet) {
    Write-Host $Message
  }
}

function Invoke-Download {
  param(
    [string]$Url,
    [string]$OutputPath
  )

  Invoke-WebRequest -Uri $Url -OutFile $OutputPath | Out-Null
}

function Install-PortableNode {
  if ((Test-Path (Join-Path $NodeDir 'node.exe')) -and (Test-Path (Join-Path $NodeDir 'npm.cmd'))) {
    return
  }

  $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    $arch = 'arm64'
  }

  $zipName = "node-$NodeVersion-win-$arch.zip"
  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("clawdex-node-" + [guid]::NewGuid().ToString('n'))
  $zipPath = Join-Path $tempRoot $zipName
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

  Write-Log "Downloading portable Node.js $NodeVersion..."
  Invoke-Download -Url "https://nodejs.org/dist/$NodeVersion/$zipName" -OutputPath $zipPath

  if (Test-Path $NodeDir) {
    Remove-Item -Recurse -Force $NodeDir
  }

  Expand-Archive -Path $zipPath -DestinationPath $tempRoot -Force
  Move-Item -Path (Join-Path $tempRoot "node-$NodeVersion-win-$arch") -Destination $NodeDir
  Remove-Item -Recurse -Force $tempRoot
}

function Install-ClawdexPackage {
  $releaseRoot = Join-Path $InstallRoot 'releases'
  $releaseId = Get-Date -Format 'yyyyMMddHHmmss'
  $releaseDir = Join-Path $releaseRoot $releaseId
  $packageArchive = Join-Path ([IO.Path]::GetTempPath()) ("clawdex-" + [guid]::NewGuid().ToString('n') + '.tgz')
  $npmCmd = Join-Path $NodeDir 'npm.cmd'

  New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
  Set-Content -Path (Join-Path $releaseDir 'package.json') -Value "{`n  `"name`": `"clawdex-installation`",`n  `"private`": true`n}"

  Write-Log "Downloading clawdex package..."
  Invoke-Download -Url $PackageUrl -OutputPath $packageArchive

  Write-Log "Installing clawdex package..."
  & $npmCmd install --prefix $releaseDir --no-audit --no-fund --omit=dev $packageArchive | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE"
  }

  if (Test-Path $CurrentDir) {
    Remove-Item -Recurse -Force $CurrentDir
  }
  Move-Item -Path $releaseDir -Destination $CurrentDir
  Remove-Item -Force $packageArchive
}

function Write-Launchers {
  $nodeExe = Join-Path $NodeDir 'node.exe'
  $cliJs = Join-Path $CurrentDir 'node_modules\@indreamer\clawdex\cli.js'

  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

  @"
@echo off
"$nodeExe" "$cliJs" %*
"@ | Set-Content -Path $CmdLauncher

  @"
@echo off
"$nodeExe" "$cliJs" %*
"@ | Set-Content -Path $CompatLauncher

  @"
& "$nodeExe" "$cliJs" @args
"@ | Set-Content -Path $PowerShellLauncher
}

function Ensure-UserPath {
  if ($NoPath) {
    return
  }

  $currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @()
  if ($currentPath) {
    $entries = $currentPath.Split(';') | Where-Object { $_ }
  }

  if ($entries -contains $BinDir) {
    return
  }

  $updated = @($BinDir) + $entries
  [Environment]::SetEnvironmentVariable('Path', ($updated -join ';'), 'User')
  Write-Log "Added $BinDir to the user PATH. Open a new shell after install."
}

function Backup-File {
  param([string]$Path)

  if (Test-Path $Path) {
    $stamp = (Get-Date).ToString('yyyyMMddHHmmss')
    Copy-Item -Path $Path -Destination "$Path.bak.$stamp"
  }
}

function Write-CodexConfig {
  if ($SkipConfig) {
    return
  }

  $configPath = Join-Path $CodexHome 'config.toml'
  $authPath = Join-Path $CodexHome 'auth.json'
  $configExists = Test-Path $configPath

  New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null

  if ((-not $configExists) -or $ForceConfig -or $PSBoundParameters.ContainsKey('BaseUrl') -or $PSBoundParameters.ContainsKey('Model')) {
    Backup-File -Path $configPath
    @"
model_provider = "openai"
model = "$Model"
disable_response_storage = true

[model_providers.openai]
base_url = "$BaseUrl"
wire_api = "responses"
"@ | Set-Content -Path $configPath
  }

  if ($ApiKey) {
    Backup-File -Path $authPath
    @{ OPENAI_API_KEY = $ApiKey } | ConvertTo-Json | Set-Content -Path $authPath
  }
}

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
Install-PortableNode
Install-ClawdexPackage
Write-Launchers
Ensure-UserPath
Write-CodexConfig

Write-Host ""
Write-Log "clawdex installed."
Write-Log "Launcher: $CmdLauncher"
if (-not $ApiKey -and -not (Test-Path (Join-Path $CodexHome 'auth.json'))) {
  Write-Log "Set OPENAI_API_KEY or edit $CodexHome\auth.json before sending prompts."
}
Write-Log "Run: clawdex --help"
