import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyMerges, buildAgentPrompt, buildBlueprint, buildSops, computeCoverage, taskEvidence } from "./compile.ts";
import type { PipelineConfig } from "./config.ts";
import type { Flags } from "./flags.ts";
import { assertDataAllowed } from "./gate.ts";
import { ingest } from "./ingest.ts";
import { mapLimit, type ModelClient } from "./llm.ts";
import {
  draftPrompt,
  draftSystem,
  EXTRACT_SYSTEM,
  extractPrompt,
  PREPARE_SYSTEM,
  preparePrompt,
  RECONCILE_SYSTEM,
  reconcilePrompt,
  renderEvidence,
  VOICE_SYSTEM,
  voicePrompt,
} from "./prompts.ts";
import { hashJson, proposeRedaction, type RedactionConfirmation, type RedactionProposal } from "./redact.ts";
import {
  ROLE_LABEL,
  renderAgentPrompt,
  renderBlueprint,
  renderCoverage,
  renderGaps,
  renderInterviewKit,
  renderRedaction,
  renderSop,
} from "./render.ts";
import {
  ClientProfile,
  ExtractResult,
  InterviewKit,
  Reconciliation,
  SopDraft,
  VoiceDraft,
  type ClientData,
  type Coverage,
} from "./schemas/index.ts";
import { citableIds, validateClientData, ValidationFailedError } from "./validate.ts";

export interface RunOptions {
  repoRoot: string;
  clientDir: string;
  outDir: string;
  config: PipelineConfig;
  flags: Flags;
  model: ModelClient;
  // The date a fresh run is stamped with. A re-run on unchanged input keeps
  // the earlier date, so it produces no diff.
  today: string;
  confirmCommand: string;
  log?: (line: string) => void;
}

export type RunResult =
  | { status: "awaiting_redaction_confirmation"; proposal: string }
  | { status: "complete"; coverage: Coverage; files: string[] };

export const CLIENT_DATA_FILE = "client-data.json";
const PROPOSAL_FILE = "redaction.json";
const CONFIRMATION_FILE = "redaction-confirmed.json";

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

export async function runPipeline(o: RunOptions): Promise<RunResult> {
  const log = o.log ?? (() => {});
  assertDataAllowed(o.clientDir, o.repoRoot, o.flags);
  const write = (rel: string, content: string) => {
    const path = join(o.outDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return rel;
  };
  const profile = ClientProfile.parse(readJson(join(o.clientDir, "client.json")));

  log("1 Prepare");
  const interviewKit = await o.model.generate({
    stage: "prepare",
    label: "prepare",
    system: PREPARE_SYSTEM,
    prompt: preparePrompt(profile),
    schema: InterviewKit,
  });
  write("interview-kit.md", renderInterviewKit(profile.clientName, interviewKit));

  log("2 Ingest");
  const bundle = await ingest(o.clientDir, profile.clientId);
  const inputHash = hashJson([profile, bundle, o.config]);
  const asOf = asOfFor(o, inputHash);

  log("3 Redact");
  const { proposal, redacted } = await proposeRedaction(bundle, profile, o.model);
  write(PROPOSAL_FILE, json(proposal));
  write("redaction.md", renderRedaction(profile.clientName, proposal, o.confirmCommand));
  if (!isConfirmed(o.outDir, proposal)) {
    return { status: "awaiting_redaction_confirmation", proposal: join(o.outDir, "redaction.md") };
  }

  log("4 Extract");
  const ids = citableIds({ evidence: redacted });
  const unknown = (where: string, cited: readonly string[]) =>
    cited.filter((id) => !ids.has(id)).map((id) => `${where} cites ${id}, which isn't in the evidence`);
  const evidenceText = renderEvidence(redacted.items, redacted.documents);
  const extract = await o.model.generate({
    stage: "extract",
    label: "extract",
    system: EXTRACT_SYSTEM,
    prompt: extractPrompt(profile, evidenceText),
    schema: ExtractResult,
    check: (r) => r.tasks.flatMap((t) => unknown(t.id, t.evidence)),
  });

  log("5 Reconcile");
  const segmentIds = redacted.items.filter((i) => i.kind === "transcript_segment").map((i) => i.id);
  const reconciliation = await o.model.generate({
    stage: "reconcile",
    label: "reconcile",
    system: RECONCILE_SYSTEM,
    prompt: reconcilePrompt(extract, evidenceText),
    schema: Reconciliation,
    check: (r) => checkReconciliation(r, segmentIds, new Set(extract.tasks.map((t) => t.id)), unknown),
  });
  const merged = applyMerges(extract, reconciliation);

  log("6 Draft SOPs");
  const notDescribed = new Map(
    merged.reconciliation.gaps.flatMap((g) => (g.kind === "not_described" && g.taskId ? [[g.taskId, g.detail] as const] : [])),
  );
  const skippedTasks = merged.tasks
    .filter((t) => notDescribed.has(t.id))
    .map((t) => ({ taskId: t.id, reason: `Not described yet: ${notDescribed.get(t.id)}` }));
  const routeFor = new Map(merged.routing.map((r) => [r.taskId, r]));
  const system = draftSystem(profile, extract.business);
  const drafted = await mapLimit(
    merged.tasks.filter((t) => !notDescribed.has(t.id)),
    o.config.concurrency,
    async (task) => {
      const provided = taskEvidence(task, merged.reconciliation, redacted);
      const allowed = new Set([...provided, ...provided.map((id) => id.split(" ")[0] as string)]);
      const route = routeFor.get(task.id)!;
      const draft = await o.model.generate({
        stage: "draftSop",
        label: `draftSop ${task.id}`,
        system,
        prompt: draftPrompt(task, ROLE_LABEL[route.route], renderEvidence(redacted.items.filter((i) => allowed.has(i.id)), redacted.documents)),
        schema: SopDraft,
        check: (d) =>
          draftCitations(d)
            .filter(([, id]) => !allowed.has(id))
            .map(([where, id]) => `${where} cites ${id}, which isn't in the evidence given for this task`),
      });
      return { task, route, draft, provided };
    },
  );
  const sops = buildSops(drafted, profile, asOf, o.config.sopReviewMonths);

  log("7 Compile");
  const blueprint = buildBlueprint(profile, extract.business, merged.tasks, merged.routing, sops, asOf);
  const emails = redacted.items.filter((i) => i.kind === "email");
  let agentPrompt: ClientData["agentPrompt"] = null;
  let agentPromptGap: string | undefined;
  if (emails.length >= 3) {
    const emailIds = new Set(emails.map((e) => e.id));
    const voice = await o.model.generate({
      stage: "voice",
      label: "voice",
      system: VOICE_SYSTEM,
      prompt: voicePrompt(profile, renderEvidence(emails, redacted.documents)),
      schema: VoiceDraft,
      check: (v) => v.exampleIds.filter((id) => !emailIds.has(id)).map((id) => `${id} is not one of the emails`),
    });
    agentPrompt = buildAgentPrompt(blueprint, extract.business, sops, voice, redacted, asOf);
  } else {
    agentPromptGap = `The agent prompt needs at least 3 sample emails from the client; the evidence has ${emails.length}.`;
  }

  const data: ClientData = {
    schemaVersion: 1,
    clientId: profile.clientId,
    asOf,
    inputHash,
    profile,
    interviewKit,
    evidence: redacted,
    business: extract.business,
    tasks: merged.tasks,
    routing: merged.routing,
    reconciliation: merged.reconciliation,
    sops: sops.map((sop, i) => ({ sop, evidenceProvided: drafted[i]!.provided })),
    skippedTasks,
    blueprint,
    agentPrompt,
    ...(agentPromptGap ? { agentPromptGap } : {}),
    coverage: computeCoverage(redacted, merged.reconciliation, merged.tasks, sops),
  };

  const issues = validateClientData(data);
  if (issues.length) {
    write("validation-errors.md", `# Validation failed\n\n${issues.map((i) => `- ${i}`).join("\n")}\n`);
    throw new ValidationFailedError(issues);
  }
  rmSync(join(o.outDir, "validation-errors.md"), { force: true });
  return { status: "complete", coverage: data.coverage, files: writeOutputs(data, o.outDir, write) };
}

function writeOutputs(data: ClientData, outDir: string, write: (rel: string, content: string) => string): string[] {
  rmSync(join(outDir, "sops"), { recursive: true, force: true });
  return [
    write(CLIENT_DATA_FILE, json(data)),
    write("blueprint.md", renderBlueprint(data)),
    ...data.sops.map(({ sop }) => write(`sops/${sop.id}.md`, renderSop(sop))),
    write("gaps.md", renderGaps(data)),
    write("coverage.md", renderCoverage(data)),
    data.agentPrompt ? write("agent-prompt.md", renderAgentPrompt(data.agentPrompt)) : write("agent-prompt.md", `${data.agentPromptGap}\n`),
  ];
}

function asOfFor(o: RunOptions, inputHash: string): string {
  const previous = join(o.outDir, CLIENT_DATA_FILE);
  if (existsSync(previous)) {
    const data = readJson(previous) as Partial<ClientData>;
    if (data.inputHash === inputHash && typeof data.asOf === "string") return data.asOf;
  }
  return o.today;
}

function checkReconciliation(
  r: Reconciliation,
  segmentIds: string[],
  taskIds: Set<string>,
  unknown: (where: string, cited: readonly string[]) => string[],
): string[] {
  const issues: string[] = [];
  const listed = r.segments.map((s) => s.segmentId);
  const missing = segmentIds.filter((id) => !listed.includes(id));
  if (missing.length) issues.push(`segments is missing ${missing.join(", ")}; list every transcript segment once`);
  const extra = listed.filter((id, i) => !segmentIds.includes(id) || listed.indexOf(id) !== i);
  if (extra.length) issues.push(`segments lists ${extra.join(", ")}, which aren't transcript segments or are listed twice`);
  const known = (where: string, id: string | undefined) => (id === undefined || taskIds.has(id) ? [] : [`${where} refers to unknown task ${id}`]);
  r.segments.forEach((s) => s.taskIds.forEach((id) => issues.push(...known(s.segmentId, id))));
  r.merges.forEach((m, i) => [m.keep, ...m.merge].forEach((id) => issues.push(...known(`merge ${i + 1}`, id))));
  r.contradictions.forEach((c, i) => issues.push(...unknown(`contradiction ${i + 1}`, [...c.said, ...c.shown]), ...known(`contradiction ${i + 1}`, c.taskId)));
  r.gaps.forEach((g, i) => issues.push(...unknown(`gap ${i + 1}`, g.evidence), ...known(`gap ${i + 1}`, g.taskId)));
  r.followUps.forEach((f, i) => issues.push(...unknown(`follow-up ${i + 1}`, f.evidence), ...known(`follow-up ${i + 1}`, f.taskId)));
  return issues;
}

function draftCitations(d: SopDraft): [string, string][] {
  const out: [string, string][] = [];
  const add = (where: string, c: readonly string[] | "ASSUMED") => {
    if (c !== "ASSUMED") for (const id of c) out.push([where, id]);
  };
  d.steps.forEach((s) => add(`step ${s.n}`, s.evidence));
  d.decisionPoints.forEach((p, i) => add(`decision point ${i + 1}`, p.evidence));
  d.templates.forEach((t) => add(`template "${t.name}"`, t.evidence));
  return out;
}

// ---- redaction sign-off -----------------------------------------------------------

function isConfirmed(outDir: string, proposal: RedactionProposal): boolean {
  const path = join(outDir, CONFIRMATION_FILE);
  if (!existsSync(path)) return false;
  return (readJson(path) as RedactionConfirmation).proposalHash === hashJson(proposal);
}

export function confirmRedaction(outDir: string, confirmedBy: string, confirmedAt: string): RedactionConfirmation {
  const path = join(outDir, PROPOSAL_FILE);
  if (!existsSync(path)) throw new Error(`No redaction proposal at ${path}; run the pipeline first`);
  const confirmation = { proposalHash: hashJson(readJson(path)), confirmedBy, confirmedAt };
  writeFileSync(join(outDir, CONFIRMATION_FILE), json(confirmation));
  return confirmation;
}
