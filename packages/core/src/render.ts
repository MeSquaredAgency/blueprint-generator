import type { RedactionProposal } from "./redact.ts";
import type { AgentPrompt, ClientData, InterviewKit, OwnerRole, Sop } from "./schemas/index.ts";

// Markdown outputs, rendered only from the client data file so they can't
// disagree with each other.

export const ROLE_LABEL: Record<OwnerRole, string> = {
  ai_role: "AI role",
  operator: "Operator",
  client_retained: "Client-retained",
  automation: "Automation",
};

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
const cites = (c: readonly string[] | "ASSUMED") => (c === "ASSUMED" ? "**ASSUMED**" : `[${c.join(", ")}]`);
const list = (items: readonly string[], empty = "_None._") => (items.length ? items.map((i) => `- ${i}`).join("\n") : empty);
const doc = (...sections: (string | false | undefined)[]) => sections.filter(Boolean).join("\n\n") + "\n";

export function renderInterviewKit(clientName: string, kit: InterviewKit): string {
  return doc(
    `# Interview kit: ${clientName}`,
    `## Pre-call questionnaire`,
    kit.questionnaire.map((q, i) => `${i + 1}. ${q.question}\n   _Why: ${q.why}_`).join("\n"),
    `## Interview guide`,
    ...kit.guide.map(
      (s) => `### ${s.section}\n\n_Goal: ${s.goal}_\n\n${s.questions.map((q) => `- ${q}`).join("\n")}${s.probes.length ? `\n\nProbes:\n\n${s.probes.map((p) => `- ${p}`).join("\n")}` : ""}`,
    ),
  );
}

export function renderRedaction(clientName: string, proposal: RedactionProposal, confirmCommand: string): string {
  return doc(
    `# Redaction to confirm: ${clientName}`,
    `Check every replacement below. Nothing after this stage sees the original text. When it is right, run:\n\n\`\`\`\n${confirmCommand}\n\`\`\``,
    `## Replacements`,
    table(
      ["Token", "Found by", "Original", "Where"],
      proposal.replacements.map((r) => [r.token, r.source === "rule" ? `rule (${r.kind})` : "model", r.text, r.evidenceIds.join(", ")]),
    ),
    proposal.unmatched.length > 0 && `## Flagged but not found (left unredacted)`,
    proposal.unmatched.length > 0 &&
      table(["Category", "Text", "Where the model said"], proposal.unmatched.map((u) => [u.category, u.text, u.evidenceId])),
  );
}

export function renderBlueprint(data: ClientData): string {
  const b = data.blueprint;
  const nameOf = new Map(data.tasks.map((t) => [t.id, t.name]));
  const byRoute = (Object.keys(ROLE_LABEL) as OwnerRole[]).map((r) => `${ROLE_LABEL[r]}: ${b.routing.filter((x) => x.route === r).length}`);
  return doc(
    `# Operational Blueprint: ${b.clientName}`,
    `Version ${b.version} · ${b.versionDate} · **${b.status}**`,
    `## Business overview`,
    b.overview.summary,
    `**Industry:** ${b.overview.industry} · **Team size:** ${b.overview.teamSize}\n\n**Services:** ${b.overview.services.join("; ")}`,
    `### Who approves what`,
    table(["What", "Approver"], b.overview.approvals.map((a) => [a.what, a.approver])),
    `## Systems map`,
    table(["System", "Purpose", "Used by"], b.systems.map((s) => [s.name, s.purpose, s.usedBy.join(", ")])),
    `## Roles`,
    table(["Role", "Held by", "Responsibilities"], b.roles.map((r) => [r.name, r.holder ?? "", r.responsibilities.join("; ")])),
    `## Task calendar`,
    table(["Cadence", "When", "Task"], b.calendar.map((c) => [c.cadence, c.when ?? "", `${c.taskId} ${nameOf.get(c.taskId) ?? ""}`])),
    `## Routing`,
    byRoute.join(" · "),
    table(
      ["Task", "Route", "SOP", "Why"],
      b.routing.map((r) => [`${r.taskId} ${nameOf.get(r.taskId) ?? ""}`, ROLE_LABEL[r.route], r.sopId ?? "—", r.rationale]),
    ),
  );
}

export function renderSop(sop: Sop): string {
  const assumed = sop.steps.filter((s) => s.evidence === "ASSUMED");
  return doc(
    `# ${sop.id} ${sop.title}`,
    `Version ${sop.version} · ${sop.versionDate} · **${sop.status}** · review by ${sop.reviewBy}`,
    assumed.length > 0 &&
      `> **${assumed.length} assumed step(s).** Nothing in the evidence shows ${assumed.length === 1 ? "this step" : "these steps"}; confirm before running:\n${assumed.map((s) => `> - Step ${s.n}: ${s.action}`).join("\n")}`,
    table(
      ["", ""],
      [
        ["Trigger", sop.trigger],
        ["Frequency", `${sop.frequency.cadence}${sop.frequency.detail ? ` (${sop.frequency.detail})` : ""}`],
        ["Owner", ROLE_LABEL[sop.owner]],
        ["Contributors", sop.contributors.map((c) => ROLE_LABEL[c]).join(", ") || "—"],
        ["Systems", sop.systems.map((s) => s.name).join(", ") || "—"],
        ["Time per run", `${sop.scoring.minutesPerRun} min`],
        ["Scores", `repeatability ${sop.scoring.repeatability}/5 · manual time ${sop.scoring.manualTime}/5 · build effort ${sop.scoring.buildEffort}/5`],
      ],
    ),
    `## Inputs`,
    list(sop.inputs.map((i) => (i.source ? `${i.item} (from ${i.source})` : i.item))),
    `## Outputs`,
    list(sop.outputs.map((o) => `${o.item} → ${o.destination}`)),
    `## Steps`,
    sop.steps.map((s) => `${s.n}. ${ROLE_LABEL[s.actor]} — ${s.action}${s.system ? ` (${s.system})` : ""} — ${cites(s.evidence)}`).join("\n"),
    `## Decision points`,
    list(sop.decisionPoints.map((d) => `**If** ${d.condition}: ${d.action} — ${cites(d.evidence)}`)),
    `## Quality checks`,
    list(sop.qualityChecks),
    `## Escalation`,
    table(["Topic", "When", "Contact"], sop.escalation.map((e) => [e.topic, e.when, e.contact])),
    `## Templates`,
    list(sop.templates.map((t) => `${t.name} (${t.kind}): ${t.link} — ${cites(t.evidence)}`)),
  );
}

export function renderGaps(data: ClientData): string {
  const r = data.reconciliation;
  const nameOf = new Map(data.tasks.map((t) => [t.id, t.name]));
  const about = (id?: string) => (id ? `${id} ${nameOf.get(id) ?? ""}: ` : "");
  return doc(
    `# Gap report and follow-up script: ${data.profile.clientName}`,
    `Every process found so far is written down. This is what hasn't been found yet.`,
    `## Gaps`,
    list(r.gaps.map((g) => `**${g.kind.replace(/_/g, " ")}** — ${about(g.taskId)}${g.detail} ${g.evidence.length ? `[${g.evidence.join(", ")}]` : ""}`.trim())),
    `## Contradictions`,
    list(r.contradictions.map((c) => `**${c.topic}** — ${c.detail} Said: [${c.said.join(", ")}]. Shown: [${c.shown.join(", ")}].`)),
    `## Tasks without an SOP yet`,
    list(data.skippedTasks.map((s) => `${about(s.taskId)}${s.reason}`)),
    `## Follow-up script for interview two`,
    r.followUps.length ? r.followUps.map((f, i) => `${i + 1}. ${f.question}\n   _${about(f.taskId)}${f.why}_`).join("\n") : "_No follow-ups._",
  );
}

export function renderCoverage(data: ClientData): string {
  const c = data.coverage;
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
  return doc(
    `# Coverage report: ${data.profile.clientName}`,
    `For whoever signs the blueprint off.`,
    `## Transcript`,
    table(
      ["", "Segments", "Share"],
      [
        ["Mapped to a task", String(c.mappedToTask), pct(c.mappedToTask, c.transcriptSegments)],
        ["Out of scope", String(c.outOfScope), pct(c.outOfScope, c.transcriptSegments)],
        ["Unmapped", String(c.unmapped.length), pct(c.unmapped.length, c.transcriptSegments)],
        ["Total", String(c.transcriptSegments), ""],
      ],
    ),
    c.unmapped.length > 0 && `Unmapped segments: ${c.unmapped.join(", ")}`,
    `## SOP steps`,
    `${c.steps.evidenced} evidenced, ${c.steps.assumed} assumed, of ${c.steps.total}.`,
    table(["SOP", "Steps", "Assumed"], c.bySop.map((s) => [s.sopId, String(s.steps), String(s.assumed)])),
  );
}

// The fixed agent-prompt template from docs/PLAN.md. Stable sections first so
// they can be prompt-cached across every draft for the client.
export function renderAgentPrompt(p: AgentPrompt): string {
  const v = p.voice;
  return doc(
    `<!-- Agent prompt v${p.version} · Blueprint v${p.blueprintVersion} · ${p.compiledOn} -->`,
    `# Role\nYou draft back-office work for ${p.clientName} for review by a Me² operator.\nYou never send, pay, sign or publish anything yourself.`,
    `# The business\n${p.business}`,
    `# Voice\nGreetings: ${v.greetings.join("; ")}\nSign-offs: ${v.signOffs.map((s) => JSON.stringify(s)).join("; ")}\nFormality: ${v.formality}\nWords they use: ${v.useWords.join(", ") || "—"}\nWords they avoid: ${v.avoidWords.join(", ") || "—"}`,
    v.examples.map((e, i) => `## Example ${i + 1}\n\n${e.text}`).join("\n\n"),
    `# What you draft\n${p.drafts.length ? p.drafts.map((d) => `## ${d.sopId}\nTrigger: ${d.trigger}\nInputs: ${d.inputs.join("; ")}\nOutput: ${d.outputFormat}${d.templateLink ? `\nTemplate: ${d.templateLink}` : ""}\nQuality check: ${d.qualityChecks.join("; ")}`).join("\n\n") : "Nothing is routed to the AI role yet."}`,
    `# Rules that always apply\n${list([...p.complianceRules, "Never quote a price, date or commitment that is not in the inputs.", "Never give legal, tax or financial advice."])}`,
    `# Stop and flag the operator when\n${list(p.stopAndFlag)}`,
    `# Glossary\n${list(p.glossary.map((g) => `${g.term}: ${g.meaning}`))}`,
  );
}
