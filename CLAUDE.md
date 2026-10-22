# Me² Blueprint Generator

Turns an intake interview transcript plus a client's documents into an Operational
Blueprint, a cited SOP library, a gap report and a drafting-agent prompt. The full plan
is `docs/PLAN.md`; read it before starting any phase.

## How to work

- One phase at a time, in the order in `docs/PLAN.md`. At the end of a phase, run its
  "Done when" checks, show the results, and stop for review before starting the next.
- Ask before adding a dependency the plan doesn't name. Named or approved so far:
  TypeScript, `@types/node`, Zod, the Anthropic TypeScript SDK, unpdf, mammoth, SheetJS
  (installed from the SheetJS CDN, not the stale npm copy), mailparser, Vite, React, and
  the Cloudflare platform (R2, D1, Workflows, Access).

## Rules for the whole build

- **Fixture data only.** Anything that reads client data must check the `REAL_CLIENT_DATA`
  flag (`readFlags` in `packages/core/src/flags.ts`) and refuse anything outside
  `fixtures/` unless it is on.
- **Every flag defaults to off**: `REAL_CLIENT_DATA`, `GOOGLE_DOCS_EXPORT`,
  `CLIENT_SIGNOFF`, `AUTO_TRANSCRIBE`. Only an explicit `1` or `true` turns one on.
- **Secrets come from the environment only.** Never commit API keys or client files.
  Client folders (`clients/`) are gitignored; only `fixtures/` holds data in the repo.
  The pipeline reads its key from `ME2_ANTHROPIC_API_KEY` (named in
  `blueprint.config.json`), never `ANTHROPIC_API_KEY`, which Claude Code itself uses.
- **Model IDs come from config** (`blueprint.config.json`), never hard-coded in pipeline code.
- **Every SOP step cites an evidence ID or says `ASSUMED`.** The schema enforces the
  shape; Phase 2 adds the validator that fails a run when a cited ID doesn't exist.
- **Code, not the model, assembles outputs.** The model fills schemas; Compile renders.
- **Approved SOPs are never overwritten**, only superseded by a new version.
- AI drafts, the operator checks, the client signs off. Nothing becomes an approved SOP
  or a live agent prompt without both human steps.

## Layout

- `packages/core` — the pipeline library. Zod schemas in `src/schemas/`, exported to
  `json-schema/` by `npm run schemas:export` (a test fails if the export is stale).
  One file per stage concern: `ingest.ts`, `redact.ts`, `prompts.ts`, `compile.ts`,
  `validate.ts`, `render.ts`, orchestrated by `pipeline.ts`. `llm.ts` is the only code
  that calls the API; every response is cached under `out/<client>/.cache/` by a hash
  of the request, which is what makes a re-run produce no diff.
- `apps/cli` — the `blueprint` command. `apps/web` — review UI (Phase 4).
- `out/<client>/` — run outputs (gitignored): `client-data.json` (the one data file
  every output is rendered from) and the Markdown documents.
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
- `npm run fixture:evidence` — regenerate the fixture's `sample/evidence.json` from Ingest
- `npm run check` — both, as CI runs them
- `npm run blueprint -- run --client harbour-plumbing` — run the pipeline. It stops after
  Redact; `npm run blueprint -- confirm-redaction --client harbour-plumbing --by "<name>"`
  records the human check, then `run` again continues. `--offline` uses only cached
  responses. `npm run blueprint -- validate --client <id>` re-checks an existing run.

Tests never call the API: `packages/core/test/fake-model.ts` answers each stage from the
fixture's `sample/` files.
