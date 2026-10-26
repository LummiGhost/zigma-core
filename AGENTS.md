# Agent workflow

## Rapid iteration

- Deliver one small, reviewable behavior change at a time. Clarify the outcome, implement, validate by risk, and deliver. A small change needs no separate plan or phase report.
- Inspect Git status and relevant code before editing. Preserve unrelated work. Use a task branch for code; isolate work when concurrent edits or user changes require it. Read design and history documents to resolve specific questions rather than as a fixed reading bundle.
- Keep task progress in the existing issue/project when one is used, and keep validation evidence in the PR. Do not duplicate these in Markdown trackers or routine round reports.
- Run the smallest sufficient checks, then broaden for cross-module or high-risk changes. Preserve executable gates for contracts, lifecycle, cancellation, cleanup and data integrity. Do not repeat successful checks unless the code changed or an unresolved concern warrants it.
- Submit implementation through a scoped PR with behavior, validation and material limitations. Required CI must pass and an independent reviewer must check the change. Merge and publish only within the maintainer's current authorization; do not add per-step approvals where that authorization already exists.
- With maintainer authorization, merge a reviewed change promptly and publish a patch for affected packages. Keep documentation in one authoritative location; direct-to-main documentation updates are allowed when the maintainer requests them. Documentation-only changes do not require a package release.
- Use exact published suite identities for downstream dogfood runs. Stop admission on unknown or incompatible provider state. Separate execution completion, independent acceptance and delivery; do not rewrite runtime state to manufacture success.
- Preserve failed evidence and report actual interventions. Keep candidate changes isolated from authoritative downstream repositories. Independent review, scientific/data contracts and rollback boundaries remain mandatory when applicable.

These instructions replace older fixed phase paperwork, mandatory report bundles, bulk reading and worktree creation for every edit. Relevant product contracts and technical boundaries still apply. User instructions in the current conversation take precedence.

## Zigma Core boundaries

- Use npm. Node >=22.5 is required for node:sqlite. npm run check typechecks and runs the built-CLI test suite; npm test builds first. Use the published-suite gate for provider/lifecycle changes.
- Keep dependencies directed toward contracts/domain. Validate transitions before writes; preserve immutable HumanDecision/PermissionSnapshot records and idempotent callbacks. Use injected ports for Flow and Workspace.
- Consult docs/api-contracts.md and docs/integration-contracts.md for interface changes, docs/architecture.md for boundaries, and docs/operations.md for operator runs and measurements. ESM imports use compiled .js extensions.
