import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { PipelineConfig, Stage } from "./config.ts";

export interface ModelRequest<T> {
  stage: Stage;
  label: string;
  // Stable across a client's calls for this stage, so it can be prompt-cached.
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  // Checks the schema can't express, e.g. "every cited evidence ID exists".
  // Failures go back to the model as a correction, like schema failures.
  check?: (value: T) => string[];
}

export interface ModelClient {
  generate<T>(request: ModelRequest<T>): Promise<T>;
}

export class ModelOutputError extends Error {}
export class CacheMissError extends Error {}

const MAX_ATTEMPTS = 3;

// Sends one structured-output request, then corrects it in the same
// conversation until it passes the schema and the check.
export type SendFn = (
  stage: Stage,
  system: string,
  messages: Anthropic.MessageParam[],
  schema: z.ZodType,
) => Promise<string>;

export function anthropicSender(config: PipelineConfig, apiKey: string): SendFn {
  const client = new Anthropic({ apiKey });
  return async (stage, system, messages, schema) => {
    const { model, effort } = config.stages[stage];
    const params = {
      model,
      max_tokens: config.maxTokens,
      system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
      messages,
      output_config: { effort, format: zodOutputFormat(schema) },
    };
    const useFallback = config.refusalFallback && stage !== "redact";
    const message = useFallback
      ? await client.beta.messages
          .stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
          .finalMessage()
      : await client.messages.stream(params).finalMessage();
    if (message.stop_reason === "refusal") {
      throw new ModelOutputError(`${stage}: the model declined the request (${message.stop_details?.category ?? "no category"})`);
    }
    if (message.stop_reason === "max_tokens") {
      throw new ModelOutputError(`${stage}: output hit max_tokens (${config.maxTokens}); raise maxTokens in blueprint.config.json`);
    }
    const blocks: readonly { type: string; text?: string }[] = message.content;
    return blocks.flatMap((b) => (b.type === "text" && b.text !== undefined ? [b.text] : [])).join("");
  };
}

function issuesOf<T>(request: ModelRequest<T>, text: string): { value?: T; issues: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { issues: [`Not valid JSON: ${(error as Error).message}`] };
  }
  const parsed = request.schema.safeParse(json);
  if (!parsed.success) return { issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const issues = request.check?.(parsed.data) ?? [];
  return issues.length ? { issues } : { value: parsed.data, issues };
}

// Every response is cached by a hash of everything that shapes it, so a re-run
// on unchanged input makes no calls and produces no diff. Without a sender the
// client is offline and fails on a cache miss.
export function createModelClient(options: {
  config: PipelineConfig;
  cacheDir: string;
  send?: SendFn;
  log?: (line: string) => void;
}): ModelClient {
  const { config, cacheDir, send, log = () => {} } = options;
  return {
    async generate<T>(request: ModelRequest<T>): Promise<T> {
      const { model, effort } = config.stages[request.stage];
      const key = createHash("sha256")
        .update(JSON.stringify([model, effort, request.system, request.prompt, z.toJSONSchema(request.schema)]))
        .digest("hex");
      const file = join(cacheDir, `${key}.json`);
      if (existsSync(file)) {
        const cached = issuesOf(request, (JSON.parse(readFileSync(file, "utf8")) as { text: string }).text);
        if (cached.value !== undefined) return cached.value;
        log(`${request.label}: cached response no longer passes its checks; asking again`);
      }
      if (!send) throw new CacheMissError(`${request.label}: no cached response and no API key (${config.apiKeyEnv})`);

      const messages: Anthropic.MessageParam[] = [{ role: "user", content: request.prompt }];
      for (let attempt = 1; ; attempt++) {
        log(`${request.label}: calling ${model}${attempt > 1 ? ` (correction ${attempt - 1})` : ""}`);
        const text = await send(request.stage, request.system, messages, request.schema);
        const result = issuesOf(request, text);
        if (result.value !== undefined) {
          mkdirSync(cacheDir, { recursive: true });
          writeFileSync(file, JSON.stringify({ stage: request.stage, label: request.label, model, effort, text }, null, 2) + "\n");
          return result.value;
        }
        if (attempt === MAX_ATTEMPTS) {
          throw new ModelOutputError(`${request.label}: still invalid after ${MAX_ATTEMPTS} attempts:\n- ${result.issues.join("\n- ")}`);
        }
        messages.push(
          { role: "assistant", content: text },
          { role: "user", content: `That output failed validation. Fix these and return the whole corrected JSON:\n- ${result.issues.join("\n- ")}` },
        );
      }
    },
  };
}

// Runs `fn` over `items` with at most `limit` in flight, keeping input order.
export async function mapLimit<A, B>(items: readonly A[], limit: number, fn: (item: A) => Promise<B>): Promise<B[]> {
  const results = new Array<B>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as A);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
