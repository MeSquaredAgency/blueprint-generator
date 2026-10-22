import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import {
  AgentPrompt,
  Blueprint,
  ClientProfile,
  EvidenceBundle,
  Sop,
  TaskInventory,
} from "../src/index.ts";
import { citedEvidenceIds, FIXTURE, readJson } from "./helpers.ts";

const sopFiles = readdirSync(`${FIXTURE}sample/sops`).filter((f) => f.endsWith(".json"));

const profile = ClientProfile.parse(readJson(`${FIXTURE}client.json`));
const evidence = EvidenceBundle.parse(readJson(`${FIXTURE}sample/evidence.json`));
const inventory = TaskInventory.parse(readJson(`${FIXTURE}sample/tasks.json`));
const sops = sopFiles.map((f) => Sop.parse(readJson(`${FIXTURE}sample/sops/${f}`)));
const blueprint = Blueprint.parse(readJson(`${FIXTURE}sample/blueprint.json`));
const agentPrompt = AgentPrompt.parse(readJson(`${FIXTURE}sample/agent-prompt.json`));

describe("fixture validates against every schema", () => {
  // The parses above throw on failure; these assertions name what was checked.
  it("client profile", () => assert.equal(profile.clientId, "harbour-plumbing"));
  it("evidence bundle", () => assert.ok(evidence.items.length > 0));
  it("task inventory", () => assert.ok(inventory.tasks.length > 0));
  it("SOPs", () => assert.ok(sops.length > 0));
  it("blueprint", () => assert.equal(blueprint.clientPrefix, profile.clientPrefix));
  it("agent prompt", () => assert.equal(agentPrompt.blueprintVersion, blueprint.version));

  it("every sample file names the fixture client", () => {
    for (const clientId of [evidence.clientId, inventory.clientId, blueprint.clientId, agentPrompt.clientId]) {
      assert.equal(clientId, profile.clientId);
    }
  });
});

describe("fixture raw files", () => {
  it("has a .vtt transcript with speaker labels and timestamps on every cue", () => {
    const vtt = readFileSync(`${FIXTURE}${evidence.transcript.path}`, "utf8");
    assert.ok(vtt.startsWith("WEBVTT"));
    const cues = vtt.split(/\n\n+/).filter((block) => block.includes("-->"));
    assert.ok(cues.length > 0);
    for (const cue of cues) assert.match(cue, /\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\n<v [^>]+>\S/);
    const segments = evidence.items.filter((i) => i.kind === "transcript_segment");
    assert.equal(segments.length, cues.length, "one transcript segment per cue");
  });

  it("has three invoices, five emails and one spreadsheet with formulas", () => {
    const kinds = evidence.documents.map((d) => d.kind);
    assert.equal(kinds.filter((k) => k === "pdf").length, 3);
    assert.equal(kinds.filter((k) => k === "eml").length, 5);
    assert.equal(kinds.filter((k) => k === "xlsx").length, 1);
    const sheets = evidence.items.filter((i) => i.kind === "spreadsheet_sheet");
    assert.ok(sheets.some((s) => s.cells.some((c) => c.formula !== undefined)));
  });

  it("matches the files on disk, so the sample bundle can't silently go stale", () => {
    const onDisk = readdirSync(`${FIXTURE}documents`).sort().map((f) => `documents/${f}`);
    assert.deepEqual(evidence.documents.map((d) => d.path), onDisk);
    for (const source of [evidence.transcript, ...evidence.documents]) {
      const hash = createHash("sha256").update(readFileSync(`${FIXTURE}${source.path}`)).digest("hex");
      assert.equal(hash, source.sha256, `${source.path} changed; regenerate sample/evidence.json`);
    }
  });
});

describe("fixture cross-references", () => {
  const evidenceIds = new Set(evidence.items.map((i) => i.id));
  const taskIds = new Set(inventory.tasks.map((t) => t.id));
  const sopIds = new Set(sops.map((s) => s.id));

  it("every cited evidence ID exists in the evidence bundle", () => {
    const cited = citedEvidenceIds([inventory, sops, agentPrompt]);
    assert.ok(cited.length > 0);
    assert.deepEqual(cited.filter((id) => !evidenceIds.has(id)), []);
  });

  it("each SOP file is named after its ID and points at a known task", () => {
    sops.forEach((sop, i) => {
      assert.equal(sopFiles[i], `${sop.id}.json`);
      assert.ok(taskIds.has(sop.taskId), `${sop.id} → ${sop.taskId}`);
      assert.ok(sop.id.startsWith(`${profile.clientPrefix}-`));
    });
  });

  it("the blueprint routes every task exactly once, to SOPs that exist", () => {
    assert.deepEqual(new Set(blueprint.routing.map((r) => r.taskId)), taskIds);
    for (const r of blueprint.routing) if (r.sopId) assert.ok(sopIds.has(r.sopId), r.sopId);
  });

  it("the agent prompt drafts only AI-owned SOPs", () => {
    for (const draft of agentPrompt.drafts) {
      assert.equal(sops.find((s) => s.id === draft.sopId)?.owner, "ai_role", draft.sopId);
    }
  });
});
