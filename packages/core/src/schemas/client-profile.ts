import { z } from "zod";
import { ClientId, ClientPrefix, NonEmpty } from "./common.ts";

// Input to the Prepare stage, and the cached context for every SOP draft.
export const ClientProfile = z.object({
  clientId: ClientId,
  clientName: NonEmpty,
  clientPrefix: ClientPrefix,
  industry: NonEmpty,
  servicesBought: z.array(NonEmpty).min(1),
  teamSize: z.int().positive(),
  state: z.enum(["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"]),
});
export type ClientProfile = z.infer<typeof ClientProfile>;
