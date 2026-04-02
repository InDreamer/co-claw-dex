<!-- docmeta
role: domain
layer: 2
parent: docs/INDEX.md
children:
  - docs/implementation/hybrid-native-implementation-plan.md
summary: route implementation work for the hybrid native Codex integration path
read_when:
  - the task is to plan or implement the Codex integration work
  - the task needs phase ordering, fixed boundaries, or coding entry points
skip_when:
  - the request is already narrow enough for the implementation leaf
source_of_truth:
  - docs/INDEX.md
  - src
-->

# Implementation Index

## Scope

This domain covers the implementation path for the hybrid native integration strategy: keep local runtime control, upgrade the OpenAI/Codex side to be more native, and stage the rollout so coding can start immediately without reopening major design decisions.

## Open this leaf

- `docs/implementation/hybrid-native-implementation-plan.md` — canonical implementation plan, fixed defaults, stage breakdown, and immediate coding order.

## Do not read this for

- historical source extraction details
- Claude-only product surfaces that are outside the current success definition
