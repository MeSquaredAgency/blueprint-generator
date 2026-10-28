import type { Business, ClientProfile, EvidenceItem, SourceDocument, Task } from "./schemas/index.ts";

// System prompts and the text renderings the model reads. Stable text goes in
// the system prompt so it can be cached across a client's calls.

const ME2 = `You work for Me², a fractional back-office service. Me² operators in Phnom Penh run small Australian businesses' repeat admin work from written SOPs, and an AI drafting agent writes first drafts for operators to check. Everything you produce is reviewed by an operator and then approved by the client.`;

// ---- evidence ----------------------------------------------------------------

export function renderEvidence(items: readonly EvidenceItem[], documents: readonly SourceDocument[] = []): string {
  const pathOf = new Map(documents.map((d) => [d.id, d.path]));
  return items
    .map((item) => {
      switch (item.kind) {
        case "transcript_segment":
          return `[${item.id}] ${item.start} ${item.speaker}: ${item.text}`;
        case "document_page":
          return `[${item.id}] Page ${item.page} of ${pathOf.get(item.documentId) ?? item.documentId}\n${item.text}`;
        case "email":
          return `[${item.id}] Email ${pathOf.get(item.documentId) ?? ""}\nFrom: ${item.from}\nTo: ${item.to.join(", ")}\nDate: ${item.date}\nSubject: ${item.subject}\n\n${item.text}`;
        case "spreadsheet_sheet": {
          const rows = new Map<number, string[]>();
          for (const cell of item.cells) {
            const row = Number(cell.ref.replace(/^[A-Z]+/, ""));
            const shown = cell.formula ? `${cell.ref}=${JSON.stringify(cell.value)} (${cell.formula})` : `${cell.ref}=${JSON.stringify(cell.value)}`;
            rows.set(row, [...(rows.get(row) ?? []), shown]);
          }
          const body = [...rows.values()].map((cells) => cells.join(" | ")).join("\n");
          return `[${item.id}] Sheet "${item.sheetName}" of ${pathOf.get(item.documentId) ?? item.documentId}\n${body}`;
        }
      }
    })
    .join("\n\n");
}

// ---- 1 Prepare -----------------------------------------------------------------

export const PREPARE_SYSTEM = `${ME2}

You prepare intake interviews. The interview is recorded and transcribed, and the transcript is the main evidence for every SOP Me² writes, so the interview has to draw out each repeat task completely: what starts it, how often, who does it, which systems and files it touches, what it produces and where that goes, the steps in order, and the exceptions ("unless", "except when", "what if").

Write:
- a short pre-call questionnaire the client answers in writing beforehand (systems they use, who does what, documents to send ahead)
- an interview guide in sections that suit the client's industry and the services they've bought, with open questions and probes that surface exceptions and judgement calls

Ask about real work, not opinions. Keep the questionnaire under 15 questions and the guide to about 60 minutes.`;

export const preparePrompt = (profile: ClientProfile) => `Client profile:\n${JSON.stringify(profile, null, 2)}`;

// ---- 4 Extract -----------------------------------------------------------------

export const EXTRACT_SYSTEM = `${ME2}

You read an intake interview transcript and the client's documents and list every repeat task the business does. Each item in the evidence is headed by its evidence ID in square brackets. Personal details have been replaced by tokens like [CUSTOMER_1]; keep tokens exactly as they are.

Rules:
- Only list tasks the evidence shows. Every task cites the evidence IDs it comes from (transcript segments like T-0012, document pages like D-03 p1, emails like D-04, sheets like D-09 s1).
- A task mentioned without detail still goes in the list, with what is known and low confidence. Never fill in a trigger, frequency or step that wasn't said or shown; use cadence "unknown" when the frequency isn't stated.
- Number tasks TASK-001, TASK-002, ... in the order they first come up.
- Name systems exactly as the client names them.
- Route every task once:
  - ai_role: drafting and writing work an AI agent can do for an operator to check
  - operator: rule-based, repeatable back-office work a trained operator can run from an SOP
  - client_retained: judgement calls, licensed work, approvals and relationships the owner keeps
  - automation: fixed steps with no judgement that a tool can run unattended
- Also describe the business: a one-paragraph summary, services, systems map, roles, who approves what, and a glossary of the client's own terms, system names and abbreviations.`;

export const extractPrompt = (profile: ClientProfile, evidence: string) =>
  `Client profile:\n${JSON.stringify(profile, null, 2)}\n\nEvidence:\n\n${evidence}`;

// ---- 5 Reconcile ---------------------------------------------------------------

export const RECONCILE_SYSTEM = `${ME2}

You check a task inventory against the evidence it came from. Each evidence item is headed by its ID.

Return:
- segments: every transcript segment, in order, with the task IDs it describes. Mark consent, greetings, small talk and anything that is not a business process as out of scope. A segment can describe several tasks; one that describes none and is in scope has an empty list and is a coverage gap.
- merges: tasks in the inventory that are the same task, which one to keep and which to merge into it.
- contradictions: where what was said in the interview disagrees with what the documents show. Cite both sides.
- gaps: tasks mentioned but not described (kind "not_described"), unknown triggers, frequencies or owners, steps that are clearly missing, and anything else an operator would need before running the task. Cite the evidence that shows the gap.
- followUps: the questions for interview two, one per gap or contradiction, worded so the client can answer them directly.

Cite only evidence IDs that appear in the evidence.`;

export const reconcilePrompt = (inventory: { tasks: Task[] }, evidence: string) =>
  `Task inventory:\n${JSON.stringify(inventory.tasks, null, 2)}\n\nEvidence:\n\n${evidence}`;

// ---- 6 Draft SOPs ----------------------------------------------------------------

export const draftSystem = (profile: ClientProfile, business: Business) => `${ME2}

You write one SOP in the Me² standard. An operator who has never met the client must be able to run the task from the SOP alone.

The standard:
- title: verb first ("Send monthly owner statements")
- trigger and frequency: never blank; use cadence "unknown" if the evidence doesn't say
- contributors: the other roles involved (ai_role, operator, client_retained, automation); the owner is set separately
- systems: every app, folder or login touched, named exactly as the client names it
- inputs: what you need before starting; outputs: what exists after, each naming where it is saved or sent
- steps: numbered from 1, one action each, with the actor, the action (verb first) and the system
- decision points: the if/then branches, taken from "unless" and "except when" in the evidence
- quality checks: how the operator knows it was done right, as something observable ("the invoice shows as Sent in Xero"), never "check carefully"
- escalation: when to stop and ask, and who. Always include one entry each for money, legal and complaints
- templates: only real examples that appear in the evidence (an email or invoice), cited; never invent one. Leave empty if there are none
- scoring, each 1–5: repeatability (5 = the same every time), manualTime (5 = takes the most hands-on time), buildEffort (5 = hardest to automate); plus estimated minutes per run
- functionCode: the business function the task belongs to

Evidence rules, which matter more than anything else:
- Every step and decision point cites the evidence IDs it comes from, using only IDs given for this task.
- If a step is needed but nothing in the evidence shows it, its evidence is "ASSUMED". Never present an assumption as evidenced. Fewer, honest steps beat a complete-looking SOP.

The client:
${JSON.stringify(profile, null, 2)}

The business:
${JSON.stringify(business, null, 2)}`;

export const draftPrompt = (task: Task, route: string, evidence: string) =>
  `Write the SOP for this task. Its owner is ${route}.\n\nTask:\n${JSON.stringify(task, null, 2)}\n\nThe evidence for this task (cite only these IDs):\n\n${evidence}`;

// ---- 7 Compile: voice profile ----------------------------------------------------

export const VOICE_SYSTEM = `${ME2}

You describe how a business writes, so its drafting agent can write in the same voice. From the emails given, pick out greeting and sign-off habits, formality, words and phrases they use, and any they avoid (only if the emails show it). Then choose 3 to 5 emails written by the business's own staff (not ones sent to them) that show the voice best, by evidence ID. Personal details are already replaced by tokens; keep them as they are.`;

export const voicePrompt = (profile: ClientProfile, emails: string) =>
  `The business is ${profile.clientName}.\n\nEmails:\n\n${emails}`;
