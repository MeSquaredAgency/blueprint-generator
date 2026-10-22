import { readFileSync } from "node:fs";
import { z } from "zod";

// Model IDs live here, never in pipeline code (CLAUDE.md).
export const STAGES = ["prepare", "redact", "extract", "reconcile", "draftSop", "voice"] as const;
export type Stage = (typeof STAGES)[number];

const StageModel = z.object({
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
});
export type StageModel = z.infer<typeof StageModel>;

export const PipelineConfig = z.object({
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  stages: z.object(Object.fromEntries(STAGES.map((s) => [s, StageModel])) as Record<Stage, typeof StageModel>),
  maxTokens: z.int().positive(),
  concurrency: z.int().positive(),
  // Server-side refusal fallback (beta). Haiku-class models have none, so it is
  // only requested for the other stages.
  refusalFallback: z.boolean(),
  sopReviewMonths: z.int().positive(),
});
export type PipelineConfig = z.infer<typeof PipelineConfig>;

export function loadConfig(path: string): PipelineConfig {
  return PipelineConfig.parse(JSON.parse(readFileSync(path, "utf8")));
}
