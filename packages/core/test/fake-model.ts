import type { SendFn } from "../src/llm.ts";
import type { Sop, Task } from "../src/schemas/index.ts";
import { FIXTURE, readJson } from "./helpers.ts";

// A stand-in for the API that answers each stage from the Phase 1 sample files,
// so the whole pipeline runs offline. `override` lets a test change one answer.

type Sample = {
  tasks: { tasks: Task[] };
  blueprint: any;
  agentPrompt: any;
  sops: Record<string, Sop>;
};

const sample = (): Sample => ({
  tasks: readJson(`${FIXTURE}sample/tasks.json`) as Sample["tasks"],
  blueprint: readJson(`${FIXTURE}sample/blueprint.json`),
  agentPrompt: readJson(`${FIXTURE}sample/agent-prompt.json`),
  sops: Object.fromEntries(
    ["HBP-FIN-001", "HBP-FIN-002", "HBP-SAL-001"].map((id) => {
      const sop = readJson(`${FIXTURE}sample/sops/${id}.json`) as Sop;
      return [sop.taskId, sop];
    }),
  ),
});

const NOT_DESCRIBED = ["TASK-005", "TASK-008", "TASK-010"];
const OUT_OF_SCOPE = ["T-0001", "T-0002", "T-0003", "T-0004", "T-0043", "T-0044"];

export function stageAnswer(stage: string, prompt: string): unknown {
  const s = sample();
  switch (stage) {
    case "prepare":
      return {
        questionnaire: [{ question: "Which systems do you use for jobs, invoices and pay?", why: "Names every system before the call" }],
        guide: [
          {
            section: "Money in",
            goal: "Walk through a job from completion to payment",
            questions: ["What happens when a job is finished?"],
            probes: ["Is there ever a job where you'd do it differently?"],
          },
        ],
      };
    case "redact":
      return {
        flags: [
          { evidenceId: "D-04", text: "Mark Ellison", category: "CUSTOMER" },
          { evidenceId: "D-04", text: "Mark", category: "CUSTOMER" },
          { evidenceId: "D-01 p1", text: "14 Wharf Street, Port Halyard SA 5999", category: "ADDRESS" },
          { evidenceId: "D-04", text: "14 Wharf Street", category: "ADDRESS" },
          { evidenceId: "D-07", text: "Sam Okafor", category: "CONTACT" },
          { evidenceId: "D-05", text: "Nobody Here", category: "OTHER" },
        ],
      };
    case "extract":
      // The model only sees redacted text, so it can't name the bookkeeper.
      return JSON.parse(JSON.stringify({
        business: {
          summary: s.blueprint.overview.summary,
          services: s.blueprint.overview.services,
          systems: s.blueprint.systems,
          roles: s.blueprint.roles,
          approvals: s.blueprint.overview.approvals,
          glossary: s.agentPrompt.glossary,
        },
        tasks: s.tasks.tasks,
        routing: s.blueprint.routing.map(({ taskId, route, rationale }: any) => ({ taskId, route, rationale })),
      }).replaceAll("Sam Okafor", "[CONTACT_1]"));
    case "reconcile": {
      const segments = [...prompt.matchAll(/^\[(T-\d{4})\]/gm)].map((m) => m[1] as string);
      return {
        segments: segments.map((id) => ({
          segmentId: id,
          taskIds: s.tasks.tasks.filter((t) => t.evidence.includes(id)).map((t) => t.id),
          outOfScope: OUT_OF_SCOPE.includes(id),
        })),
        merges: [],
        contradictions: [
          {
            topic: "Payment terms",
            detail: "The interview says 14 days; every invoice says 7 days.",
            said: ["T-0011"],
            shown: ["D-01 p1", "D-02 p1", "D-03 p1"],
            taskId: "TASK-001",
          },
        ],
        gaps: NOT_DESCRIBED.map((taskId) => ({ kind: "not_described", detail: "Mentioned but not walked through", taskId, evidence: [] })),
        followUps: [{ question: "Are payment terms 7 days or 14?", why: "The interview and invoices disagree", taskId: "TASK-001", evidence: ["T-0011", "D-01 p1"] }],
      };
    }
    case "draftSop": {
      const taskId = /"id": "(TASK-\d{3})"/.exec(prompt)?.[1] as string;
      const task = s.tasks.tasks.find((t) => t.id === taskId) as Task;
      const known = s.sops[taskId];
      if (known) {
        const { id, taskId: _t, owner: _o, status: _s, version: _v, versionDate: _vd, reviewBy: _r, ...body } = known;
        return { ...body, functionCode: id.split("-")[1] };
      }
      return {
        title: task.name,
        trigger: task.trigger,
        frequency: task.frequency,
        contributors: [],
        systems: [],
        inputs: [],
        outputs: [{ item: "Completed task", destination: "Noted in the task log" }],
        steps: [
          { n: 1, actor: "operator", action: task.name, evidence: [task.evidence[0]] },
          { n: 2, actor: "operator", action: "Record that it was done", evidence: "ASSUMED" },
        ],
        decisionPoints: [],
        qualityChecks: ["The task log shows the date it was done"],
        escalation: ["money", "legal", "complaints"].map((topic) => ({ topic, when: `Anything about ${topic}`, contact: "Dana Whitlock" })),
        templates: [],
        scoring: { minutesPerRun: 15, repeatability: 3, manualTime: 3, buildEffort: 3 },
        functionCode: "OPS",
      };
    }
    case "voice":
      return {
        greetings: ["Hi {first name},"],
        signOffs: ["Cheers,\nPriya"],
        formality: "neutral",
        useWords: ["friendly reminder"],
        avoidWords: [],
        exampleIds: ["D-04", "D-05", "D-07"],
      };
  }
  throw new Error(`No fake answer for stage ${stage}`);
}

export interface FakeSender {
  send: SendFn;
  calls: { stage: string; prompt: string }[];
}

export function fakeSender(override?: (stage: string, prompt: string, attempt: number) => unknown): FakeSender {
  const calls: FakeSender["calls"] = [];
  const send: SendFn = async (stage, _system, messages) => {
    const prompt = messages[0]!.content as string;
    calls.push({ stage, prompt });
    const attempt = (messages.length + 1) / 2;
    const answer = override?.(stage, prompt, attempt) ?? stageAnswer(stage, prompt);
    return JSON.stringify(answer);
  };
  return { send, calls };
}
