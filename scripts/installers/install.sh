#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="${CLAWDEX_REPO_SLUG:-InDreamer/co-claw-dex}"
RELEASE_BASE_URL="${CLAWDEX_RELEASE_BASE_URL:-https://github.com/${REPO_SLUG}/releases/latest/download}"
PACKAGE_URL="${CLAWDEX_PACKAGE_URL:-${RELEASE_BASE_URL}/clawdex.tgz}"
INSTALL_ROOT="${CLAWDEX_INSTALL_ROOT:-$HOME/.clawdex}"
BIN_DIR="${CLAWDEX_BIN_DIR:-$HOME/.local/bin}"
CODEX_HOME="${CLAWDEX_CODEX_HOME:-$HOME/.codex}"
NODE_VERSION="${CLAWDEX_NODE_VERSION:-v20.19.0}"
NODE_DIR="${INSTALL_ROOT}/runtime/node"
RELEASES_DIR="${INSTALL_ROOT}/releases"
CURRENT_LINK="${INSTALL_ROOT}/current"
CLI_WRAPPER="${BIN_DIR}/clawdex"
COMPAT_WRAPPER="${BIN_DIR}/claude-codex"

OPENAI_API_KEY_VALUE="${OPENAI_API_KEY:-}"
BASE_URL="${CLAWDEX_BASE_URL:-https://api.openai.com/v1}"
MODEL="${CLAWDEX_MODEL:-gpt-5.4}"
BASE_URL_EXPLICIT=0
MODEL_EXPLICIT=0
FORCE_CONFIG=0
MODIFY_PATH=1
QUIET=0
WRITE_CONFIG=1

log() {
  if [[ "$QUIET" != "1" ]]; then
    printf '%s\n' "$*"
  fi
}

fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install clawdex into the current user account.

Options:
  --api-key <key>       Store OPENAI_API_KEY in ~/.codex/auth.json
  --base-url <url>      Write a custom OpenAI-compatible base URL
  --model <model>       Write a default model to ~/.codex/config.toml
  --package-url <url>   Override the release package URL
  --skip-config         Install the CLI without writing ~/.codex/*
  --force-config        Rewrite ~/.codex/config.toml and back up the old file
  --no-path             Do not append the launcher directory to shell profile
  --quiet               Reduce progress output
  --help                Show this message

Environment overrides:
  OPENAI_API_KEY
  CLAWDEX_BASE_URL
  CLAWDEX_MODEL
  CLAWDEX_INSTALL_ROOT
  CLAWDEX_BIN_DIR
  CLAWDEX_CODEX_HOME
  CLAWDEX_NODE_VERSION
  CLAWDEX_PACKAGE_URL
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-key)
      [[ $# -ge 2 ]] || fail "--api-key requires a value"
      OPENAI_API_KEY_VALUE="$2"
      shift 2
      ;;
    --base-url)
      [[ $# -ge 2 ]] || fail "--base-url requires a value"
      BASE_URL="$2"
      BASE_URL_EXPLICIT=1
      shift 2
      ;;
    --model)
      [[ $# -ge 2 ]] || fail "--model requires a value"
      MODEL="$2"
      MODEL_EXPLICIT=1
      shift 2
      ;;
    --package-url)
      [[ $# -ge 2 ]] || fail "--package-url requires a value"
      PACKAGE_URL="$2"
      shift 2
      ;;
    --skip-config)
      WRITE_CONFIG=0
      shift
      ;;
    --force-config)
      FORCE_CONFIG=1
      shift
      ;;
    --no-path)
      MODIFY_PATH=0
      shift
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

download_file() {
  local url="$1"
  local output="$2"
  curl --fail --location --retry 3 --retry-delay 1 --silent --show-error \
    "$url" \
    --output "$output"
}

detect_platform() {
  local os
  local arch

  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) fail "unsupported operating system: $(uname -s)" ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac

  printf '%s-%s' "$os" "$arch"
}

install_portable_node() {
  if [[ -x "${NODE_DIR}/bin/node" && -x "${NODE_DIR}/bin/npm" ]]; then
    return
  fi

  local platform
  local filename
  local url
  local temp_dir
  platform="$(detect_platform)"
  filename="node-${NODE_VERSION}-${platform}.tar.xz"
  url="https://nodejs.org/dist/${NODE_VERSION}/${filename}"
  temp_dir="$(mktemp -d)"

  log "Downloading portable Node.js ${NODE_VERSION}..."
  download_file "$url" "${temp_dir}/${filename}"

  rm -rf "${NODE_DIR}"
  mkdir -p "$(dirname "${NODE_DIR}")"
  tar -xJf "${temp_dir}/${filename}" -C "${temp_dir}"
  mv "${temp_dir}/node-${NODE_VERSION}-${platform}" "${NODE_DIR}"
  rm -rf "${temp_dir}"
}

install_release_package() {
  local release_dir
  local release_id
  local temp_dir

  release_id="$(date +%Y%m%d%H%M%S)-$$"
  release_dir="${RELEASES_DIR}/${release_id}"
  temp_dir="$(mktemp -d)"

  mkdir -p "${release_dir}"
  printf '{\n  "name": "clawdex-installation",\n  "private": true\n}\n' \
    > "${release_dir}/package.json"

  log "Downloading clawdex package..."
  download_file "${PACKAGE_URL}" "${temp_dir}/clawdex.tgz"

  log "Installing clawdex package..."
  "${NODE_DIR}/bin/npm" install \
    --prefix "${release_dir}" \
    --no-audit \
    --no-fund \
    --omit=dev \
    "${temp_dir}/clawdex.tgz" \
    >/dev/null

  rm -rf "${CURRENT_LINK}"
  ln -s "${release_dir}" "${CURRENT_LINK}"
  rm -rf "${temp_dir}"
}

write_launcher() {
  mkdir -p "${BIN_DIR}"

  cat > "${CLI_WRAPPER}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${NODE_DIR}/bin/node" "${CURRENT_LINK}/node_modules/@indreamer/clawdex/cli.js" "\$@"
EOF
  chmod 755 "${CLI_WRAPPER}"

  ln -sfn "${CLI_WRAPPER}" "${COMPAT_WRAPPER}"
}

detect_profile() {
  case "${SHELL##*/}" in
    zsh) printf '%s' "${HOME}/.zshrc" ;;
    bash) printf '%s' "${HOME}/.bashrc" ;;
    *)
      if [[ -f "${HOME}/.zshrc" ]]; then
        printf '%s' "${HOME}/.zshrc"
      elif [[ -f "${HOME}/.bashrc" ]]; then
        printf '%s' "${HOME}/.bashrc"
      else
        printf '%s' "${HOME}/.profile"
      fi
      ;;
  esac
}

ensure_path() {
  local profile
  local line

  [[ "${MODIFY_PATH}" == "1" ]] || return 0
  case ":$PATH:" in
    *":${BIN_DIR}:"*) return ;;
  esac

  profile="$(detect_profile)"
  line="export PATH=\"${BIN_DIR}:\$PATH\""

  touch "${profile}"
  if ! grep -Fqs "${line}" "${profile}"; then
    printf '\n# clawdex\n%s\n' "${line}" >> "${profile}"
    log "Added ${BIN_DIR} to PATH in ${profile}"
  fi
}

write_codex_config() {
  [[ "${WRITE_CONFIG}" == "1" ]] || return 0

  export CLAWDEX_INSTALLER_CODEX_HOME="${CODEX_HOME}"
  export CLAWDEX_INSTALLER_FORCE_CONFIG="${FORCE_CONFIG}"
  export CLAWDEX_INSTALLER_BASE_URL="${BASE_URL}"
  export CLAWDEX_INSTALLER_MODEL="${MODEL}"
  export CLAWDEX_INSTALLER_API_KEY="${OPENAI_API_KEY_VALUE}"
  export CLAWDEX_INSTALLER_BASE_URL_EXPLICIT="${BASE_URL_EXPLICIT}"
  export CLAWDEX_INSTALLER_MODEL_EXPLICIT="${MODEL_EXPLICIT}"

  "${NODE_DIR}/bin/node" <<'EOF'
const fs = require('fs')
const path = require('path')

const codexHome = process.env.CLAWDEX_INSTALLER_CODEX_HOME
const forceConfig = process.env.CLAWDEX_INSTALLER_FORCE_CONFIG === '1'
const baseUrl = process.env.CLAWDEX_INSTALLER_BASE_URL
const model = process.env.CLAWDEX_INSTALLER_MODEL
const apiKey = process.env.CLAWDEX_INSTALLER_API_KEY
const baseUrlExplicit = process.env.CLAWDEX_INSTALLER_BASE_URL_EXPLICIT === '1'
const modelExplicit = process.env.CLAWDEX_INSTALLER_MODEL_EXPLICIT === '1'

const configPath = path.join(codexHome, 'config.toml')
const authPath = path.join(codexHome, 'auth.json')

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function backupIfNeeded(filePath) {
  if (!fs.existsSync(filePath)) {
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(filePath, `${filePath}.bak.${stamp}`)
}

const shouldWriteConfig =
  !fs.existsSync(configPath) || forceConfig || baseUrlExplicit || modelExplicit

if (shouldWriteConfig) {
  ensureParent(configPath)
  if (fs.existsSync(configPath)) {
    backupIfNeeded(configPath)
  }
  const content = [
    'model_provider = "openai"',
    `model = "${model}"`,
    'disable_response_storage = true',
    '',
    '[model_providers.openai]',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    '',
  ].join('\n')
  fs.writeFileSync(configPath, content, 'utf8')
}

if (apiKey) {
  ensureParent(authPath)
  if (fs.existsSync(authPath)) {
    backupIfNeeded(authPath)
  }
  fs.writeFileSync(
    authPath,
    `${JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2)}\n`,
    'utf8',
  )
}
EOF
}

print_summary() {
  printf '\n'
  log "clawdex installed."
  log "Launcher: ${CLI_WRAPPER}"
  if [[ "${MODIFY_PATH}" == "1" ]]; then
    log "If your current shell does not see clawdex yet, open a new shell."
  fi
  if [[ -n "${OPENAI_API_KEY_VALUE}" ]]; then
    log "OpenAI API key stored in ${CODEX_HOME}/auth.json"
  elif [[ ! -f "${CODEX_HOME}/auth.json" ]]; then
    log "Set OPENAI_API_KEY or edit ${CODEX_HOME}/auth.json before sending prompts."
  fi
  log "Run: clawdex --help"
}

main() {
  need_command curl
  need_command tar
  mkdir -p "${INSTALL_ROOT}" "${RELEASES_DIR}" "${CODEX_HOME}"
  install_portable_node
  install_release_package
  write_launcher
  ensure_path
  write_codex_config
  print_summary
}

main
