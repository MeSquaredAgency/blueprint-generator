# Me² Blueprint Generator

Internal pipeline: intake interview + client documents → Operational Blueprint, cited SOP
library, gap report and follow-up questions, and a drafting-agent prompt. See
[`docs/PLAN.md`](docs/PLAN.md) for the plan and [`CLAUDE.md`](CLAUDE.md) for build rules.

```sh
npm ci
npm run check   # typecheck + tests
```

Requires Node 22.18 or later.

## Run it

```sh
npm run blueprint -- run --client harbour-plumbing          # stops for redaction review
npm run blueprint -- confirm-redaction --client harbour-plumbing --by "Your Name"
npm run blueprint -- run --client harbour-plumbing          # finishes the run
```

Outputs land in `out/harbour-plumbing/`. Model calls need `ME2_ANTHROPIC_API_KEY` in the
environment; responses are cached, so a re-run on unchanged input makes no calls.

**Status:** Phase 2 (CLI pipeline, end to end).
