# Me² Blueprint Generator

Turns an intake interview transcript plus a client's documents into an Operational
Blueprint, a cited SOP library, a gap report and a drafting-agent prompt. The full plan
is `docs/PLAN.md`; read it before starting any phase.

## How to work

- One phase at a time, in the order in `docs/PLAN.md`. At the end of a phase, run its
  "Done when" checks, show the results, and stop for review before starting the next.
- Ask before adding a dependency the plan doesn't name. Named so far: TypeScript, Zod,
  the Anthropic TypeScript SDK, mammoth, SheetJS, mailparser, Vite, React, and the
  Cloudflare platform (R2, D1, Workflows, Access).

## Rules for the whole build

- **Fixture data only.** Anything that reads client data must check the `REAL_CLIENT_DATA`
  flag (`readFlags` in `packages/core/src/flags.ts`) and refuse anything outside
  `fixtures/` unless it is on.
- **Every flag defaults to off**: `REAL_CLIENT_DATA`, `GOOGLE_DOCS_EXPORT`,
  `CLIENT_SIGNOFF`, `AUTO_TRANSCRIBE`. Only an explicit `1` or `true` turns one on.
- **Secrets come from the environment only.** Never commit API keys or client files.
  Client folders (`clients/`) are gitignored; only `fixtures/` holds data in the repo.
- **Model IDs come from config**, never hard-coded in pipeline code.
- **Every SOP step cites an evidence ID or says `ASSUMED`.** The schema enforces the
  shape; Phase 2 adds the validator that fails a run when a cited ID doesn't exist.
- **Code, not the model, assembles outputs.** The model fills schemas; Compile renders.
- **Approved SOPs are never overwritten**, only superseded by a new version.
- AI drafts, the operator checks, the client signs off. Nothing becomes an approved SOP
  or a live agent prompt without both human steps.

## Layout

- `packages/core` — the pipeline library. Zod schemas in `src/schemas/`, exported to
  `json-schema/` by `npm run schemas:export` (a test fails if the export is stale).
- `apps/cli` — the first runner (Phase 2). `apps/web` — review UI (Phase 4).
- `fixtures/harbour-plumbing` — the fictional fixture client. See its README for what's
  planted in it. `sample/` holds schema examples, not the Phase 3 golden task list.

## Conventions

- Evidence IDs: `T-0412` transcript segment, `D-03` whole document (emails),
  `D-03 p2` page, `D-04 s1` spreadsheet sheet. Document numbers follow sorted path order.
- SOP IDs: client prefix, function code, number (`HBP-FIN-001`); titles are verb first.
- Owner roles: `ai_role`, `operator`, `client_retained`, `automation`.
- Node ≥ 22.18 runs `.ts` directly (type stripping), so code must be erasable syntax
  only: no enums, namespaces or parameter properties. Import with `.ts` extensions.

## Commands

- `npm run typecheck` — `tsc` over `packages/*/src` and `apps/*/src`
- `npm test` — `node --test`, no extra runner
- `npm run schemas:export` — regenerate `packages/core/json-schema/`
- `npm run check` — both, as CI runs them
