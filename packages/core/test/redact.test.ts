import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareEvidenceIds, createModelClient, loadConfig, proposeRedaction, type ClientProfile, type EvidenceBundle } from "../src/index.ts";
import { fakeSender } from "./fake-model.ts";
import { REPO_ROOT } from "./helpers.ts";

const config = loadConfig(`${REPO_ROOT}blueprint.config.json`);
const profile: ClientProfile = { clientId: "t", clientName: "T", clientPrefix: "TT", industry: "x", servicesBought: ["x"], teamSize: 1, state: "SA" };

async function redactText(text: string): Promise<string> {
  const bundle: EvidenceBundle = {
    clientId: "t",
    transcript: { path: "transcript/t.vtt", format: "vtt", sha256: "0".repeat(64) },
    documents: [],
    redaction: "not_started",
    items: [{ kind: "transcript_segment", id: "T-0001", speaker: "A", start: "00:00:00.000", end: "00:00:01.000", text }],
  };
  const model = createModelClient({
    config,
    cacheDir: mkdtempSync(join(tmpdir(), "cache-")),
    send: fakeSender(() => ({ flags: [] })).send,
  });
  const { redacted } = await proposeRedaction(bundle, profile, model);
  const item = redacted.items[0]!;
  return item.kind === "transcript_segment" ? item.text : "";
}

describe("deterministic redaction", () => {
  it("replaces BSBs and account numbers but keeps their labels", async () => {
    assert.equal(await redactText("BSB 999-001, Account 1234 5678."), "BSB [BSB_1], Account [ACCOUNT_1].");
  });
  it("replaces card numbers that pass the Luhn check only", async () => {
    assert.equal(await redactText("Card 4111 1111 1111 1111 paid"), "Card [CARD_1] paid");
    assert.equal(await redactText("Ref 4111 1111 1111 1112 kept"), "Ref 4111 1111 1111 1112 kept");
  });
  it("replaces labelled TFNs and unlabelled ones that pass the checksum", async () => {
    assert.equal(await redactText("TFN: 123456782"), "TFN: [TFN_1]");
    assert.equal(await redactText("my number is 123 456 782"), "my number is [TFN_1]");
    assert.equal(await redactText("job 123 456 789"), "job 123 456 789");
  });
  it("leaves ABNs alone, even when their last nine digits pass the TFN checksum", async () => {
    assert.equal(await redactText("ABN 11 123 456 782"), "ABN 11 123 456 782");
    assert.equal(await redactText("ABN 00 000 000 000"), "ABN 00 000 000 000");
  });
  it("gives the same value the same token", async () => {
    assert.equal(await redactText("BSB 999-001 and again BSB 999001"), "BSB [BSB_1] and again BSB [BSB_2]");
    assert.equal(await redactText("BSB 999-001 and BSB 999-001"), "BSB [BSB_1] and BSB [BSB_1]");
  });
});

it("orders evidence IDs as the bundle does", () => {
  assert.deepEqual(["D-10", "D-02 p1", "T-0002", "D-02", "T-0001", "D-02 s1"].sort(compareEvidenceIds), [
    "T-0001",
    "T-0002",
    "D-02",
    "D-02 p1",
    "D-02 s1",
    "D-10",
  ]);
});
