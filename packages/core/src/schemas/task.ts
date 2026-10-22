import { z } from "zod";
import { ClientId, Confidence, EvidenceId, Frequency, NonEmpty } from "./common.ts";

export const TaskId = z.string().regex(/^TASK-\d{3,}$/, "Expected TASK-001");

// One row of the task inventory returned by the Extract stage.
export const Task = z.object({
  id: TaskId,
  name: NonEmpty,
  trigger: NonEmpty,
  frequency: Frequency,
  currentOwner: NonEmpty.describe("Who does it today, as the client describes them"),
  systems: z.array(NonEmpty),
  inputs: z.array(NonEmpty),
  outputs: z.array(NonEmpty),
  evidence: z.array(EvidenceId).min(1),
  confidence: Confidence,
});
export type Task = z.infer<typeof Task>;

export const TaskInventory = z
  .object({
    clientId: ClientId,
    tasks: z.array(Task),
  })
  .superRefine((inventory, ctx) => {
    const seen = new Set<string>();
    inventory.tasks.forEach((task, i) => {
      if (seen.has(task.id)) {
        ctx.addIssue({ code: "custom", path: ["tasks", i, "id"], message: `Duplicate task ID ${task.id}` });
      }
      seen.add(task.id);
    });
  });
export type TaskInventory = z.infer<typeof TaskInventory>;
