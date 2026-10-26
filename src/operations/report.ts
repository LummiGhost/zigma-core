import { randomUUID } from "node:crypto";
import { appendFile, lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  OPS_REPORT_SCHEMA,
  OpsError,
  OpsNoteSchema,
  OpsPlanSchema,
  OpsReceiptSchema,
  OpsReportSchema,
  TaskKeySchema,
  errorMessage,
  type NoteKind,
  type OpsPlan,
  type OpsReceipt,
  type OpsReport,
  type OpsReportGroup
} from "./schema.js";

/**
 * Grouped, evidence-bounded batch reporting and self-reported operator notes.
 * Reports never assert verified absence of human intervention.
 */

async function readJson(path: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new OpsError(`cannot read ${label}: ${errorMessage(error)}`, 12);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OpsError(`${label} is not valid JSON`, 12);
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function isRealFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function isBatchDir(path: string): Promise<boolean> {
  return (await isRealDirectory(path)) && (await isRealFile(join(path, "plan.json")));
}

/** Immediate child batch directories only; symlinked directories are never followed. */
async function batchDirectories(dir: string): Promise<string[]> {
  if (!(await isRealDirectory(dir))) throw new OpsError(`not a directory: ${dir}`, 12);
  if (await isBatchDir(dir)) return [dir];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    throw new OpsError(`cannot read directory: ${errorMessage(error)}`, 12);
  }
  const batches: string[] = [];
  for (const name of names.sort()) {
    const child = join(dir, name);
    if (await isBatchDir(child)) batches.push(child);
  }
  return batches;
}

async function loadPlan(dir: string): Promise<OpsPlan> {
  const parsed = OpsPlanSchema.safeParse(await readJson(join(dir, "plan.json"), `plan in ${dir}`));
  if (!parsed.success) {
    throw new OpsError(`plan.json failed validation: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`, 12);
  }
  if (new Set(parsed.data.tasks.map((task) => task.key)).size !== parsed.data.tasks.length) {
    throw new OpsError("plan has duplicate task keys", 12);
  }
  return parsed.data;
}

async function loadReceipts(dir: string, plan: OpsPlan): Promise<Map<string, OpsReceipt>> {
  const tasksDir = join(dir, "tasks");
  const receipts = new Map<string, OpsReceipt>();
  const planned = new Set(plan.tasks.map((task) => task.key));
  if (!(await isRealDirectory(tasksDir))) return receipts;
  const entries = (await readdir(tasksDir)).sort();
  for (const key of entries) {
    const taskPath = join(tasksDir, key);
    if (!(await isRealDirectory(taskPath))) throw new OpsError(`unexpected entry under tasks/: ${key}`, 12);
    if (!TaskKeySchema.safeParse(key).success) throw new OpsError(`unexpected task directory: ${key}`, 12);
    if (!planned.has(key)) throw new OpsError(`task directory not planned in this batch: ${key}`, 12);
    if (receipts.has(key)) throw new OpsError(`duplicate receipt for ${key}`, 12);
    const receiptPath = join(taskPath, "receipt.json");
    if (!(await isRealFile(receiptPath))) continue;
    const parsed = OpsReceiptSchema.safeParse(await readJson(receiptPath, `receipt for ${key}`));
    if (!parsed.success) throw new OpsError(`receipt for ${key} failed validation`, 12);
    if (parsed.data.runId !== plan.runId) throw new OpsError(`receipt runId mismatch for ${key}`, 12);
    if (parsed.data.key !== key) throw new OpsError(`receipt key mismatch: ${key}`, 12);
    receipts.set(key, parsed.data);
  }
  return receipts;
}

interface NoteCounts {
  interventions: Set<string>;
  reviews: Set<string>;
}

async function loadNotes(dir: string, plan: OpsPlan): Promise<NoteCounts> {
  const result: NoteCounts = { interventions: new Set(), reviews: new Set() };
  const seen = new Map<string, string>();
  const path = join(dir, "interventions.jsonl");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new OpsError("audit notes must be a regular single-link file", 12);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  const text = await readFile(path, "utf8");
  const planned = new Set(plan.tasks.map((task) => task.key));
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      throw new OpsError("interventions.jsonl contains malformed JSON", 12);
    }
    const parsed = OpsNoteSchema.safeParse(raw);
    if (!parsed.success) throw new OpsError("intervention note failed validation", 12);
    const note = parsed.data;
    const encoded = JSON.stringify(note);
    if (seen.has(note.id)) {
      if (seen.get(note.id) !== encoded) throw new OpsError(`contradictory intervention id: ${note.id}`, 12);
      continue;
    }
    seen.set(note.id, encoded);
    if (note.runId !== plan.runId) throw new OpsError(`note runId mismatch: ${note.id}`, 12);
    if (!planned.has(note.key)) throw new OpsError(`note references unplanned task: ${note.key}`, 12);
    if (note.kind === "review") result.reviews.add(note.id);
    else result.interventions.add(note.id);
  }
  return result;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

const NOTE_KINDS: readonly NoteKind[] = ["review", "repair", "reset", "retry", "other"];

export async function buildReport(dirInput: string): Promise<OpsReport> {
  const dir = resolve(dirInput);
  const batches = await batchDirectories(dir);
  if (batches.length === 0) throw new OpsError("no batch directories (with plan.json) found to report", 11);
  const runIds = new Set<string>();
  const groups = new Map<string, OpsReportGroup>();

  for (const batch of batches) {
    const plan = await loadPlan(batch);
    if (runIds.has(plan.runId)) throw new OpsError(`duplicate runId across batches: ${plan.runId}`, 12);
    runIds.add(plan.runId);
    const receipts = await loadReceipts(batch, plan);
    const notes = await loadNotes(batch, plan);

    const groupKey = JSON.stringify([plan.cohort, plan.workloadKind, plan.proposalFreedom, plan.modelRoute, plan.policyHash, plan.suite, plan.clientVersion ?? "unknown"]);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        clientVersion: plan.clientVersion ?? "unknown",
        cohort: plan.cohort,
        workloadKind: plan.workloadKind,
        proposalFreedom: plan.proposalFreedom,
        modelRoute: plan.modelRoute,
        policyHash: plan.policyHash,
        suite: { ...plan.suite },
        planned: 0,
        attempted: 0,
        accepted: 0,
        delivered: 0,
        failed: 0,
        blocked: 0,
        unknown: 0,
        notStarted: 0,
        recordedInterventions: 0,
        recordedReviews: 0,
        totalElapsedMs: 0,
        acceptanceRate: null,
        deliveryRate: null
      };
      groups.set(groupKey, group);
    }

    group.planned += plan.tasks.length;
    group.recordedInterventions += notes.interventions.size;
    group.recordedReviews += notes.reviews.size;
    for (const task of plan.tasks) {
      const receipt = receipts.get(task.key);
      if (!receipt) {
        // Planned but no final receipt: unknown, never invented as a zero result.
        group.unknown += 1;
        continue;
      }
      group.totalElapsedMs += receipt.elapsedMs;
      if (receipt.attempted) group.attempted += 1;
      if (receipt.acceptance.status === "pass") group.accepted += 1;
      switch (receipt.status) {
        case "delivered":
          group.delivered += 1;
          break;
        case "failed":
        case "rejected":
          group.failed += 1;
          break;
        case "blocked":
          group.blocked += 1;
          break;
        case "not_started":
          group.notStarted += 1;
          break;
      }
    }
  }

  for (const group of groups.values()) {
    group.acceptanceRate = rate(group.accepted, group.attempted);
    group.deliveryRate = rate(group.delivered, group.planned);
  }
  const sorted = [...groups.values()].sort((a, b) => {
    const left = JSON.stringify([a.cohort, a.workloadKind, a.proposalFreedom, a.modelRoute, a.policyHash, a.suite]);
    const right = JSON.stringify([b.cohort, b.workloadKind, b.proposalFreedom, b.modelRoute, b.policyHash, b.suite]);
    return left.localeCompare(right);
  });
  return OpsReportSchema.parse({ schema: OPS_REPORT_SCHEMA, groups: sorted });
}

export interface NoteInput {
  dir: string;
  key: string;
  kind: string;
  reason: string;
}

export type NoteRecord = { runId: string; id: string; key: string; kind: NoteKind; reason: string; at: string };

export interface OpsNoteOutput {
  schema: "zigma.ops.note/1";
  note: NoteRecord;
}

/** Append one self-reported note; receipts are never modified. */
export async function appendNote(input: NoteInput): Promise<OpsNoteOutput> {
  const dir = resolve(input.dir);
  if (!(await isBatchDir(dir))) throw new OpsError("note --dir must be a batch directory containing plan.json", 12);
  const plan = await loadPlan(dir);
  if (!TaskKeySchema.safeParse(input.key).success) throw new OpsError(`invalid task key: ${input.key}`, 12);
  if (!plan.tasks.some((task) => task.key === input.key)) throw new OpsError(`task key not planned in batch: ${input.key}`, 12);
  const kind = NOTE_KINDS.find((candidate) => candidate === input.kind);
  if (kind === undefined) throw new OpsError("note --kind must be review|repair|reset|retry|other", 12);
  const reason = input.reason.trim();
  if (reason.length === 0) throw new OpsError("note --reason must be non-empty", 12);
  if (reason.length > 8000) throw new OpsError("note --reason exceeds 8000 characters", 12);
  const note = OpsNoteSchema.parse({
    runId: plan.runId,
    id: `note-${randomUUID()}`,
    key: input.key,
    kind,
    reason,
    at: new Date().toISOString()
  });
  const auditPath = join(dir, "interventions.jsonl");
  try {
    const info = await lstat(auditPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new OpsError("audit notes must be a regular single-link file", 12);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await appendFile(auditPath, `${JSON.stringify(note)}\n`, { encoding: "utf8", flag: "a" });
  return { schema: "zigma.ops.note/1", note };
}
