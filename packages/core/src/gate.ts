import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Flags } from "./flags.ts";

export class DataGateError extends Error {}

// Fixture data only, unless REAL_CLIENT_DATA is on. Resolves symlinks so a link
// inside fixtures/ can't point the pipeline at real data.
export function assertDataAllowed(clientDir: string, repoRoot: string, flags: Flags): void {
  const fixtures = realpathSync(resolve(repoRoot, "fixtures"));
  const dir = realpathSync(resolve(clientDir));
  const rel = relative(fixtures, dir);
  const insideFixtures = rel !== "" && rel.split(sep)[0] !== ".." && !isAbsolute(rel);
  if (insideFixtures || flags.REAL_CLIENT_DATA) return;
  throw new DataGateError(
    `${clientDir} is not fixture data. Real client data needs REAL_CLIENT_DATA=true, which stays off until the counsel items in docs/PLAN.md are closed.`,
  );
}

// `--client harbour-plumbing` looks in fixtures/ first, then clients/.
export function clientDirCandidates(repoRoot: string, clientId: string): string[] {
  return [resolve(repoRoot, "fixtures", clientId), resolve(repoRoot, "clients", clientId)];
}
