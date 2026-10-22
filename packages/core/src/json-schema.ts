import { z } from "zod";
import { AgentPrompt, Blueprint, ClientProfile, EvidenceBundle, Sop, TaskInventory } from "./schemas/index.ts";

// The schemas handed to the model as structured-output formats. Refinements
// (cross-field rules) don't survive export; outputs are re-validated with Zod.
export const SCHEMAS = {
  "client-profile": ClientProfile,
  "evidence-bundle": EvidenceBundle,
  "task-inventory": TaskInventory,
  sop: Sop,
  blueprint: Blueprint,
  "agent-prompt": AgentPrompt,
} as const;
export type SchemaName = keyof typeof SCHEMAS;

export function toJsonSchema(name: SchemaName): Record<string, unknown> {
  return z.toJSONSchema(SCHEMAS[name], { target: "draft-2020-12" }) as Record<string, unknown>;
}
