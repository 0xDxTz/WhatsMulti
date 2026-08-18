# WhatsMulti Spec

Language-neutral contract shared by every WhatsMulti implementation.

| Runtime    | Repo                      | Driver             |
| ---------- | ------------------------- | ------------------ |
| TypeScript | `WhatsMulti` (this repo)  | Baileys `7.0.0-rc` |
| Go         | `whatsmulti-go` (planned) | whatsmeow          |

## Rules

1. **This directory is the source of truth.** Behaviour described here outranks any
   implementation. A disagreement between an implementation and the spec is an
   implementation bug.
2. **Enums are generated, never hand-written.** `states.yaml`, `errors.yaml`, and
   `disconnect-causes.yaml` are compiled into source by each repo's generator.
   Writing an enum twice is how the two runtimes drift.
3. **`vectors/` is the parity gate.** Every implementation runs the same fixtures in
   its own test suite. A divergence is a red build in the repo that caused it.
4. **`VERSION` is semver and independent of package versions.** Any change under
   `spec/` requires a bump. CI enforces this.
    - patch: clarification, no behaviour change
    - minor: additive (new cause, new error code, new optional config key)
    - major: anything an existing implementation would fail
5. **The Go repo consumes this directory as a git submodule.** Never edit it there.

## What is deliberately NOT shared

Signal/auth binary storage. whatsmeow owns its `sqlstore` schema and Baileys owns its
`AuthenticationCreds` shape. A session paired under one runtime cannot be resumed by the
other. Shared instead: the session registry, session metadata, and the distributed lock
table (`storage-schema.sql`).
