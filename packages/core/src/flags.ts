// Every feature waiting on a decision ships behind a flag that defaults to off
// (docs/PLAN.md, "Build phases"). Flags are read from the environment the caller
// passes in, so tests and the CLI share one code path.
export const FLAG_NAMES = ["REAL_CLIENT_DATA", "GOOGLE_DOCS_EXPORT", "CLIENT_SIGNOFF", "AUTO_TRANSCRIBE"] as const;
export type FlagName = (typeof FLAG_NAMES)[number];
export type Flags = Readonly<Record<FlagName, boolean>>;

// Only an explicit "1" or "true" turns a flag on. Anything else, including a typo, is off.
export function readFlags(env: Readonly<Record<string, string | undefined>>): Flags {
  const on = (name: FlagName) => ["1", "true"].includes(env[name]?.trim().toLowerCase() ?? "");
  return Object.fromEntries(FLAG_NAMES.map((name) => [name, on(name)])) as Record<FlagName, boolean>;
}
