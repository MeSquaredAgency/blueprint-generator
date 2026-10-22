import { z } from "zod";
import { AgentPrompt } from "./agent-prompt.ts";
import { Blueprint } from "./blueprint.ts";
import { ClientProfile } from "./client-profile.ts";
import { ClientId, EvidenceId, IsoDate, NonEmpty, OwnerRole } from "./common.ts";
import { EvidenceBundle } from "./evidence.ts";
import { checkSopBody, Sop, SopFields } from "./sop.ts";
import { Task, TaskId } from "./task.ts";

// Schemas for what each pipeline stage returns. The `*Draft` and stage-result
// schemas are what the model fills; everything else is assembled by code.

// ---- 1 Prepare -------------------------------------------------------------

export const InterviewKit = z.object({
  questionnaire: z
    .array(z.object({ question: NonEmpty, why: NonEmpty }))
    .min(1)
    .describe("Pre-call questions the client answers in writing"),
  guide: z
    .array(
      z.object({
        section: NonEmpty,
        goal: NonEmpty,
        questions: z.array(NonEmpty).min(1),
        probes: z.array(NonEmpty).describe("Follow-ups that draw out exceptions: 'unless', 'except when', 'what if'"),
      }),
    )
    .min(1),
});
export type InterviewKit = z.infer<typeof InterviewKit>;

// ---- 3 Redact ---------------------------------------------------------------

export const RedactionCategory = z.enum(["CUSTOMER", "TENANT", "OWNER", "CONTACT", "ADDRESS", "PHONE", "EMAIL", "OTHER"]);
export type RedactionCategory = z.infer<typeof RedactionCategory>;

export const RedactionFlags = z.object({
  flags: z.array(
    z.object({
      evidenceId: EvidenceId,
      text: NonEmpty.describe("The exact text to replace, copied character for character"),
      category: RedactionCategory,
    }),
  ),
});
export type RedactionFlags = z.infer<typeof RedactionFlags>;

// ---- 4 Extract --------------------------------------------------------------

export const Business = z.object({
  summary: NonEmpty,
  services: z.array(NonEmpty).min(1),
  systems: z.array(z.object({ name: NonEmpty, purpose: NonEmpty, usedBy: z.array(NonEmpty) })),
  roles: z.array(z.object({ name: NonEmpty, holder: NonEmpty.optional(), responsibilities: z.array(NonEmpty) })),
  approvals: z.array(z.object({ what: NonEmpty, approver: NonEmpty })),
  glossary: z.array(z.object({ term: NonEmpty, meaning: NonEmpty })),
});
export type Business = z.infer<typeof Business>;

export const Route = z.object({ taskId: TaskId, route: OwnerRole, rationale: NonEmpty });
export type Route = z.infer<typeof Route>;

export const ExtractResult = z
  .object({
    business: Business,
    tasks: z.array(Task).min(1),
    routing: z.array(Route),
  })
  .superRefine((result, ctx) => {
    const ids = result.tasks.map((t) => t.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["tasks"], message: "Task IDs must be unique" });
    const routed = result.routing.map((r) => r.taskId);
    for (const id of ids) {
      if (routed.filter((r) => r === id).length !== 1) {
        ctx.addIssue({ code: "custom", path: ["routing"], message: `Route ${id} exactly once` });
      }
    }
    for (const id of routed) {
      if (!ids.includes(id)) ctx.addIssue({ code: "custom", path: ["routing"], message: `Unknown task ${id}` });
    }
  });
export type ExtractResult = z.infer<typeof ExtractResult>;

// ---- 5 Reconcile ------------------------------------------------------------

export const GapKind = z.enum([
  "not_described",
  "unknown_trigger",
  "unknown_frequency",
  "unknown_owner",
  "missing_steps",
  "other",
]);

export const Reconciliation = z.object({
  segments: z
    .array(
      z.object({
        segmentId: EvidenceId,
        taskIds: z.array(TaskId),
        outOfScope: z.boolean().describe("True for consent, small talk and anything that is not a business process"),
      }),
    )
    .describe("Every transcript segment, in order"),
  merges: z.array(z.object({ keep: TaskId, merge: z.array(TaskId).min(1), reason: NonEmpty })),
  contradictions: z.array(
    z.object({
      topic: NonEmpty,
      detail: NonEmpty,
      said: z.array(EvidenceId).min(1).describe("What the interview says"),
      shown: z.array(EvidenceId).min(1).describe("What the documents show"),
      taskId: TaskId.optional(),
    }),
  ),
  gaps: z.array(
    z.object({ kind: GapKind, detail: NonEmpty, taskId: TaskId.optional(), evidence: z.array(EvidenceId) }),
  ),
  followUps: z.array(
    z.object({ question: NonEmpty, why: NonEmpty, taskId: TaskId.optional(), evidence: z.array(EvidenceId) }),
  ),
});
export type Reconciliation = z.infer<typeof Reconciliation>;

// ---- 6 Draft SOPs -----------------------------------------------------------

// Code sets the ID, task, owner (from routing), status, version and dates.
export const FunctionCode = z.enum(["ADM", "CMP", "CUS", "FIN", "HR", "MKT", "OPS", "PAY", "SAL"]);

export const SopDraft = SopFields.omit({
  id: true,
  taskId: true,
  owner: true,
  status: true,
  version: true,
  versionDate: true,
  reviewBy: true,
})
  .extend({
    functionCode: FunctionCode.describe(
      "ADM admin, CMP compliance, CUS customer service, FIN finance, HR people, MKT marketing, OPS operations, PAY payroll, SAL sales",
    ),
  })
  .superRefine(checkSopBody);
export type SopDraft = z.infer<typeof SopDraft>;

// ---- 7 Compile --------------------------------------------------------------

export const VoiceDraft = z.object({
  greetings: z.array(NonEmpty).min(1),
  signOffs: z.array(NonEmpty).min(1),
  formality: z.enum(["formal", "neutral", "casual"]),
  useWords: z.array(NonEmpty),
  avoidWords: z.array(NonEmpty),
  exampleIds: z.array(EvidenceId).min(3).max(5).describe("Emails written by the client's own staff that show the voice best"),
});
export type VoiceDraft = z.infer<typeof VoiceDraft>;

export const Coverage = z.object({
  transcriptSegments: z.int().nonnegative(),
  mappedToTask: z.int().nonnegative(),
  outOfScope: z.int().nonnegative(),
  unmapped: z.array(EvidenceId),
  share: z.number().min(0).max(1).describe("Share of segments mapped to a task or marked out of scope"),
  steps: z.object({ total: z.int().nonnegative(), evidenced: z.int().nonnegative(), assumed: z.int().nonnegative() }),
  bySop: z.array(z.object({ sopId: NonEmpty, steps: z.int().nonnegative(), assumed: z.int().nonnegative() })),
});
export type Coverage = z.infer<typeof Coverage>;

// The one structured data file per client. Every output is rendered from it.
export const ClientData = z.object({
  schemaVersion: z.literal(1),
  clientId: ClientId,
  asOf: IsoDate,
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  profile: ClientProfile,
  interviewKit: InterviewKit,
  evidence: EvidenceBundle,
  business: Business,
  tasks: z.array(Task),
  routing: z.array(Route),
  reconciliation: Reconciliation,
  sops: z.array(z.object({ sop: Sop, evidenceProvided: z.array(EvidenceId) })),
  skippedTasks: z.array(z.object({ taskId: TaskId, reason: NonEmpty })),
  blueprint: Blueprint,
  agentPrompt: AgentPrompt.nullable(),
  agentPromptGap: NonEmpty.optional(),
  coverage: Coverage,
});
export type ClientData = z.infer<typeof ClientData>;
