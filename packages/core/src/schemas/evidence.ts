import { z } from "zod";
import {
  ClientId,
  DOCUMENT_ID,
  DOCUMENT_PAGE_ID,
  IsoDateTime,
  NonEmpty,
  SPREADSHEET_SHEET_ID,
  TRANSCRIPT_SEGMENT_ID,
} from "./common.ts";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Timestamp = z.string().regex(/^\d{2}:\d{2}:\d{2}\.\d{3}$/, "Expected HH:MM:SS.mmm");

export const TranscriptSource = z.object({
  path: NonEmpty.describe("Relative to the client folder"),
  format: z.enum(["vtt", "txt"]),
  sha256: Sha256,
});

export const SourceDocument = z.object({
  id: z.string().regex(DOCUMENT_ID),
  path: NonEmpty.describe("Relative to the client folder"),
  kind: z.enum(["pdf", "docx", "xlsx", "eml", "txt"]),
  sha256: Sha256,
});
export type SourceDocument = z.infer<typeof SourceDocument>;

export const TranscriptSegment = z.object({
  kind: z.literal("transcript_segment"),
  id: z.string().regex(TRANSCRIPT_SEGMENT_ID),
  speaker: NonEmpty,
  start: Timestamp,
  end: Timestamp,
  text: NonEmpty,
});

export const DocumentPage = z.object({
  kind: z.literal("document_page"),
  id: z.string().regex(DOCUMENT_PAGE_ID),
  documentId: z.string().regex(DOCUMENT_ID),
  page: z.int().positive(),
  text: NonEmpty,
});

// Formulas are process logic, so a sheet keeps them alongside the values.
export const SpreadsheetCell = z.object({
  ref: z.string().regex(/^[A-Z]{1,3}[1-9]\d*$/),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  formula: z.string().startsWith("=").optional(),
});

export const SpreadsheetSheet = z.object({
  kind: z.literal("spreadsheet_sheet"),
  id: z.string().regex(SPREADSHEET_SHEET_ID),
  documentId: z.string().regex(DOCUMENT_ID),
  sheet: z.int().positive(),
  sheetName: NonEmpty,
  headers: z.array(z.string()),
  cells: z.array(SpreadsheetCell).min(1),
});

export const Email = z.object({
  kind: z.literal("email"),
  id: z.string().regex(DOCUMENT_ID),
  documentId: z.string().regex(DOCUMENT_ID),
  from: NonEmpty,
  to: z.array(NonEmpty).min(1),
  date: IsoDateTime,
  subject: z.string(),
  text: NonEmpty,
});

export const EvidenceItem = z.discriminatedUnion("kind", [TranscriptSegment, DocumentPage, SpreadsheetSheet, Email]);
export type EvidenceItem = z.infer<typeof EvidenceItem>;

// Output of the Ingest stage (and, once confirmed, the Redact stage).
export const EvidenceBundle = z
  .object({
    clientId: ClientId,
    transcript: TranscriptSource,
    documents: z.array(SourceDocument),
    redaction: z.enum(["not_started", "awaiting_confirmation", "confirmed"]),
    items: z.array(EvidenceItem).min(1),
  })
  .superRefine((bundle, ctx) => {
    const documentIds = new Set(bundle.documents.map((d) => d.id));
    if (documentIds.size !== bundle.documents.length) {
      ctx.addIssue({ code: "custom", path: ["documents"], message: "Document IDs must be unique" });
    }
    const seen = new Set<string>();
    bundle.items.forEach((item, i) => {
      if (seen.has(item.id)) {
        ctx.addIssue({ code: "custom", path: ["items", i, "id"], message: `Duplicate evidence ID ${item.id}` });
      }
      seen.add(item.id);
      if (item.kind === "transcript_segment") return;
      if (!documentIds.has(item.documentId)) {
        ctx.addIssue({ code: "custom", path: ["items", i, "documentId"], message: `Unknown document ${item.documentId}` });
      }
      const expected =
        item.kind === "document_page"
          ? `${item.documentId} p${item.page}`
          : item.kind === "spreadsheet_sheet"
            ? `${item.documentId} s${item.sheet}`
            : item.documentId;
      if (item.id !== expected) {
        ctx.addIssue({ code: "custom", path: ["items", i, "id"], message: `Expected ID ${expected}, got ${item.id}` });
      }
    });
  });
export type EvidenceBundle = z.infer<typeof EvidenceBundle>;
