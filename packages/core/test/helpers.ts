import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const FIXTURE = `${REPO_ROOT}fixtures/harbour-plumbing/`;

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Every evidence ID cited anywhere inside a value, found by key name.
export function citedEvidenceIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(citedEvidenceIds);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, v]) =>
    key === "evidence" && Array.isArray(v) ? (v as string[]) : citedEvidenceIds(v),
  );
}
