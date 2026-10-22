import { z } from "zod";

// Evidence IDs are the citation format for every claim the pipeline makes.
//   T-0412   transcript segment 412
//   D-03     a whole document (used for emails, which have no pages)
//   D-03 p2  page 2 of document 3
//   D-04 s1  sheet 1 of spreadsheet document 4
export const TRANSCRIPT_SEGMENT_ID = /^T-\d{4,}$/;
export const DOCUMENT_ID = /^D-\d{2,}$/;
export const DOCUMENT_PAGE_ID = /^D-\d{2,} p[1-9]\d*$/;
export const SPREADSHEET_SHEET_ID = /^D-\d{2,} s[1-9]\d*$/;
export const EVIDENCE_ID = /^(T-\d{4,}|D-\d{2,}( [ps][1-9]\d*)?)$/;

export const EvidenceId = z
  .string()
  .regex(EVIDENCE_ID, "Expected an evidence ID such as T-0412, D-03, D-03 p2 or D-04 s1");
export type EvidenceId = z.infer<typeof EvidenceId>;

export const ASSUMED = "ASSUMED";

// A claim either cites at least one piece of evidence or says out loud that it is assumed.
export const Citation = z.union([z.array(EvidenceId).min(1), z.literal(ASSUMED)]);
export type Citation = z.infer<typeof Citation>;

export const ClientId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Expected a lowercase slug such as harbour-plumbing");
export const ClientPrefix = z.string().regex(/^[A-Z]{2,5}$/, "Expected 2–5 capital letters such as APN");

// Who does (or will do) a task. Matches the routing column in the Blueprint.
export const OwnerRole = z.enum(["ai_role", "operator", "client_retained", "automation"]);
export type OwnerRole = z.infer<typeof OwnerRole>;

export const Cadence = z.enum([
  "daily",
  "weekly",
  "fortnightly",
  "monthly",
  "quarterly",
  "annual",
  "per_event",
  "ad_hoc",
  // Never blank: an unknown cadence is stated as unknown and goes to the gap report.
  "unknown",
]);
export type Cadence = z.infer<typeof Cadence>;

export const Frequency = z.object({
  cadence: Cadence,
  detail: z.string().min(1).optional().describe("e.g. 'first business day of the month', 'after every completed job'"),
});
export type Frequency = z.infer<typeof Frequency>;

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const ReviewStatus = z.enum(["draft", "operator_reviewed", "approved"]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const IsoDate = z.iso.date();
export const IsoDateTime = z.iso.datetime({ offset: true });

export const NonEmpty = z.string().trim().min(1);
