import { z } from "zod";
import { Citation, EvidenceId, Frequency, IsoDate, NonEmpty, OwnerRole, ReviewStatus } from "./common.ts";
import { TaskId } from "./task.ts";

// Client prefix, function code, number: APN-FIN-004.
export const SOP_ID = /^([A-Z]{2,5})-([A-Z]{2,4})-(\d{3})$/;
export const SopId = z.string().regex(SOP_ID, "Expected client prefix, function code and number, e.g. APN-FIN-004");

// Quality checks must be observable. These phrases describe effort, not an outcome.
const VAGUE_CHECK = /\b(check(ed)? carefully|carefully check|double[- ]check|looks (right|good|ok|fine))\b/i;

export const REQUIRED_ESCALATIONS = ["money", "legal", "complaints"] as const;

const Score = z.int().min(1).max(5);

export const SopStep = z.object({
  n: z.int().positive(),
  actor: OwnerRole,
  action: NonEmpty.describe("One action, verb first"),
  system: NonEmpty.optional(),
  evidence: Citation,
});
export type SopStep = z.infer<typeof SopStep>;

// One SOP in the Me² standard (docs/PLAN.md, "The Me² SOP standard").
export const Sop = z
  .object({
    id: SopId,
    title: NonEmpty.describe("Verb first, e.g. 'Send monthly owner statements'"),
    taskId: TaskId,

    trigger: NonEmpty,
    frequency: Frequency,

    owner: OwnerRole,
    contributors: z.array(OwnerRole),

    systems: z
      .array(
        z.object({
          name: NonEmpty.describe("Exactly as the client names it"),
          kind: z.enum(["app", "folder", "login", "other"]),
        }),
      )
      .describe("Every app, folder or login touched"),

    inputs: z.array(z.object({ item: NonEmpty, source: NonEmpty.optional() })),
    outputs: z
      .array(z.object({ item: NonEmpty, destination: NonEmpty.describe("Where it is saved or sent") }))
      .min(1),

    steps: z.array(SopStep).min(1),

    decisionPoints: z.array(
      z.object({
        condition: NonEmpty.describe("From 'unless' / 'except when' in the transcript"),
        action: NonEmpty,
        evidence: Citation,
      }),
    ),

    qualityChecks: z
      .array(
        NonEmpty.refine((s) => !VAGUE_CHECK.test(s), "Quality checks must be observable, not 'check carefully'"),
      )
      .min(1),

    escalation: z.array(
      z.object({
        topic: z.enum([...REQUIRED_ESCALATIONS, "other"]),
        when: NonEmpty,
        contact: NonEmpty,
      }),
    ),

    // Redacted real examples only, so every template cites where it came from.
    templates: z.array(
      z.object({
        name: NonEmpty,
        kind: z.enum(["email", "invoice", "document", "other"]),
        link: NonEmpty,
        evidence: z.array(EvidenceId).min(1),
      }),
    ),

    scoring: z.object({
      minutesPerRun: z.number().positive(),
      repeatability: Score,
      manualTime: Score,
      buildEffort: Score,
    }),

    status: ReviewStatus,
    version: z.int().positive(),
    versionDate: IsoDate,
    reviewBy: IsoDate,
  })
  .superRefine((sop, ctx) => {
    if (sop.contributors.includes(sop.owner)) {
      ctx.addIssue({ code: "custom", path: ["contributors"], message: "The owner is not also a contributor" });
    }
    sop.steps.forEach((step, i) => {
      if (step.n !== i + 1) {
        ctx.addIssue({ code: "custom", path: ["steps", i, "n"], message: `Steps are numbered 1..n; expected ${i + 1}` });
      }
    });
    for (const topic of REQUIRED_ESCALATIONS) {
      if (!sop.escalation.some((e) => e.topic === topic)) {
        ctx.addIssue({ code: "custom", path: ["escalation"], message: `Escalation must cover ${topic}` });
      }
    }
    if (sop.reviewBy <= sop.versionDate) {
      ctx.addIssue({ code: "custom", path: ["reviewBy"], message: "Review date must be after the version date" });
    }
  });
export type Sop = z.infer<typeof Sop>;
