import { z } from "zod";
import { ClientId, EvidenceId, IsoDate, NonEmpty } from "./common.ts";
import { SopId } from "./sop.ts";

// The data the compiler fills into the fixed agent-prompt template (docs/PLAN.md,
// "The client drafting-agent prompt"). The Role section and the always-on rules
// live in the template; only the voice profile is model-written.
export const AgentPrompt = z.object({
  clientId: ClientId,
  clientName: NonEmpty,
  version: z.int().positive(),
  blueprintVersion: z.int().positive().describe("Ties every draft back to the SOPs that shaped it"),
  compiledOn: IsoDate,

  business: NonEmpty.describe("Overview, services, team and who approves what — from the Blueprint"),

  voice: z.object({
    greetings: z.array(NonEmpty).min(1),
    signOffs: z.array(NonEmpty).min(1),
    formality: z.enum(["formal", "neutral", "casual"]),
    useWords: z.array(NonEmpty),
    avoidWords: z.array(NonEmpty),
    // Redacted, approved samples only, so each example cites its source.
    examples: z
      .array(z.object({ text: NonEmpty, evidence: z.array(EvidenceId).min(1) }))
      .min(3)
      .max(5),
  }),

  // One block per AI-owned SOP.
  drafts: z.array(
    z.object({
      sopId: SopId,
      trigger: NonEmpty,
      inputs: z.array(NonEmpty),
      outputFormat: NonEmpty,
      templateLink: NonEmpty.optional(),
      qualityChecks: z.array(NonEmpty).min(1),
    }),
  ),

  complianceRules: z.array(NonEmpty).describe("Client-specific lines, e.g. licence number on all marketing"),
  stopAndFlag: z.array(NonEmpty).min(1).describe("Escalation list from the SOPs"),
  glossary: z.array(z.object({ term: NonEmpty, meaning: NonEmpty })),
});
export type AgentPrompt = z.infer<typeof AgentPrompt>;
