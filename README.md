<!-- docmeta
role: entry
layer: 1
parent: null
children: []
summary: repository entry point and router for the Codex integration documentation
read_when:
  - first entry into the repository
  - need to find the canonical implementation plan for Codex integration
skip_when:
  - the exact implementation leaf is already known
source_of_truth:
  - README.md
  - docs/catalog.yaml
-->

# co-claw-dex

`co-claw-dex` is a Claude Code-style coding agent fork distributed as the `clawdex` CLI.

It keeps the terminal UX, tool system, permission model, and agent flow largely intact, but swaps the original model boundary for an OpenAI/Codex-compatible Responses backend.

## What You Get

- `clawdex` as the primary end-user command
- one-command install for macOS, Linux, and Windows
- portable user-space install with no `sudo`
- OpenAI-compatible configuration through `OPENAI_API_KEY`, `~/.codex/auth.json`, and `~/.codex/config.toml`
- compatibility with proxy providers that expose an OpenAI-compatible Responses API

## One-Command Install

macOS and Linux:

```bash
curl -fsSL https://github.com/InDreamer/co-claw-dex/releases/latest/download/install.sh | bash
```

macOS and Linux with API key bootstrap:

```bash
curl -fsSL https://github.com/InDreamer/co-claw-dex/releases/latest/download/install.sh | OPENAI_API_KEY=sk-... CLAWDEX_MODEL=gpt-5.4 bash
```

Windows PowerShell:

```powershell
irm https://github.com/InDreamer/co-claw-dex/releases/latest/download/install.ps1 | iex
```

Alternative npm install for environments that already manage Node:

```bash
npm install -g @indreamer/clawdex
```

The packaged installer:

- installs a portable Node runtime under the user home directory
- installs the packaged `clawdex` build without requiring `sudo`
- creates a `clawdex` launcher and a `claude-codex` compatibility launcher
- optionally writes `~/.codex/config.toml` and `~/.codex/auth.json`

## First Run

Check the configured backend and credentials:

```bash
clawdex auth status --text
```

Run a minimal prompt:

```bash
clawdex -p "Reply with exactly: hello"
```

If no credential is configured yet, either set `OPENAI_API_KEY` in the shell or write it to `~/.codex/auth.json`.

## Installer Overrides

Supported installer environment variables:

- `OPENAI_API_KEY`
- `CLAWDEX_BASE_URL`
- `CLAWDEX_MODEL`
- `CLAWDEX_INSTALL_ROOT`
- `CLAWDEX_BIN_DIR`
- `CLAWDEX_CODEX_HOME`

Useful script flags:

- `--skip-config`
- `--force-config`
- `--no-path`
- `--api-key <key>`
- `--base-url <url>`
- `--model <model>`

## Configuration

Expected credential sources:

- `OPENAI_API_KEY`
- `~/.codex/auth.json`

Expected provider settings source:

- `~/.codex/config.toml`

Minimal provider config example:

```toml
model_provider = "openai"
model = "gpt-5.4"
disable_response_storage = true

[model_providers.openai]
base_url = "https://api.openai.com/v1"
wire_api = "responses"
```

Typical customizations:

- point `base_url` at an OpenAI-compatible gateway or proxy
- change the default model
- keep response storage disabled for stateless provider compatibility

## Release Model

Tagged releases are the distribution path for end users.

Each release publishes:

- `clawdex.tgz`
- `install.sh`
- `install.ps1`
- `SHA256SUMS`

Release flow:

1. Update the package version.
2. Push a tag like `v2.1.88`.
3. GitHub Actions builds the package and uploads the installer assets to the release.
4. If `NPM_TOKEN` is configured in GitHub Actions secrets, the package is also published to npm.

## Local Development

```bash
npm install
npm run build
node cli.js --help
```

Basic verification:

```bash
node cli.js auth status --text
node cli.js -p "Reply with exactly: hello"
```

Launcher helpers:

```bash
npm run activate-cli
npm run restore-cli
```

One-command smoke check:

```bash
npm run smoke
```

Build release assets locally:

```bash
npm run pack:release
```

## Architecture

The migration keeps the original runtime shape as intact as possible.

Instead of rewriting the agent stack, the fork translates at the provider boundary:

- Internal prompt and message flow remain Claude Code-shaped
- Internal tool orchestration remains Claude Code-shaped
- OpenAI Responses requests are generated from existing message history
- Responses streaming events are translated back into the existing stream event format
- Function calls and function-call outputs are replayed statelessly for compatibility with proxy providers that do not reliably support `previous_response_id`

This means most of the original CLI, Hermes-style component behavior, and tool plumbing can remain unchanged while the underlying model runtime is replaced.

## Maintainer Notes

- `cli.js` at the repo root is a thin launcher for the built artifact in `dist/cli.js`
- This fork can now be distributed as `clawdex`, but it is still not upgraded from official Anthropic distribution channels
- `install` and `update` are intentionally disabled from pulling official Anthropic releases in this fork
- The canonical implementation truth now lives in the governed `docs/` tree
- Historical material under `research/` is preserved for reference, not as the implementation source of truth

## Canonical Docs

- `docs/INDEX.md` is the documentation router
- `docs/implementation/hybrid-native-implementation-plan.md` is the current implementation source of truth

## Origin

This codebase began as a source extraction from the published Claude Code bundle and was then patched into a local, buildable, OpenAI/Codex-adapted development workspace for personal use.
