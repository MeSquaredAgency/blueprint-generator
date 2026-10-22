import { createHash } from "node:crypto";
import type { ModelClient } from "./llm.ts";
import { renderEvidence } from "./prompts.ts";
import {
  RedactionFlags,
  type ClientProfile,
  type EvidenceBundle,
  type EvidenceItem,
  type RedactionCategory,
} from "./schemas/index.ts";

// Stage 3: a deterministic pass strips bank details, card numbers and TFNs; a
// model pass flags remaining third-party personal information. Every match
// becomes a token like [TENANT_1]. Nothing moves on until a person confirms.

export interface RedactionProposal {
  bundleHash: string;
  replacements: {
    token: string;
    source: "rule" | "model";
    kind: string;
    text: string;
    evidenceIds: string[];
  }[];
  // Model flags whose text wasn't found where the model said it was.
  unmatched: { evidenceId: string; text: string; category: RedactionCategory }[];
}

export interface RedactionConfirmation {
  proposalHash: string;
  confirmedBy: string;
  confirmedAt: string;
}

export const hashJson = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// ---- deterministic rules --------------------------------------------------------

interface Rule {
  kind: string;
  // Group 1 (if any) is a label kept in the text; the last group is the secret.
  pattern: RegExp;
  valid?: (digits: string) => boolean;
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

function tfnChecksum(digits: string): boolean {
  const weights = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  return digits.length === 9 && [...digits].reduce((sum, d, i) => sum + Number(d) * (weights[i] as number), 0) % 11 === 0;
}

const RULES: Rule[] = [
  { kind: "BSB", pattern: /\b(BSB:?\s*)(\d{3}[- ]?\d{3})\b/gi },
  { kind: "ACCOUNT", pattern: /\b((?:account|acct|acc|a\/c)(?:\s+(?:number|no\.?|#))?:?\s*)(\d(?:[ -]?\d){5,9})\b/gi },
  { kind: "TFN", pattern: /\b((?:TFN|tax file number):?\s*)(\d{3}[ -]?\d{3}[ -]?\d{2,3})\b/gi },
  // Unlabelled: only nine digits standing alone, so the tail of an ABN
  // ("51 824 753 556") or a longer number is never mistaken for a TFN.
  { kind: "TFN", pattern: /()(?<!\d[ -]?)\b(\d{3} \d{3} \d{3})\b(?![ -]?\d)/g, valid: (d) => d !== "000000000" && tfnChecksum(d) },
  { kind: "CARD", pattern: /()\b(\d(?:[ -]?\d){12,18})\b/g, valid: (d) => d.length >= 13 && d.length <= 19 && luhn(d) },
];

// Every string an evidence item carries, in a fixed order.
function mapStrings(item: EvidenceItem, f: (s: string) => string): EvidenceItem {
  switch (item.kind) {
    case "transcript_segment":
    case "document_page":
      return { ...item, text: f(item.text) };
    case "email":
      return { ...item, from: f(item.from), to: item.to.map(f), subject: f(item.subject), text: f(item.text) };
    case "spreadsheet_sheet":
      return {
        ...item,
        headers: item.headers.map(f),
        cells: item.cells.map((c) => (typeof c.value === "string" ? { ...c, value: f(c.value) } : c)),
      };
  }
}

function stringsOf(item: EvidenceItem): string[] {
  const out: string[] = [];
  mapStrings(item, (s) => (out.push(s), s));
  return out;
}

class Tokens {
  readonly replacements: RedactionProposal["replacements"] = [];
  private readonly counters = new Map<string, number>();
  private readonly byKey = new Map<string, RedactionProposal["replacements"][number]>();

  token(source: "rule" | "model", kind: string, text: string, evidenceId: string): string {
    const key = `${kind}\u0000${text.trim().toLowerCase()}`;
    let entry = this.byKey.get(key);
    if (!entry) {
      const n = (this.counters.get(kind) ?? 0) + 1;
      this.counters.set(kind, n);
      entry = { token: `[${kind}_${n}]`, source, kind, text, evidenceIds: [] };
      this.byKey.set(key, entry);
      this.replacements.push(entry);
    }
    if (!entry.evidenceIds.includes(evidenceId)) entry.evidenceIds.push(evidenceId);
    return entry.token;
  }
}

function applyRules(items: EvidenceItem[], tokens: Tokens): EvidenceItem[] {
  return items.map((item) =>
    mapStrings(item, (text) =>
      RULES.reduce(
        (out, rule) =>
          out.replace(rule.pattern, (match, label: string, secret: string) =>
            rule.valid && !rule.valid(digitsOf(secret)) ? match : `${label}${tokens.token("rule", rule.kind, secret, item.id)}`,
          ),
        text,
      ),
    ),
  );
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function wholeWord(text: string): RegExp {
  const start = /^\w/.test(text) ? "\\b" : "";
  const end = /\w$/.test(text) ? "\\b" : "";
  return new RegExp(`${start}${escapeRegExp(text)}${end}`, "g");
}

// ---- the stage ----------------------------------------------------------------

const SYSTEM = `You find third-party personal information in a small business's records so it can be replaced with tokens before anyone else reads them.

Flag, with the exact text as it appears:
- names of the business's customers, tenants, property owners and outside contacts (property managers, bookkeepers, suppliers' staff)
- their personal phone numbers, personal email addresses and home or rental addresses

Do not flag:
- the business itself, its own staff, or anyone speaking in the interview
- company names, public business phone numbers, business email addresses for a whole team (accounts@..., info@...), or the business's own address
- tokens that are already in square brackets, like [BSB_1]

Use CUSTOMER, TENANT or OWNER for people by their relationship to the business, CONTACT for outside contacts, and ADDRESS, PHONE or EMAIL for contact details. Copy each text exactly, character for character, so it can be found and replaced. Flag a person's full name once per item where it appears, and also any shorter form used for them (a first name alone in a greeting).`;

export async function proposeRedaction(
  bundle: EvidenceBundle,
  profile: ClientProfile,
  model: ModelClient,
): Promise<{ proposal: RedactionProposal; redacted: EvidenceBundle }> {
  const tokens = new Tokens();
  const ruled = applyRules(bundle.items, tokens);
  const ids = new Set(ruled.map((i) => i.id));

  const { flags } = await model.generate({
    stage: "redact",
    label: "redact",
    system: SYSTEM,
    prompt: `The business is ${profile.clientName}. Its records follow, each headed by its evidence ID.\n\n${renderEvidence(ruled)}`,
    schema: RedactionFlags,
    check: (r) => r.flags.filter((f) => !ids.has(f.evidenceId)).map((f) => `Unknown evidence ID ${f.evidenceId}`),
  });

  // Longest text first, so "Mark Ellison" is replaced before "Mark".
  const ordered = [...flags].sort((a, b) => b.text.length - a.text.length || a.text.localeCompare(b.text));
  const unmatched: RedactionProposal["unmatched"] = [];
  let items = ruled;
  for (const flag of ordered) {
    const pattern = wholeWord(flag.text);
    const source = items.find((i) => i.id === flag.evidenceId);
    if (!source || !stringsOf(source).some((s) => new RegExp(pattern).test(s))) {
      unmatched.push(flag);
      continue;
    }
    items = items.map((item) =>
      mapStrings(item, (text) => text.replace(pattern, () => tokens.token("model", flag.category, flag.text, item.id))),
    );
  }

  const proposal: RedactionProposal = {
    bundleHash: hashJson(bundle),
    replacements: tokens.replacements.map((r) => ({ ...r, evidenceIds: [...r.evidenceIds].sort(compareEvidenceIds) })),
    unmatched: unmatched.sort((a, b) => compareEvidenceIds(a.evidenceId, b.evidenceId) || a.text.localeCompare(b.text)),
  };
  return { proposal, redacted: { ...bundle, redaction: "confirmed", items } };
}

// T-0001 < T-0002 < D-01 < D-01 p1 < D-02, i.e. the order of the bundle.
export function compareEvidenceIds(a: string, b: string): number {
  const key = (id: string) => [id.startsWith("T") ? 0 : 1, ...id.match(/\d+/g)!.map(Number)];
  const [ka, kb] = [key(a), key(b)];
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? -1) - (kb[i] ?? -1);
    if (d) return d;
  }
  return 0;
}
