import { compareEvidenceIds } from "./redact.ts";
import type {
  AgentPrompt,
  Blueprint,
  Business,
  ClientProfile,
  Coverage,
  EvidenceBundle,
  ExtractResult,
  Reconciliation,
  Route,
  Sop,
  SopDraft,
  Task,
  VoiceDraft,
} from "./schemas/index.ts";

// Stage 7: code, not the model, assembles the outputs from the stage results.

export const sortIds = (ids: Iterable<string>) => [...new Set(ids)].sort(compareEvidenceIds);

// Folds duplicate tasks into the one Reconcile says to keep.
export function applyMerges(
  extract: ExtractResult,
  reconciliation: Reconciliation,
): { tasks: Task[]; routing: Route[]; reconciliation: Reconciliation } {
  const into = new Map<string, string>();
  for (const m of reconciliation.merges) for (const id of m.merge) if (id !== m.keep) into.set(id, m.keep);
  const target = (id: string) => into.get(id) ?? id;
  const tasks = extract.tasks
    .filter((t) => !into.has(t.id))
    .map((t) => {
      const merged = extract.tasks.filter((other) => into.get(other.id) === t.id);
      return merged.length ? { ...t, evidence: sortIds([...t.evidence, ...merged.flatMap((m) => m.evidence)]) } : t;
    });
  const remapOptional = <T extends { taskId?: string | undefined }>(x: T): T =>
    x.taskId === undefined ? x : { ...x, taskId: target(x.taskId) };
  return {
    tasks,
    routing: extract.routing.filter((r) => !into.has(r.taskId)),
    reconciliation: {
      ...reconciliation,
      segments: reconciliation.segments.map((s) => ({ ...s, taskIds: [...new Set(s.taskIds.map(target))] })),
      contradictions: reconciliation.contradictions.map(remapOptional),
      gaps: reconciliation.gaps.map(remapOptional),
      followUps: reconciliation.followUps.map(remapOptional),
    },
  };
}

// The evidence a task's SOP is drafted from: what Extract cited plus every
// transcript segment Reconcile mapped to it. A citation of a whole document
// (D-03) brings in all of its pages and sheets.
export function taskEvidence(task: Task, reconciliation: Reconciliation, evidence: EvidenceBundle): string[] {
  const segments = reconciliation.segments.filter((s) => s.taskIds.includes(task.id)).map((s) => s.segmentId);
  const cited = new Set([...task.evidence, ...segments]);
  const parts = evidence.items.filter((i) => i.kind !== "transcript_segment" && cited.has(i.documentId)).map((i) => i.id);
  return sortIds([...cited, ...parts]);
}

export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(d, lastDay));
  return date.toISOString().slice(0, 10);
}

// SOP IDs number per function code, in task order, so they are stable.
export function buildSops(
  drafts: { task: Task; route: Route; draft: SopDraft }[],
  profile: ClientProfile,
  asOf: string,
  reviewMonths: number,
): Sop[] {
  const counters = new Map<string, number>();
  return drafts.map(({ task, route, draft }) => {
    const n = (counters.get(draft.functionCode) ?? 0) + 1;
    counters.set(draft.functionCode, n);
    const { functionCode, contributors, ...body } = draft;
    return {
      id: `${profile.clientPrefix}-${functionCode}-${String(n).padStart(3, "0")}`,
      taskId: task.id,
      ...body,
      owner: route.route,
      contributors: [...new Set(contributors)].filter((c) => c !== route.route),
      status: "draft",
      version: 1,
      versionDate: asOf,
      reviewBy: addMonths(asOf, reviewMonths),
    };
  });
}

const SCHEDULED = new Set(["daily", "weekly", "fortnightly", "monthly", "quarterly", "annual"]);

export function buildBlueprint(
  profile: ClientProfile,
  business: Business,
  tasks: Task[],
  routing: Route[],
  sops: Sop[],
  asOf: string,
): Blueprint {
  const sopFor = new Map(sops.map((s) => [s.taskId, s.id]));
  const routeFor = new Map(routing.map((r) => [r.taskId, r]));
  return {
    clientId: profile.clientId,
    clientName: profile.clientName,
    clientPrefix: profile.clientPrefix,
    status: "draft",
    version: 1,
    versionDate: asOf,
    overview: {
      summary: business.summary,
      industry: profile.industry,
      services: business.services,
      teamSize: profile.teamSize,
      approvals: business.approvals,
    },
    systems: business.systems,
    roles: business.roles,
    calendar: tasks
      .filter((t) => SCHEDULED.has(t.frequency.cadence))
      .map((t) => ({
        taskId: t.id,
        cadence: t.frequency.cadence,
        ...(t.frequency.detail ? { when: t.frequency.detail } : {}),
      })),
    routing: tasks.map((t) => {
      const route = routeFor.get(t.id) as Route;
      const sopId = sopFor.get(t.id);
      return { taskId: t.id, ...(sopId ? { sopId } : {}), route: route.route, rationale: route.rationale };
    }),
  };
}

// The prompt's fixed sections live in the template (render.ts); this is the data.
export function buildAgentPrompt(
  blueprint: Blueprint,
  business: Business,
  sops: Sop[],
  voice: VoiceDraft,
  evidence: EvidenceBundle,
  asOf: string,
): AgentPrompt {
  const approvals = business.approvals.map((a) => `${a.approver}: ${a.what}`).join("; ");
  const textOf = new Map(evidence.items.flatMap((i) => (i.kind === "email" ? [[i.id, i.text] as const] : [])));
  return {
    clientId: blueprint.clientId,
    clientName: blueprint.clientName,
    version: 1,
    blueprintVersion: blueprint.version,
    compiledOn: asOf,
    business: approvals ? `${business.summary}\n\nWho approves what: ${approvals}.` : business.summary,
    voice: {
      greetings: voice.greetings,
      signOffs: voice.signOffs,
      formality: voice.formality,
      useWords: voice.useWords,
      avoidWords: voice.avoidWords,
      examples: voice.exampleIds.map((id) => ({ text: textOf.get(id) as string, evidence: [id] })),
    },
    drafts: sops
      .filter((s) => s.owner === "ai_role")
      .map((s) => ({
        sopId: s.id,
        trigger: s.trigger,
        inputs: s.inputs.map((i) => i.item),
        outputFormat: s.outputs.map((o) => `${o.item}, ${o.destination}`).join("; "),
        ...(s.templates[0] ? { templateLink: s.templates[0].link } : {}),
        qualityChecks: s.qualityChecks,
      })),
    complianceRules: [],
    stopAndFlag: [...new Set([...sops.flatMap((s) => s.escalation.map((e) => e.when)), "Anything not covered above"])],
    glossary: business.glossary,
  };
}

export function computeCoverage(evidence: EvidenceBundle, reconciliation: Reconciliation, tasks: Task[], sops: Sop[]): Coverage {
  const taskIds = new Set(tasks.map((t) => t.id));
  const bySegment = new Map(reconciliation.segments.map((s) => [s.segmentId, s]));
  let mappedToTask = 0;
  let outOfScope = 0;
  const unmapped: string[] = [];
  const segments = evidence.items.filter((i) => i.kind === "transcript_segment");
  for (const seg of segments) {
    const r = bySegment.get(seg.id);
    if (r && r.taskIds.some((id) => taskIds.has(id))) mappedToTask++;
    else if (r?.outOfScope) outOfScope++;
    else unmapped.push(seg.id);
  }
  const steps = sops.flatMap((s) => s.steps);
  const assumed = steps.filter((s) => s.evidence === "ASSUMED").length;
  return {
    transcriptSegments: segments.length,
    mappedToTask,
    outOfScope,
    unmapped,
    share: segments.length ? Math.round(((mappedToTask + outOfScope) / segments.length) * 1000) / 1000 : 0,
    steps: { total: steps.length, evidenced: steps.length - assumed, assumed },
    bySop: sops.map((s) => ({ sopId: s.id, steps: s.steps.length, assumed: s.steps.filter((x) => x.evidence === "ASSUMED").length })),
  };
}
