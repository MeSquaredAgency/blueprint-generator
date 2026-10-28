import { ClientData } from "./schemas/index.ts";

// The run-level validator: a run that cites evidence that doesn't exist, or
// whose outputs disagree with each other, fails instead of producing outputs.

export class ValidationFailedError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Validation failed with ${issues.length} issue(s):\n- ${issues.join("\n- ")}`);
    this.issues = issues;
  }
}

// IDs that a citation may use: every item, plus each document as a whole.
export function citableIds(data: Pick<ClientData, "evidence">): Set<string> {
  return new Set([...data.evidence.items.map((i) => i.id), ...data.evidence.documents.map((d) => d.id)]);
}

export function validateClientData(input: unknown): string[] {
  const parsed = ClientData.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  const data = parsed.data;
  const issues: string[] = [];
  const ids = citableIds(data);
  const segmentIds = new Set(data.evidence.items.filter((i) => i.kind === "transcript_segment").map((i) => i.id));
  const taskIds = new Set(data.tasks.map((t) => t.id));
  const sopIds = new Set(data.sops.map((s) => s.sop.id));

  const cite = (where: string, cited: readonly string[] | "ASSUMED", allowed: Set<string> = ids) => {
    if (cited === "ASSUMED") return;
    for (const id of cited) {
      if (!ids.has(id)) issues.push(`${where} cites ${id}, which doesn't exist`);
      else if (!allowed.has(id) && !allowed.has(id.split(" ")[0] as string)) {
        issues.push(`${where} cites ${id}, which wasn't in the evidence it was drafted from`);
      }
    }
  };
  const knownTask = (where: string, id: string | undefined) => {
    if (id !== undefined && !taskIds.has(id)) issues.push(`${where} refers to unknown task ${id}`);
  };

  for (const task of data.tasks) cite(task.id, task.evidence);

  const routeFor = new Map(data.routing.map((r) => [r.taskId, r.route]));
  for (const id of taskIds) if (!routeFor.has(id)) issues.push(`${id} has no route`);

  for (const { sop, evidenceProvided } of data.sops) {
    // A citation to a document as a whole is fine if any part of it was provided.
    const allowed = new Set([...evidenceProvided, ...evidenceProvided.map((id) => id.split(" ")[0] as string)]);
    knownTask(sop.id, sop.taskId);
    if (routeFor.get(sop.taskId) !== sop.owner) issues.push(`${sop.id} owner ${sop.owner} doesn't match its task's route`);
    sop.steps.forEach((s) => cite(`${sop.id} step ${s.n}`, s.evidence, allowed));
    sop.decisionPoints.forEach((d, i) => cite(`${sop.id} decision ${i + 1}`, d.evidence, allowed));
    sop.templates.forEach((t) => cite(`${sop.id} template "${t.name}"`, t.evidence, allowed));
  }

  const r = data.reconciliation;
  for (const s of r.segments) {
    if (!segmentIds.has(s.segmentId)) issues.push(`Reconciliation maps ${s.segmentId}, which isn't a transcript segment`);
    s.taskIds.forEach((id) => knownTask(`Reconciliation of ${s.segmentId}`, id));
  }
  r.contradictions.forEach((c, i) => {
    cite(`Contradiction ${i + 1}`, [...c.said, ...c.shown]);
    knownTask(`Contradiction ${i + 1}`, c.taskId);
  });
  r.gaps.forEach((g, i) => {
    cite(`Gap ${i + 1}`, g.evidence);
    knownTask(`Gap ${i + 1}`, g.taskId);
  });
  r.followUps.forEach((f, i) => {
    cite(`Follow-up ${i + 1}`, f.evidence);
    knownTask(`Follow-up ${i + 1}`, f.taskId);
  });

  for (const route of data.blueprint.routing) {
    knownTask("Blueprint routing", route.taskId);
    if (route.sopId && !sopIds.has(route.sopId)) issues.push(`Blueprint routes ${route.taskId} to unknown SOP ${route.sopId}`);
  }
  data.blueprint.calendar.forEach((c) => knownTask("Blueprint calendar", c.taskId));

  if (data.agentPrompt) {
    data.agentPrompt.voice.examples.forEach((e, i) => cite(`Agent prompt voice example ${i + 1}`, e.evidence));
    for (const d of data.agentPrompt.drafts) if (!sopIds.has(d.sopId)) issues.push(`Agent prompt drafts unknown SOP ${d.sopId}`);
  }
  return issues;
}
