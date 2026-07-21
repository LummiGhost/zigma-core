/** Prefixed, sortable-ish identifiers for Zigma Core entities. */
import { randomBytes } from "node:crypto";

const PREFIXES = {
  project: "prj",
  repository: "repo",
  task: "task",
  flowRun: "frun",
  workspaceRef: "wsr",
  gate: "gate",
  decision: "hdec",
  evidence: "evb",
  link: "lnk",
  audit: "aud",
  snapshot: "psnap",
  profile: "xprof",
} as const;

export type IdKind = keyof typeof PREFIXES;

export function newId(kind: IdKind): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(5).toString("hex");
  return `${PREFIXES[kind]}_${ts}${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
