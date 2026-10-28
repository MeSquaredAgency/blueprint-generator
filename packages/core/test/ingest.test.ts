import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ingest, IngestError, parseTranscriptTxt, parseVtt, rfc2822ToIso } from "../src/index.ts";
import { FIXTURE, readJson } from "./helpers.ts";

describe("ingest", () => {
  it("turns the fixture into the sample evidence bundle (regenerate with npm run fixture:evidence)", async () => {
    assert.deepEqual(await ingest(FIXTURE, "harbour-plumbing"), readJson(`${FIXTURE}sample/evidence.json`));
  });

  it("requires a speaker label on every .vtt cue", () => {
    assert.throws(() => parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nNo speaker here\n"), IngestError);
  });

  it("reads plain-text transcripts with timestamps and speakers", () => {
    const segments = parseTranscriptTxt("[00:00:05] Interviewer: Hello\n[1:02:03.5] Dana Whitlock: Hi there\n");
    assert.deepEqual(
      segments.map((s) => s.kind === "transcript_segment" && [s.id, s.start, s.end, s.speaker, s.text]),
      [
        ["T-0001", "00:00:05.000", "01:02:03.500", "Interviewer", "Hello"],
        ["T-0002", "01:02:03.500", "01:02:03.500", "Dana Whitlock", "Hi there"],
      ],
    );
    assert.throws(() => parseTranscriptTxt("Hello with no timestamp"), IngestError);
  });

  it("keeps an email's own clock and offset", () => {
    assert.equal(rfc2822ToIso("Fri, 25 Sep 2026 11:20:00 +0930"), "2026-09-25T11:20:00+09:30");
  });
});
