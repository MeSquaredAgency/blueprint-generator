import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentPrompt, Blueprint, EvidenceBundle, EvidenceId, readFlags, Sop } from "../src/index.ts";
import { FIXTURE, readJson } from "./helpers.ts";

// Each test starts from a valid sample and breaks one rule.
const sample = () => readJson(`${FIXTURE}sample/sops/HBP-FIN-001.json`) as any;
const messages = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((i) => i.message).join("\n") ?? "";

describe("evidence IDs", () => {
  it("accepts transcript segments, documents, pages and sheets", () => {
    for (const id of ["T-0412", "T-12345", "D-03", "D-03 p2", "D-04 s1", "D-123 p10"]) {
      assert.ok(EvidenceId.safeParse(id).success, id);
    }
  });
  it("rejects anything else", () => {
    for (const id of ["T-41", "t-0412", "D-3", "D-03p2", "D-03 p0", "D-03 page 2", "ASSUMED", ""]) {
      assert.ok(!EvidenceId.safeParse(id).success, id);
    }
  });
});

describe("evidence bundle", () => {
  const bundle = () => readJson(`${FIXTURE}sample/evidence.json`) as any;

  it("rejects duplicate evidence IDs", () => {
    const b = bundle();
    b.items.push(b.items[0]);
    assert.match(messages(EvidenceBundle.safeParse(b)), /Duplicate evidence ID T-0001/);
  });
  it("rejects a page whose ID doesn't match its document and page", () => {
    const b = bundle();
    const page = b.items.find((i: any) => i.kind === "document_page");
    page.page = 2;
    assert.match(messages(EvidenceBundle.safeParse(b)), /Expected ID D-01 p2/);
  });
  it("rejects items pointing at unknown documents", () => {
    const b = bundle();
    b.documents = b.documents.filter((d: any) => d.id !== "D-04");
    assert.match(messages(EvidenceBundle.safeParse(b)), /Unknown document D-04/);
  });
});

describe("SOP standard", () => {
  it("accepts the sample", () => assert.ok(Sop.safeParse(sample()).success));

  it("requires every step to cite evidence or say ASSUMED", () => {
    for (const evidence of [undefined, [], "assumed", ["not an id"]]) {
      const sop = sample();
      sop.steps[0].evidence = evidence;
      assert.ok(!Sop.safeParse(sop).success, JSON.stringify(evidence));
    }
    const sop = sample();
    sop.steps[0].evidence = "ASSUMED";
    assert.ok(Sop.safeParse(sop).success);
  });

  it("requires the ID to be client prefix, function code and number", () => {
    for (const id of ["HBP-FIN-1", "hbp-FIN-001", "FIN-001", "HBP_FIN_001"]) {
      assert.ok(!Sop.safeParse({ ...sample(), id }).success, id);
    }
  });

  it("never leaves trigger blank; unknown frequency must be said out loud", () => {
    assert.ok(!Sop.safeParse({ ...sample(), trigger: "  " }).success);
    assert.ok(!Sop.safeParse({ ...sample(), frequency: {} }).success);
    assert.ok(Sop.safeParse({ ...sample(), frequency: { cadence: "unknown" } }).success);
  });

  it("has one owner, who is not also a contributor", () => {
    assert.match(messages(Sop.safeParse({ ...sample(), contributors: ["operator"] })), /not also a contributor/);
  });

  it("requires every output to name where it goes", () => {
    assert.ok(!Sop.safeParse({ ...sample(), outputs: [{ item: "Invoice" }] }).success);
  });

  it("numbers steps 1..n", () => {
    const sop = sample();
    sop.steps[2].n = 7;
    assert.match(messages(Sop.safeParse(sop)), /expected 3/);
  });

  it("rejects quality checks that aren't observable", () => {
    for (const check of ["Check carefully before sending", "Double-check the totals", "Invoice looks right"]) {
      assert.match(messages(Sop.safeParse({ ...sample(), qualityChecks: [check] })), /observable/, check);
    }
  });

  it("always escalates money, legal and complaints", () => {
    for (const topic of ["money", "legal", "complaints"]) {
      const sop = sample();
      sop.escalation = sop.escalation.filter((e: any) => e.topic !== topic);
      assert.match(messages(Sop.safeParse(sop)), new RegExp(`must cover ${topic}`));
    }
  });

  it("requires templates to come from real (cited) examples", () => {
    const sop = sample();
    sop.templates[0].evidence = [];
    assert.ok(!Sop.safeParse(sop).success);
  });

  it("scores on a 1–5 scale", () => {
    const sop = sample();
    sop.scoring.repeatability = 6;
    assert.ok(!Sop.safeParse(sop).success);
  });

  it("only allows the three review statuses, with a review date after the version date", () => {
    assert.ok(!Sop.safeParse({ ...sample(), status: "published" }).success);
    assert.match(messages(Sop.safeParse({ ...sample(), reviewBy: "2026-01-01" })), /Review date/);
  });
});

describe("blueprint", () => {
  const blueprint = () => readJson(`${FIXTURE}sample/blueprint.json`) as any;

  it("rejects SOPs that don't use the client prefix", () => {
    const b = blueprint();
    b.routing[0].sopId = "APN-FIN-001";
    assert.match(messages(Blueprint.safeParse(b)), /does not use client prefix HBP/);
  });
  it("rejects a task routed twice", () => {
    const b = blueprint();
    b.routing.push(b.routing[0]);
    assert.match(messages(Blueprint.safeParse(b)), /routed twice/);
  });
  it("rejects calendar entries for tasks that aren't routed", () => {
    const b = blueprint();
    b.calendar.push({ taskId: "TASK-999", cadence: "weekly" });
    assert.match(messages(Blueprint.safeParse(b)), /TASK-999 is not in routing/);
  });
});

describe("agent prompt", () => {
  const prompt = () => readJson(`${FIXTURE}sample/agent-prompt.json`) as any;

  it("needs 3–5 cited voice examples", () => {
    const tooFew = prompt();
    tooFew.voice.examples = tooFew.voice.examples.slice(0, 2);
    assert.ok(!AgentPrompt.safeParse(tooFew).success);
    const uncited = prompt();
    uncited.voice.examples[0].evidence = [];
    assert.ok(!AgentPrompt.safeParse(uncited).success);
  });
});

describe("flags", () => {
  it("default to off", () => {
    assert.deepEqual(readFlags({}), {
      REAL_CLIENT_DATA: false,
      GOOGLE_DOCS_EXPORT: false,
      CLIENT_SIGNOFF: false,
      AUTO_TRANSCRIBE: false,
    });
  });
  it("turn on only for an explicit 1 or true", () => {
    assert.equal(readFlags({ REAL_CLIENT_DATA: "true" }).REAL_CLIENT_DATA, true);
    assert.equal(readFlags({ REAL_CLIENT_DATA: " 1 " }).REAL_CLIENT_DATA, true);
    for (const value of ["yes", "on", "false", "0", ""]) {
      assert.equal(readFlags({ REAL_CLIENT_DATA: value }).REAL_CLIENT_DATA, false, value);
    }
  });
});
