import { z } from "zod";
import { Cadence, ClientId, ClientPrefix, IsoDate, NonEmpty, OwnerRole, ReviewStatus } from "./common.ts";
import { SOP_ID, SopId } from "./sop.ts";
import { TaskId } from "./task.ts";

// The Operational Blueprint. Assembled by code in the Compile stage.
export const Blueprint = z
  .object({
    clientId: ClientId,
    clientName: NonEmpty,
    clientPrefix: ClientPrefix,

    status: ReviewStatus,
    version: z.int().positive(),
    versionDate: IsoDate,

    overview: z.object({
      summary: NonEmpty,
      industry: NonEmpty,
      services: z.array(NonEmpty).min(1),
      teamSize: z.int().positive(),
      approvals: z.array(z.object({ what: NonEmpty, approver: NonEmpty })).describe("Who approves what"),
    }),

    systems: z.array(z.object({ name: NonEmpty, purpose: NonEmpty, usedBy: z.array(NonEmpty) })),

    roles: z.array(z.object({ name: NonEmpty, holder: NonEmpty.optional(), responsibilities: z.array(NonEmpty) })),

    calendar: z.array(z.object({ taskId: TaskId, cadence: Cadence, when: NonEmpty.optional() })),

    // Every task, routed. This is the scoping document for the client's tier.
    routing: z.array(
      z.object({
        taskId: TaskId,
        sopId: SopId.optional(),
        route: OwnerRole,
        rationale: NonEmpty,
      }),
    ),
  })
  .superRefine((blueprint, ctx) => {
    const routed = new Set<string>();
    blueprint.routing.forEach((r, i) => {
      if (routed.has(r.taskId)) {
        ctx.addIssue({ code: "custom", path: ["routing", i, "taskId"], message: `${r.taskId} is routed twice` });
      }
      routed.add(r.taskId);
      const prefix = r.sopId?.match(SOP_ID)?.[1];
      if (prefix !== undefined && prefix !== blueprint.clientPrefix) {
        ctx.addIssue({
          code: "custom",
          path: ["routing", i, "sopId"],
          message: `SOP ${r.sopId} does not use client prefix ${blueprint.clientPrefix}`,
        });
      }
    });
    blueprint.calendar.forEach((entry, i) => {
      if (!routed.has(entry.taskId)) {
        ctx.addIssue({ code: "custom", path: ["calendar", i, "taskId"], message: `${entry.taskId} is not in routing` });
      }
    });
  });
export type Blueprint = z.infer<typeof Blueprint>;
