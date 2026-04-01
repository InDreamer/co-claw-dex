# Claude Code Codex/OpenAI Fork

This workspace is a locally runnable Claude Code source fork that has been adapted to use an OpenAI-compatible Responses backend as its primary coding model runtime.

The goal of this fork is not to redesign the CLI. The goal is to preserve the existing terminal UX, tool system, permission model, and agent flow while replacing the model provider boundary with a Codex/OpenAI-compatible backend.

## Status

This repository now builds and runs as a usable coding agent platform.

What is already migrated:

- OpenAI/Codex-compatible Responses backend is the default model path
- Credentials are loaded from `OPENAI_API_KEY` or `~/.codex/auth.json`
- Provider settings are loaded from `~/.codex/config.toml`
- Responses streaming is translated into the existing internal message stream
- Function calling is translated into the existing internal tool-use flow
- Legacy Claude-style model aliases are preserved for compatibility
- Official Anthropic self-update, install, telemetry, GrowthBook, and preconnect paths are disabled for this fork

## Quick Start

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

## Credential Sources

This fork reuses Codex-style local configuration.

Expected credential sources:

- `OPENAI_API_KEY`
- `~/.codex/auth.json`

Expected provider settings source:

- `~/.codex/config.toml`

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
base_url = "https://api.openai.com/v1"
wire_api = "responses"
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

## Notes

- `cli.js` at the repo root is a thin launcher for the built artifact in `dist/cli.js`
- This fork is intended to be run from source, not upgraded from official Anthropic distribution channels
- `claude update` and `claude install` are intentionally disabled from pulling official Anthropic releases in this fork

## Origin

This codebase began as a source extraction from the published Claude Code bundle and was then patched into a local, buildable, OpenAI/Codex-adapted development workspace for personal use.
