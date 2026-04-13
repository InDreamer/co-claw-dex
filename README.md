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

`co-claw-dex` is a locally runnable Claude Code-style coding agent fork that swaps the original model provider boundary for an OpenAI/Codex-compatible Responses backend.

The goal is not to redesign the CLI. The goal is to preserve the terminal UX, tool system, permission model, and agent flow while replacing the model runtime with an OpenAI-compatible backend.

The canonical implementation truth now lives in the governed `docs/` tree. Historical research material is preserved separately and should not be used as the implementation source of truth.

## Canonical Docs

- `docs/INDEX.md` is the canonical documentation router.
- `docs/implementation/hybrid-native-implementation-plan.md` is the implementation source of truth for the next coding phase.
- Archived research notes under `research/` remain useful as historical input, but implementation decisions are now consolidated into the docs tree.

## Highlights

- Preserves the Claude Code-style terminal experience instead of rebuilding the agent stack from scratch
- Uses an OpenAI/Codex-compatible Responses backend as the default model runtime
- Reuses Codex-style local auth and config sources such as `~/.codex/auth.json`, `OPENAI_API_KEY`, `~/.codex/config.toml`, and `COCLAWDEX_CONFIG_PATH`
- Uses the same `responses` wire API for both ChatGPT/Codex login sessions and API-key-based access
- Selects credentials in a fixed priority order: ChatGPT/Codex login session, then environment `OPENAI_API_KEY`, then `OPENAI_API_KEY` stored in `~/.codex/auth.json`
- Switches the default OpenAI base URL dynamically based on the selected credential source
- Translates Responses streaming events back into the existing internal stream format so the CLI behavior stays familiar
- Translates function calling into the existing tool-use flow, including stateless replay for providers that do not reliably support `previous_response_id`
- Handles official Codex streaming variants such as `response.text.delta` and can synthesize a final assistant reply when the streamed text is present but `response.completed.output` is empty
- Keeps legacy Claude-style model aliases for compatibility with existing workflows
- Disables official Anthropic install/update flows for this fork distribution
- Ships with source-first helper scripts for build, smoke testing, local activation, and rollback

## Status

This repository now builds and runs as a usable coding agent platform.

What is already migrated:

- OpenAI/Codex-compatible Responses backend is the default model path
- Credentials are loaded from `~/.codex/auth.json` and `OPENAI_API_KEY`, with ChatGPT/Codex login sessions preferred over API keys
- Provider settings are loaded from `COCLAWDEX_CONFIG_PATH` when set, otherwise `~/.codex/config.toml`
- `wire_api = "responses"` is the only supported OpenAI/Codex wire API mode
- The default base URL is selected automatically: ChatGPT/Codex login sessions use `https://chatgpt.com/backend-api/codex`, API keys use `https://api.openai.com/v1`
- ChatGPT/Codex login sessions support proactive token refresh and a single refresh+retry on `401`
- Responses streaming is translated into the existing internal message stream
- Function calling is translated into the existing internal tool-use flow
- Legacy Claude-style model aliases are preserved for compatibility
- Official Anthropic install/update release-channel flows are disabled for this fork

## Quick Start

```bash
npm install
npm run build
node cli.js --help
```

Create a dedicated Codex config file instead of modifying your default `~/.codex/config.toml`:

```toml
model_provider = "openai"
model = "gpt-5.4"
disable_response_storage = true

[model_providers.openai]
wire_api = "responses"
```

Point the fork at that file:

```bash
export COCLAWDEX_CONFIG_PATH="$HOME/.codex/config_for_coclawdex.toml"
```

PowerShell:

```powershell
$env:COCLAWDEX_CONFIG_PATH = "$HOME\\.codex\\config_for_coclawdex.toml"
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

Those helper scripts currently target a Homebrew-style macOS installation path. On Windows, prefer invoking `node cli.js` directly or creating your own `claude.cmd` wrapper that sets `COCLAWDEX_CONFIG_PATH` before forwarding to `node cli.js`.

One-command smoke check:

```bash
npm run smoke
```

## Credential Sources

This fork reuses Codex-style local configuration.

Supported credential sources:

- ChatGPT/Codex login session in `~/.codex/auth.json`
- `OPENAI_API_KEY` from the environment
- `OPENAI_API_KEY` stored in `~/.codex/auth.json`

Credential selection priority is fixed:

1. ChatGPT/Codex login session from `~/.codex/auth.json`
2. Environment `OPENAI_API_KEY`
3. `OPENAI_API_KEY` stored in `~/.codex/auth.json`

Provider settings source priority:

1. `COCLAWDEX_CONFIG_PATH`
2. `~/.codex/config.toml`

Typical values used by this fork:

- model provider base URL
- default model
- wire API mode
- response storage preference

Minimal provider config example:

```toml
model_provider = "openai"
model = "gpt-5.4"
disable_response_storage = true

[model_providers.openai]
wire_api = "responses"
```

Notes:

- `wire_api = "responses"` is required. Other OpenAI/Codex wire API values are rejected explicitly.
- If `base_url` is omitted, the runtime chooses a default based on the selected credential:
  - ChatGPT/Codex login session => `https://chatgpt.com/backend-api/codex`
  - API key => `https://api.openai.com/v1`
- If `base_url` is set explicitly, that value still wins.

## Architecture

The migration keeps the original runtime shape as intact as possible.

Instead of rewriting the agent stack, the fork translates at the provider boundary:

- Internal prompt and message flow remain Claude Code-shaped
- Internal tool orchestration remains Claude Code-shaped
- OpenAI Responses requests are generated from existing message history
- Responses streaming events are translated back into the existing stream event format
- Function calls and function-call outputs are replayed statelessly for compatibility with proxy providers that do not reliably support `previous_response_id`

This means most of the original CLI, Hermes-style component behavior, and tool plumbing can remain unchanged while the underlying model runtime is replaced.

## Notes

- `cli.js` at the repo root is a thin launcher for the built artifact in `dist/cli.js`
- This fork is intended to be run from source, not upgraded from official Anthropic distribution channels
- `claude update` and `claude install` are intentionally disabled from pulling official Anthropic releases in this fork
- `claude auth status --text` is the quickest way to confirm which config file, auth source, and base URL are currently active
- If you change `src/` files, rebuild with `npm run build` before running `node cli.js` again

## Origin

This codebase began as a source extraction from the published Claude Code bundle and was then patched into a local, buildable, OpenAI/Codex-adapted development workspace for personal use.
