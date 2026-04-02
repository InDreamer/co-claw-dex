<!-- docmeta
role: leaf
layer: 3
parent: docs/implementation/INDEX.md
children: []
summary: canonical phased implementation plan for the hybrid native Codex integration
read_when:
  - the task is to begin coding the Codex integration work
  - the task needs implementation phases, fixed defaults, or edit boundaries
skip_when:
  - the task is only broad repository onboarding
source_of_truth:
  - src/services/modelBackend
  - src/services/api/claude.ts
  - src/query.ts
  - src/utils/effort.ts
  - src/utils/model
-->

# Hybrid Native Codex Integration Plan

## What this covers

This document is the implementation source of truth for the next coding phase. It converts the earlier research into fixed decisions, phased work, file-level edit boundaries, and a concrete coding order that can be executed without reopening design questions unless a change would clearly reduce agent capability or break an existing runtime guarantee.

## Fixed decisions

These decisions are intentionally frozen for the first implementation pass. Reopen them only if a coding discovery shows a clear agent-capability regression or a correctness issue.

- Keep the local runtime as the only execution authority for state-changing actions.
- Do not allow OpenAI/Codex built-in execution tools to become the default main path.
- Keep read-only built-in tools out of the default main path for now to avoid a split tool/control plane.
- Introduce native session state via `previous_response_id` first, not `conversation`.
- Treat official-client headers and Codex-style turn metadata as provider-specific opt-in behavior, not a correctness dependency.
- Optimize for `hybrid native`, not `full native`.

## Success definition

The implementation is successful when:

- OpenAI/Codex remains the default provider path.
- Core agent/runtime capability does not regress.
- Model facts and defaults match current OpenAI documentation.
- The Responses adapter understands more of the native OpenAI item and stream surface.
- Native session continuity improves without bypassing the local runtime.

The implementation is not trying to prove:

- complete product equivalence with official Codex
- migration of every Claude-only surface
- permissionless use of native execution tools

## Current verified checkpoint

This section records what is already true in code and has been locally re-verified, so the next coding rounds start from facts instead of reopening research.

- Phase 0 is already partially complete.
- The curated OpenAI/Codex model surface now keeps both `gpt-5-mini` and `gpt-5.4-mini`.
- `gpt-5.4-mini` is the current helper/subagent default for fast coding-oriented read-only and guide flows.
- `minimal` is restored as a first-class reasoning effort value.
- Applied effort now resolves per model instead of silently coercing `minimal` to `low`.
- GPT-5.4 long-context handling is corrected for the currently verified 1M-context family behavior used by `gpt-5.4` compatibility checks.
- Local verification currently passes for `npm run build`, `node cli.js --help`, and `node cli.js auth status --text`.
- `gpt-5.4-pro` and `gpt-5.2-pro` are still manual-model compatibility IDs for now, not curated picker defaults.

## Inference control surfaces

Model selection and reasoning selection do not live in one place. The implementation must preserve the distinct control planes instead of collapsing them.

### Provider-native defaults

This is the OpenAI/Codex-native layer:

- `~/.codex/config.toml`
- `OPENAI_MODEL`
- `OPENAI_REASONING_EFFORT`

This layer defines the provider-default model and provider-default reasoning effort. It is the right place to preserve native Codex/OpenAI behavior.

### CLI-persisted user preference

This is the local product layer:

- `settings.json`
- model picker / `/model`
- `/effort`

This layer defines the user's stable preference inside this forked CLI and must continue to work even when provider defaults change.

### Session and process overrides

This is the highest-precedence temporary layer:

- `--model`
- `--effort`
- `CLAUDE_CODE_EFFORT_LEVEL`
- in-session runtime overrides such as plan-mode/session model overrides

### Reasoning precedence

For coding and review purposes, treat reasoning resolution as:

1. `CLAUDE_CODE_EFFORT_LEVEL`
2. session/app-state effort
3. provider-configured reasoning effort
4. model catalog default effort

Guardrails:

- Do not silently coerce `minimal` to `low`.
- Do not let TUI display one effort while requests send another.
- Do not let provider-native defaults erase explicit user/TUI choices.

## Implementation phases

### Phase 0: Align facts and defaults

Goal: remove known correctness drift before deeper adapter work.

Deliverables:

- Sync the OpenAI/Codex model catalog with the currently verified official model surface.
- Keep both `gpt-5-mini` and `gpt-5.4-mini` available where model selection is curated, since current official docs now distinguish a general smaller GPT-5 option from a stronger coding/subagent mini variant.
- Keep provider-native defaults, CLI-persisted settings, and live TUI/session overrides as separate model/effort control surfaces.
- Correct default-model guidance and picker/status text to match the verified model strategy.
- Restore `minimal` as a first-class reasoning effort value.
- Correct model default effort behavior where the current fork diverges from official defaults.
- Correct any already-confirmed context-window facts, especially GPT-5.4 long-context handling, before deeper adapter work.
- Ensure displayed effort, persisted effort, and request effort all resolve through one consistent path.
- Document which verified models are curated picker options versus manual-only compatibility IDs.

Why first:

- If model defaults are already wrong, every later evaluation is contaminated.
- This phase is the lowest-risk way to get closer to native behavior without touching execution control.

Primary edit surface:

- `src/services/modelBackend/openaiModelCatalog.ts`
- `src/services/modelBackend/openaiCodexConfig.ts`
- `src/utils/effort.ts`
- `src/utils/model/model.ts`
- `src/utils/model/agent.ts`
- `src/utils/model/modelOptions.ts`
- `src/commands/model/model.tsx`
- `src/utils/status.tsx`
- `README.md` only if setup guidance becomes incorrect

Exit criteria:

- Verified model list and defaults match the implementation doc.
- No hidden coercion from `minimal` to `low`.
- No known UI/runtime mismatch in selected model or effort.
- Provider config defaults and CLI/TUI overrides follow the documented precedence chain.

### Phase 1: Tighten tool and schema fidelity

Goal: make tool argument generation and structured output behavior more reliable before expanding item support.

Deliverables:

- Add explicit `strict` handling for OpenAI function tools where supported.
- Standardize JSON schema generation from `inputSchema` / `inputJSONSchema`.
- Confirm structured text output and function-tool output use compatible schema discipline.
- Audit passthrough or weak-schema tools and document where strictness must be relaxed.

Why here:

- Tool argument fidelity is one of the easiest ways to silently lose agent quality.
- This phase improves capability without changing the main runtime authority.

Primary edit surface:

- `src/services/modelBackend/openaiResponsesBackend.ts`
- `src/Tool.ts`
- tool definitions under `src/tools`

Exit criteria:

- Tool schemas sent to OpenAI are explicit and predictable.
- No broad drop in tool success rate from over-tight schema enforcement.

### Phase 2: Expand the Responses adapter to native item coverage

Goal: stop treating OpenAI Responses as a tiny `message + function_call` subset.

Deliverables:

- Expand response/output types to include `refusal`, reasoning-related items, MCP-related items, and recognized built-in tool items.
- Expand stream event handling to recognize the corresponding lifecycle events.
- Route recognized items into the local runtime as typed, observable signals.
- Log and safely degrade unknown items instead of silently discarding them.

Why here:

- The current adapter is a compatibility bridge. This phase moves it closer to a native protocol surface without handing execution control to the model.

Primary edit surface:

- `src/services/modelBackend/openaiResponsesTypes.ts`
- `src/services/modelBackend/openaiResponsesBackend.ts`
- `src/services/api/claude.ts`
- message/adapter helpers in `src/utils/messages.ts` and related rendering/bridge code as needed

Exit criteria:

- The adapter no longer silently ignores major item classes that affect correctness.
- Refusal, reasoning, and MCP-related outputs are visible to the local runtime or explicitly downgraded with telemetry.

### Phase 3: Introduce a provider-neutral turn contract

Goal: reduce the deepest Claude-shaped runtime coupling without rewriting the whole system.

Deliverables:

- Define a narrow internal contract between provider output and local execution orchestration.
- Gradually isolate Anthropic-specific message/block types behind adapter boundaries.
- Start with the highest-leverage call sites: tool orchestration, remote permission bridge, usage/cost accounting, and stream adaptation.

Why not first:

- This is higher-leverage than naming cleanup, but it is still more invasive than fact/default fixes.
- It should happen after the OpenAI surface is understood more completely.

Primary edit surface:

- `src/services/modelBackend/types.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/services/tools/StreamingToolExecutor.ts`
- `src/remote/remotePermissionBridge.ts`
- `src/remote/sdkMessageAdapter.ts`
- `src/cost-tracker.ts`

Exit criteria:

- Provider-specific types leak less into runtime-critical modules.
- OpenAI adapter changes require less Claude-shaped emulation glue.

### Phase 4: Add native session continuity

Goal: improve multi-turn continuity and reduce unnecessary stateless replay pressure.

Deliverables:

- Add an experimental `previous_response_id` path for the OpenAI backend.
- Preserve the current stateless replay path as a fallback and debug comparator.
- Decide request-by-request whether to continue natively or fall back locally.
- Capture failure causes and automatic downgrade behavior.

Why `previous_response_id` first:

- Smaller control surface than `conversation`.
- Lower migration risk.
- Easier to roll back and easier to compare against the current replay path.

Primary edit surface:

- `src/services/modelBackend/openaiResponsesBackend.ts`
- `src/services/modelBackend/openaiApi.ts`
- `src/query.ts`
- state/session helpers that persist request lineage if needed

Exit criteria:

- Native response chaining works on representative multi-turn samples.
- Tool roundtrip, approval flow, and compact behavior still work or cleanly fall back.

### Phase 5: Validation, rollout gates, and coding handoff completion

Goal: prove the path is safe enough to keep coding forward and eventually switch defaults with confidence.

Deliverables:

- Build a golden task suite covering:
  - forced tool routing
  - strict structured outputs
  - plan/approval behavior
  - multi-agent collaboration
  - memory and compact continuity
  - fallback and rollback behavior
- Add lightweight observability for:
  - adapter failures
  - unrecognized item types
  - session-state downgrade events
  - schema failures
- Define rollout gates for internal dogfood and controlled default expansion.

Primary edit surface:

- minimal test harness or smoke infrastructure chosen during coding
- runtime logging and analytics touchpoints
- rollout switches under model backend config

Exit criteria:

- Coding can continue feature-by-feature without reopening architecture.
- Later default switching has a measurable gate and rollback path.

## Immediate coding order

This is the coding order to follow over the next few rounds.

1. Phase 0: model catalog and reasoning/default cleanup.
2. Phase 1: tool strictness and schema fidelity.
3. Phase 2: adapter item/event expansion.
4. Phase 4: `previous_response_id` experimental path.
5. Phase 3: provider-neutral contract extraction where required by earlier phases.
6. Phase 5: validation and rollout gates.

The order is intentionally not numerical after Phase 2. Session continuity should be tested before large contract extraction unless contract extraction becomes a blocker for implementing item coverage safely.

## Next coding tranche

This is the practical handoff for the next two to three coding rounds.

1. Finish the remaining Phase 0 surface audit:
   - help text
   - status/model display
   - config and picker entry points
   - manual-only versus curated model exposure
2. Implement Phase 1 strict tool-schema and structured-output work.
3. Start Phase 2 by expanding type coverage for native OpenAI response items and stream events.
4. Do not open native built-in execution tools, `conversation`, or broad runtime refactors unless a clear capability regression forces it.

## Safe edit surface

Safe first-pass edits:

- model catalog and model-selection files
- effort parsing and display logic
- OpenAI request construction
- OpenAI response/item typing and parser coverage
- logging and downgrade behavior for unknown OpenAI items

High-risk edits that require extra care:

- any change that bypasses local permission or tool execution control
- changes to compact/memory behavior that alter transcript continuity
- replacing stateless replay outright instead of making native continuity optional
- broad refactors of the internal message model without a compatibility bridge
- collapsing provider defaults and CLI/TUI preferences into one shared setting path

Escalate only if discovered during coding:

- a required OpenAI native behavior cannot be represented without breaking tool or approval fidelity
- `previous_response_id` proves insufficient and `conversation` becomes necessary for correctness
- native built-in tool support is required to avoid a clear agent-capability loss

## Research doc status

The archived research documents under `research/` remain useful, but they now have a single job:

- preserve the research trail
- justify the plan historically
- stop being the place where implementation decisions are made

All coding work should treat this document as the canonical implementation plan.
