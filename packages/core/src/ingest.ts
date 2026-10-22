import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { simpleParser, type AddressObject } from "mailparser";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import * as XLSX from "xlsx";
import type { EvidenceBundle, EvidenceItem, SourceDocument } from "./schemas/index.ts";

// Stage 2: every source becomes text with a stable evidence ID. Output depends
// only on file contents, so re-ingesting unchanged input gives the same bundle.

export class IngestError extends Error {}

const DOCUMENT_KINDS: Record<string, SourceDocument["kind"]> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".eml": "eml",
  ".txt": "txt",
};

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const visible = (dir: string) => readdirSync(dir).filter((f) => !f.startsWith(".")).sort();

export async function ingest(clientDir: string, clientId: string): Promise<EvidenceBundle> {
  const transcriptFiles = visible(join(clientDir, "transcript")).filter((f) => /\.(vtt|txt)$/.test(f));
  if (transcriptFiles.length !== 1) {
    throw new IngestError(`Expected one .vtt or .txt file in transcript/, found ${transcriptFiles.length}`);
  }
  const transcriptPath = `transcript/${transcriptFiles[0]}`;
  const transcriptBytes = readFileSync(join(clientDir, transcriptPath));
  const format = transcriptPath.endsWith(".vtt") ? "vtt" : "txt";
  const transcriptText = transcriptBytes.toString("utf8");
  const items: EvidenceItem[] = format === "vtt" ? parseVtt(transcriptText) : parseTranscriptTxt(transcriptText);

  const documents: SourceDocument[] = [];
  for (const [i, file] of visible(join(clientDir, "documents")).entries()) {
    const kind = DOCUMENT_KINDS[extname(file).toLowerCase()];
    if (!kind) throw new IngestError(`Unsupported document type: documents/${file}`);
    const id = `D-${String(i + 1).padStart(2, "0")}`;
    const path = `documents/${file}`;
    const bytes = readFileSync(join(clientDir, path));
    documents.push({ id, path, kind, sha256: sha256(bytes) });
    items.push(...(await documentItems(id, kind, bytes)));
  }

  return {
    clientId,
    transcript: { path: transcriptPath, format, sha256: sha256(transcriptBytes) },
    documents,
    redaction: "not_started",
    items,
  };
}

// ---- transcripts -------------------------------------------------------------

const segmentId = (n: number) => `T-${String(n).padStart(4, "0")}`;

export function parseVtt(vtt: string): EvidenceItem[] {
  if (!vtt.startsWith("WEBVTT")) throw new IngestError("Transcript .vtt must start with WEBVTT");
  const segments: EvidenceItem[] = [];
  for (const block of vtt.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((l) => l.includes("-->"));
    if (timing === -1) continue;
    const [start, end] = (lines[timing] as string).split("-->").map((t) => normaliseTimestamp(t.trim().split(/\s/)[0] ?? ""));
    const body = lines.slice(timing + 1).join(" ").trim();
    const voice = /^<v(?:\.[^ >]*)? ([^>]+)>(.*?)(?:<\/v>)?$/.exec(body);
    if (!voice) throw new IngestError(`Cue at ${lines[timing]} has no speaker label (<v Name>)`);
    segments.push({
      kind: "transcript_segment",
      id: segmentId(segments.length + 1),
      speaker: (voice[1] as string).trim(),
      start: start as string,
      end: end as string,
      text: stripTags(voice[2] as string),
    });
  }
  if (!segments.length) throw new IngestError("Transcript has no cues");
  return segments;
}

// Plain-text transcripts: one line per turn, "[00:01:23] Speaker: words".
export function parseTranscriptTxt(txt: string): EvidenceItem[] {
  const turns = txt
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, i) => {
      const m = /^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\]?\s+([^:]{1,60}):\s*(.+)$/.exec(line.trim());
      if (!m) throw new IngestError(`Transcript line ${i + 1} needs a timestamp and speaker: "[00:01:23] Speaker: words"`);
      return { start: normaliseTimestamp(m[1] as string), speaker: (m[2] as string).trim(), text: (m[3] as string).trim() };
    });
  if (!turns.length) throw new IngestError("Transcript is empty");
  return turns.map((turn, i) => ({
    kind: "transcript_segment" as const,
    id: segmentId(i + 1),
    speaker: turn.speaker,
    start: turn.start,
    end: turns[i + 1]?.start ?? turn.start,
    text: turn.text,
  }));
}

function normaliseTimestamp(t: string): string {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(t);
  if (!m) throw new IngestError(`Bad timestamp "${t}"`);
  const [, h = "0", min, s, ms = "0"] = m;
  return `${h.padStart(2, "0")}:${(min as string).padStart(2, "0")}:${s}.${ms.padEnd(3, "0")}`;
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").trim();

// ---- documents ---------------------------------------------------------------

async function documentItems(id: string, kind: SourceDocument["kind"], bytes: Buffer): Promise<EvidenceItem[]> {
  switch (kind) {
    case "pdf": {
      const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: false });
      return text.flatMap((page, i) =>
        page.trim() ? [{ kind: "document_page" as const, id: `${id} p${i + 1}`, documentId: id, page: i + 1, text: page.trim() }] : [],
      );
    }
    case "docx":
    case "txt": {
      const text = kind === "docx" ? (await mammoth.extractRawText({ buffer: bytes })).value : bytes.toString("utf8");
      return text.trim() ? [{ kind: "document_page", id: `${id} p1`, documentId: id, page: 1, text: text.trim() }] : [];
    }
    case "eml":
      return [await emailItem(id, bytes)];
    case "xlsx":
      return sheetItems(id, bytes);
  }
}

async function emailItem(id: string, bytes: Buffer): Promise<EvidenceItem> {
  const mail = await simpleParser(bytes);
  const addresses = (field: AddressObject | AddressObject[] | undefined) =>
    (Array.isArray(field) ? field : field ? [field] : [])
      .flatMap((a) => a.value)
      .map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? "")));
  const dateLine = mail.headerLines.find((h) => h.key === "date")?.line ?? "";
  return {
    kind: "email",
    id,
    documentId: id,
    from: addresses(mail.from)[0] ?? "(unknown sender)",
    to: addresses(mail.to),
    date: rfc2822ToIso(dateLine.replace(/^date:\s*/i, "")),
    subject: mail.subject ?? "",
    text: (mail.text ?? "").replace(/\r\n/g, "\n").trim(),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Keeps the sender's own clock and offset, which a JS Date would discard.
export function rfc2822ToIso(value: string): string {
  const m = /(\d{1,2}) (\w{3}) (\d{4}) (\d{2}):(\d{2})(?::(\d{2}))? ([+-])(\d{2})(\d{2})/.exec(value);
  const month = m ? MONTHS.indexOf(m[2] as string) + 1 : 0;
  if (!m || month === 0) throw new IngestError(`Unreadable email Date header: "${value}"`);
  const [, day, , year, hh, mm, ss = "00", sign, oh, om] = m;
  return `${year}-${String(month).padStart(2, "0")}-${(day as string).padStart(2, "0")}T${hh}:${mm}:${ss}${sign}${oh}:${om}`;
}

// Keeps sheet names, headers, values and formulas: the formulas are process logic.
function sheetItems(id: string, bytes: Buffer): EvidenceItem[] {
  const workbook = XLSX.read(bytes, { cellFormula: true, cellNF: true, cellText: true });
  return workbook.SheetNames.map((sheetName, i) => {
    const sheet = workbook.Sheets[sheetName] as XLSX.WorkSheet;
    const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
    const cells = [];
    const headers: string[] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const ref = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[ref] as XLSX.CellObject | undefined;
        if (!cell || (cell.v === undefined && !cell.f)) continue;
        const value = cellValue(cell);
        if (r === range.s.r && value !== null) headers.push(String(value));
        cells.push(cell.f ? { ref, value, formula: `=${cell.f}` } : { ref, value });
      }
    }
    return { kind: "spreadsheet_sheet" as const, id: `${id} s${i + 1}`, documentId: id, sheet: i + 1, sheetName, headers, cells };
  });
}

function cellValue(cell: XLSX.CellObject): string | number | boolean | null {
  if (cell.v === undefined || cell.v === null) return null;
  // Dates and times are stored as numbers; their formatted text is what a person reads.
  if (cell.t === "n" && typeof cell.z === "string" && /[dmyhs]/i.test(cell.z.replace(/"[^"]*"/g, "")) && cell.w) return cell.w;
  if (cell.v instanceof Date) return cell.v.toISOString();
  return cell.v;
}
