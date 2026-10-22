#!/usr/bin/env node
// blueprint run --client <id>                 run the pipeline on a client folder
// blueprint confirm-redaction --client <id> --by "<name>"
// blueprint validate --client <id>            re-check an existing client-data.json
import {
  CacheMissError,
  CLIENT_DATA_FILE,
  clientDirCandidates,
  confirmRedaction,
  createModelClient,
  DataGateError,
  anthropicSender,
  loadConfig,
  ModelOutputError,
  readFlags,
  runPipeline,
  validateClientData,
  ValidationFailedError,
} from "@me2/core";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const USAGE = `Usage:
  blueprint run --client <id> [--client-dir <path>] [--out <dir>] [--offline]
  blueprint confirm-redaction --client <id> --by "<your name>" [--out <dir>]
  blueprint validate --client <id> [--out <dir>]`;

function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      client: { type: "string" },
      "client-dir": { type: "string" },
      out: { type: "string" },
      by: { type: "string" },
      offline: { type: "boolean", default: false },
    },
  });
  const clientId = values.client;
  if (!command || !clientId) {
    console.error(USAGE);
    return 2;
  }
  const outDir = resolve(values.out ?? join(repoRoot, "out", clientId));

  if (command === "confirm-redaction") {
    if (!values.by) {
      console.error("Say who checked the redaction: --by \"<your name>\"");
      return 2;
    }
    confirmRedaction(outDir, values.by, new Date().toISOString());
    console.log(`Redaction confirmed by ${values.by}. Run \`blueprint run --client ${clientId}\` to continue.`);
    return 0;
  }

  if (command === "validate") {
    const path = join(outDir, CLIENT_DATA_FILE);
    const issues = validateClientData(JSON.parse(readFileSync(path, "utf8")));
    console.log(issues.length ? `${issues.length} issue(s):\n- ${issues.join("\n- ")}` : `${path} is valid.`);
    return issues.length ? 1 : 0;
  }

  if (command !== "run") {
    console.error(USAGE);
    return 2;
  }
  const clientDir = values["client-dir"]
    ? resolve(values["client-dir"])
    : clientDirCandidates(repoRoot, clientId).find((dir) => existsSync(dir));
  if (!clientDir) {
    console.error(`No client folder for ${clientId} in fixtures/ or clients/`);
    return 2;
  }
  const config = loadConfig(join(repoRoot, "blueprint.config.json"));
  const apiKey = process.env[config.apiKeyEnv];
  const model = createModelClient({
    config,
    cacheDir: join(outDir, ".cache"),
    ...(apiKey && !values.offline ? { send: anthropicSender(config, apiKey) } : {}),
    log: (line) => console.log(`  ${line}`),
  });

  const result = await runPipeline({
    repoRoot,
    clientDir,
    outDir,
    config,
    flags: readFlags(process.env),
    model,
    today: localDate(),
    confirmCommand: `npm run blueprint -- confirm-redaction --client ${clientId} --by "<your name>"`,
    log: (line) => console.log(line),
  });
  if (result.status === "awaiting_redaction_confirmation") {
    console.log(`\nStopped for redaction review: ${result.proposal}`);
    return 0;
  }
  const c = result.coverage;
  console.log(`\nWrote ${result.files.length} files to ${outDir}`);
  console.log(`Transcript coverage ${Math.round(c.share * 100)}% (${c.unmapped.length} unmapped); SOP steps ${c.steps.evidenced} evidenced, ${c.steps.assumed} assumed.`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const known = [DataGateError, ValidationFailedError, CacheMissError, ModelOutputError].some((E) => error instanceof E);
    console.error(known ? (error as Error).message : error);
    process.exit(1);
  },
);
