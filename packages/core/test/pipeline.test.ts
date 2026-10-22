import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CacheMissError,
  ClientData,
  confirmRedaction,
  createModelClient,
  DataGateError,
  loadConfig,
  ModelOutputError,
  readFlags,
  runPipeline,
  validateClientData,
  type RunOptions,
  type SendFn,
} from "../src/index.ts";
import { fakeSender, stageAnswer } from "./fake-model.ts";
import { FIXTURE, readJson, REPO_ROOT } from "./helpers.ts";

const config = loadConfig(`${REPO_ROOT}blueprint.config.json`);

function options(outDir: string, send?: SendFn, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    repoRoot: REPO_ROOT,
    clientDir: FIXTURE,
    outDir,
    config,
    flags: readFlags({}),
    model: createModelClient({ config, cacheDir: join(outDir, ".cache"), ...(send ? { send } : {}) }),
    today: "2026-10-22",
    confirmCommand: "confirm",
    ...overrides,
  };
}

// Every file under dir except the response cache, with a hash of its contents.
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.parentPath.includes(".cache")) continue;
    const path = join(entry.parentPath, entry.name);
    out[path.slice(dir.length)] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return out;
}

async function confirmedRun(send: SendFn = fakeSender().send) {
  const outDir = mkdtempSync(join(tmpdir(), "blueprint-"));
  const first = await runPipeline(options(outDir, send));
  assert.equal(first.status, "awaiting_redaction_confirmation");
  confirmRedaction(outDir, "Test Operator", "2026-10-22T00:00:00.000Z");
  return { outDir, result: await runPipeline(options(outDir, send)) };
}

describe("pipeline on the fixture", async () => {
  const { outDir, result } = await confirmedRun();
  const data = ClientData.parse(JSON.parse(readFileSync(join(outDir, "client-data.json"), "utf8")));

  it("stops for redaction review before anything sees the evidence", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "blueprint-"));
    const fake = fakeSender();
    const run = await runPipeline(options(outDir, fake.send));
    assert.equal(run.status, "awaiting_redaction_confirmation");
    assert.deepEqual(fake.calls.map((c) => c.stage), ["prepare", "redact"]);
    assert.ok(existsSync(join(outDir, "redaction.md")));
    assert.ok(!existsSync(join(outDir, "client-data.json")));
  });

  it("completes once the redaction is confirmed, producing every output", () => {
    assert.equal(result.status, "complete");
    for (const file of ["client-data.json", "blueprint.md", "gaps.md", "coverage.md", "agent-prompt.md", "interview-kit.md"]) {
      assert.ok(existsSync(join(outDir, file)), file);
    }
    assert.deepEqual(readdirSync(join(outDir, "sops")).sort(), data.sops.map((s) => `${s.sop.id}.md`).sort());
  });

  it("gives every SOP step an evidence ID or ASSUMED, and passes the validator", () => {
    for (const { sop } of data.sops) {
      for (const step of sop.steps) assert.ok(step.evidence === "ASSUMED" || step.evidence.length > 0, `${sop.id} step ${step.n}`);
    }
    assert.deepEqual(validateClientData(data), []);
  });

  it("replaces bank details and flagged personal details with tokens everywhere", () => {
    const text = readFileSync(join(outDir, "client-data.json"), "utf8");
    for (const secret of ["999-001", "1234 5678", "Mark Ellison", "Hi Mark", "Sam Okafor", "14 Wharf Street"]) {
      assert.ok(!text.includes(secret), secret);
    }
    const proposal = readJson(join(outDir, "redaction.json")) as any;
    assert.deepEqual(
      proposal.replacements.map((r: any) => r.token),
      ["[BSB_1]", "[ACCOUNT_1]", "[ADDRESS_1]", "[ADDRESS_2]", "[CUSTOMER_1]", "[CONTACT_1]", "[CUSTOMER_2]"],
    );
    assert.deepEqual(proposal.unmatched.map((u: any) => u.text), ["Nobody Here"]);
  });

  it("skips SOPs for tasks that were mentioned but not described, and reports them", () => {
    assert.deepEqual(data.skippedTasks.map((s) => s.taskId), ["TASK-005", "TASK-008", "TASK-010"]);
    const gaps = readFileSync(join(outDir, "gaps.md"), "utf8");
    assert.match(gaps, /Are payment terms 7 days or 14\?/);
    assert.match(gaps, /Payment terms/);
  });

  it("numbers SOP IDs per function code and routes them to their task's owner", () => {
    assert.deepEqual(
      data.sops.map((s) => `${s.sop.taskId} ${s.sop.id} ${s.sop.owner}`),
      [
        "TASK-001 HBP-FIN-001 operator",
        "TASK-002 HBP-FIN-002 operator",
        "TASK-003 HBP-OPS-001 client_retained",
        "TASK-004 HBP-OPS-002 operator",
        "TASK-006 HBP-OPS-003 automation",
        "TASK-007 HBP-OPS-004 client_retained",
        "TASK-009 HBP-SAL-001 ai_role",
      ],
    );
  });

  it("counts coverage: mapped, out of scope and unmapped segments, and assumed steps", () => {
    assert.equal(data.coverage.transcriptSegments, 45);
    assert.equal(data.coverage.outOfScope, 6);
    // The fake maps only segments a task cites, so interviewer questions stay unmapped.
    assert.deepEqual(data.coverage.unmapped, ["T-0005", "T-0006", "T-0009", "T-0014", "T-0016", "T-0031", "T-0032", "T-0045"]);
    assert.equal(data.coverage.mappedToTask, 31);
    assert.equal(data.coverage.share, Math.round((37 / 45) * 1000) / 1000);
    const assumed = data.sops.flatMap((s) => s.sop.steps).filter((s) => s.evidence === "ASSUMED").length;
    assert.equal(data.coverage.steps.assumed, assumed);
  });

  it("compiles the agent prompt from AI-owned SOPs and redacted email examples", () => {
    assert.deepEqual(data.agentPrompt?.drafts.map((d) => d.sopId), ["HBP-SAL-001"]);
    assert.match(data.agentPrompt!.voice.examples[0]!.text, /^Hi \[CUSTOMER_2\],/);
    assert.match(readFileSync(join(outDir, "agent-prompt.md"), "utf8"), /You never send, pay, sign or publish anything yourself\./);
  });

  it("produces no diff and makes no model calls on a second run, even on a later day", async () => {
    const before = snapshot(outDir);
    const fake = fakeSender();
    const again = await runPipeline(options(outDir, fake.send, { today: "2026-12-01" }));
    assert.equal(again.status, "complete");
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(snapshot(outDir), before);
  });
});

describe("pipeline failures", () => {
  it("fails a run whose SOP cites evidence it wasn't given, after asking for corrections", async () => {
    const fake = fakeSender((stage, prompt) => {
      if (stage !== "draftSop" || !prompt.includes('"id": "TASK-003"')) return undefined;
      const draft = stageAnswer(stage, prompt) as any;
      draft.steps[0].evidence = ["T-0999"];
      return draft;
    });
    await assert.rejects(confirmedRun(fake.send), (e: Error) => e instanceof ModelOutputError && /T-0999/.test(e.message));
    assert.equal(fake.calls.filter((c) => c.stage === "draftSop" && c.prompt.includes('"id": "TASK-003"')).length, 3);
  });

  it("gives an SOP draft every page of a document its task cites as a whole", async () => {
    const fake = fakeSender((stage, prompt) => {
      if (stage !== "extract") return undefined;
      const answer = stageAnswer(stage, prompt) as any;
      answer.tasks.find((t: any) => t.id === "TASK-003").evidence.push("D-09");
      return answer;
    });
    await confirmedRun(fake.send);
    const draft = fake.calls.find((c) => c.stage === "draftSop" && c.prompt.includes('"id": "TASK-003"'))!;
    assert.match(draft.prompt, /\[D-09 s1\] Sheet "Price List"/);
    assert.match(draft.prompt, /\[D-09 s2\] Sheet "Timesheet"/);
  });

  it("accepts a corrected answer after a failed one", async () => {
    const fake = fakeSender((stage, prompt, attempt) => {
      if (stage !== "voice" || attempt > 1) return undefined;
      return { ...(stageAnswer(stage, prompt) as object), exampleIds: ["D-01 p1", "D-04", "D-05"] };
    });
    const { result } = await confirmedRun(fake.send);
    assert.equal(result.status, "complete");
    assert.equal(fake.calls.filter((c) => c.stage === "voice").length, 2);
  });

  it("refuses data outside fixtures/ unless REAL_CLIENT_DATA is on", async () => {
    const clientDir = mkdtempSync(join(tmpdir(), "client-"));
    cpSync(FIXTURE, clientDir, { recursive: true });
    const outDir = mkdtempSync(join(tmpdir(), "blueprint-"));
    const fake = fakeSender();
    await assert.rejects(runPipeline(options(outDir, fake.send, { clientDir })), DataGateError);
    assert.deepEqual(fake.calls, []);
    const allowed = await runPipeline(options(outDir, fake.send, { clientDir, flags: readFlags({ REAL_CLIENT_DATA: "true" }) }));
    assert.equal(allowed.status, "awaiting_redaction_confirmation");
  });

  it("fails offline on a cache miss instead of calling the API", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "blueprint-"));
    await assert.rejects(runPipeline(options(outDir)), CacheMissError);
  });
});
