import { z } from "zod";
import { CallerContextSchema } from "../contracts/schemas.js";

/**
 * Operator operations contracts for zigma-core ops.
 * These describe a trusted local receipt-copy batch: they are not an OS
 * sandbox and do not merge, push or open pull requests.
 */

export const OPS_MANIFEST_SCHEMA = "zigma.ops/1";
export const OPS_PLAN_SCHEMA = "zigma.ops.plan/1";
export const OPS_RECEIPT_SCHEMA = "zigma.ops.receipt/1";
export const OPS_RUN_SCHEMA = "zigma.ops.run/1";
export const OPS_REPORT_SCHEMA = "zigma.ops.report/1";

export const EXIT_OK = 0;
export const EXIT_FAILED = 10;
export const EXIT_BLOCKED = 11;
export const EXIT_CONTRACT = 12;

export type OpsExitCode = 0 | 10 | 11 | 12;

export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const MAX_CAPTURE_BYTES = 1024 * 1024;

const DrivePrefix = /^[A-Za-z]:/;
const NUL = String.fromCharCode(0);

export const WorkloadKindSchema = z.enum(["deterministic", "fault-injection", "live-model", "real-repair"]);
export const ProposalFreedomSchema = z.enum(["none", "preapproved", "bounded", "unrestricted"]);

/**
 * Workspace-relative delivery path: relative, no traversal, no empty/dot
 * segments, no .git metadata on either slash style, no NUL, no drive or UNC.
 */
export function isSafeRelativePath(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return false;
  if (value.includes(NUL)) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (DrivePrefix.test(value)) return false;
  for (const segment of value.split(/[\\/]/)) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
    if (segment.toLowerCase() === ".git") return false;
  }
  return true;
}

/**
 * Host filesystem path (freeze files, suite lease, acceptance cwd). Absolute
 * paths are allowed because operators and fixtures reference files outside the
 * manifest directory; relative paths are resolved against the manifest dir.
 */
export function isSafeHostPath(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (value.includes(NUL)) return false;
  if (DrivePrefix.test(value) || value.startsWith("/") || value.startsWith("\\\\")) return true;
  for (const segment of value.split(/[\\/]/)) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
  }
  return true;
}

const SafeRelativeSchema = z.string().min(1).max(1024).refine(isSafeRelativePath, { message: "unsafe workspace-relative path" });
const SafeHostPathSchema = z.string().min(1).max(4096).refine(isSafeHostPath, { message: "unsafe host path" });

export const TaskKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

const SemverSchema = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Local-only Core URL. Rejects credentials, query, hash, paths other than "/"
 * and every host except loopback names/literals.
 */
export function parseLocalCoreUrl(raw: string): { origin: string; port: number } | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  const host = url.hostname.toLowerCase();
  const allowed = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  if (!allowed) return undefined;
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
  return { origin: url.origin, port };
}

export const CoreUrlSchema = z.string().min(1).max(2048).superRefine((value, ctx) => {
  if (!parseLocalCoreUrl(value)) {
    ctx.addIssue({ code: "custom", message: "coreUrl must be an http loopback origin (127.0.0.1, localhost or [::1]) without credentials, path, query or hash" });
  }
});

const FreezeFilesSchema = z.array(SafeHostPathSchema).min(1).refine((values) => new Set(values).size === values.length, { message: "freezeFiles must be unique" });
const DeliveryFilesSchema = z.array(SafeRelativeSchema).min(1).refine((values) => new Set(values).size === values.length, { message: "delivery.files must be unique" });

export const AcceptanceSchema = z.object({
  command: z.string().min(1).max(2048),
  args: z.array(z.string().max(8192)).max(256),
  cwd: SafeHostPathSchema.optional(),
  timeoutMs: z.number().int().min(50).max(24 * 60 * 60 * 1000).optional()
});
export type OpsAcceptance = z.infer<typeof AcceptanceSchema>;

export const DeliverySchema = z.object({ files: DeliveryFilesSchema });
export type OpsDelivery = z.infer<typeof DeliverySchema>;

/** Core accepts an arbitrary JSON record as task inputs. */
export const OpsTaskSpecSchema = z.object({
  key: TaskKeySchema,
  title: z.string().min(1).max(512),
  description: z.string().min(1).max(100_000),
  inputs: z.record(z.string(), z.unknown()).optional()
});
export type OpsTaskSpec = z.infer<typeof OpsTaskSpecSchema>;

const TasksSchema = z.array(OpsTaskSpecSchema).min(1).refine((tasks) => new Set(tasks.map((task) => task.key)).size === tasks.length, { message: "task keys must be unique" });

export const OpsManifestSchema = z.object({
  schema: z.literal(OPS_MANIFEST_SCHEMA),
  coreUrl: CoreUrlSchema,
  projectId: z.string().min(1).max(128),
  cohort: z.string().min(1).max(256),
  workloadKind: WorkloadKindSchema,
  proposalFreedom: ProposalFreedomSchema,
  modelRoute: z.string().min(1).max(512),
  workflowRef: z.string().min(1).max(4096),
  backend: z.string().min(1).max(64).default("claude-code"),
  callerContext: CallerContextSchema,
  suiteLeaseFile: SafeHostPathSchema,
  freezeFiles: FreezeFilesSchema,
  acceptance: AcceptanceSchema,
  delivery: DeliverySchema,
  tasks: TasksSchema,
  timeoutMs: z.number().int().min(50).max(24 * 60 * 60 * 1000).default(300_000),
  pollIntervalMs: z.number().int().min(10).max(3_600_000).default(250),
  cancelGraceMs: z.number().int().min(50).max(24 * 60 * 60 * 1000).default(30_000),
  preflightTimeoutMs: z.number().int().min(50).max(60_000).default(60_000)
}).strict();
export type OpsManifest = z.infer<typeof OpsManifestSchema>;

export const OpsFreezeEntrySchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/)
});
export type OpsFreezeEntry = z.infer<typeof OpsFreezeEntrySchema>;

/** Provider/client package versions are an object, never a display string. */
export const OpsSuiteSchema = z.object({
  core: z.string().min(1).max(256),
  flow: z.string().min(1).max(256),
  workspace: z.string().min(1).max(256)
});
export type OpsSuite = z.infer<typeof OpsSuiteSchema>;

export const OpsPlanSchema = z.object({
  schema: z.literal(OPS_PLAN_SCHEMA),
  runId: z.string().min(1).max(256),
  createdAt: z.string().min(1),
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  cohort: z.string().min(1).max(256),
  workloadKind: WorkloadKindSchema,
  proposalFreedom: ProposalFreedomSchema,
  modelRoute: z.string().min(1).max(512),
  modelRouteSource: z.literal("operator"),
  workflowRef: z.string().min(1),
  policyHash: z.string().regex(/^[0-9a-f]{64}$/),
  suite: OpsSuiteSchema,
  freeze: z.array(OpsFreezeEntrySchema).min(1),
  tasks: z.array(z.object({ key: TaskKeySchema, title: z.string().min(1) }).strict()).min(1),
  providerCommands: z.object({
    flow: OpsFreezeEntrySchema,
    workspace: OpsFreezeEntrySchema
  }).strict().optional(),
  clientVersion: z.string().min(1).optional()
}).strict();
export type OpsPlan = z.infer<typeof OpsPlanSchema>;

export const ReceiptStatusSchema = z.enum(["delivered", "rejected", "failed", "blocked", "not_started"]);
export const ReceiptAcceptanceSchema = z.object({
  status: z.enum(["pass", "fail", "blocked", "not_run"]),
  reason: z.string().max(8000).optional()
});
export const ReceiptArtifactSchema = z.object({
  path: SafeRelativeSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES)
});
export const ReceiptDeliverySchema = z.object({
  status: z.enum(["pass", "blocked", "not_run"]),
  artifacts: z.array(ReceiptArtifactSchema)
});

export const OpsReceiptSchema = z.object({
  schema: z.literal(OPS_RECEIPT_SCHEMA),
  runId: z.string().min(1).max(256),
  key: TaskKeySchema,
  taskId: z.string().min(1).max(256).optional(),
  flowRunId: z.string().min(1).max(256).optional(),
  executionCommandId: z.string().min(1).max(256).optional(),
  workspacePath: z.string().min(1).max(4096).optional(),
  status: ReceiptStatusSchema,
  executionStatus: z.string().min(1).max(128),
  acceptance: ReceiptAcceptanceSchema,
  delivery: ReceiptDeliverySchema,
  providerQuiescent: z.boolean(),
  startedAt: z.string().min(1).optional(),
  finishedAt: z.string().min(1),
  elapsedMs: z.number().int().nonnegative(),
  attempted: z.boolean(),
  exitCode: z.union([z.literal(0), z.literal(10), z.literal(11), z.literal(12)]).optional(),
  reason: z.string().max(8000).optional()
}).strict().superRefine((receipt, context) => {
  if (receipt.status === "delivered" && (!receipt.attempted || !receipt.providerQuiescent
    || receipt.acceptance.status !== "pass" || receipt.delivery.status !== "pass" || receipt.delivery.artifacts.length === 0)) {
    context.addIssue({ code: "custom", message: "delivered receipt requires a quiescent attempted task, passing acceptance and delivered artifacts" });
  }
  if (receipt.acceptance.status === "pass" && (!receipt.attempted || !receipt.providerQuiescent || receipt.executionStatus !== "completed")) {
    context.addIssue({ code: "custom", message: "acceptance success requires a completed, attempted and quiescent execution" });
  }
  if (receipt.status === "not_started" && (receipt.attempted || receipt.acceptance.status !== "not_run" || receipt.delivery.status !== "not_run")) {
    context.addIssue({ code: "custom", message: "unstarted receipt cannot claim attempts, acceptance or delivery" });
  }
  if (receipt.delivery.status === "pass" && receipt.status !== "delivered") {
    context.addIssue({ code: "custom", message: "delivery success requires delivered receipt status" });
  }
});
export type OpsReceipt = z.infer<typeof OpsReceiptSchema>;

export const NoteKindSchema = z.enum(["review", "repair", "reset", "retry", "other"]);
export type NoteKind = z.infer<typeof NoteKindSchema>;

export const OpsNoteSchema = z.object({
  id: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  key: TaskKeySchema,
  kind: NoteKindSchema,
  reason: z.string().min(1).max(8000),
  at: z.string().min(1)
}).strict();
export type OpsNote = z.infer<typeof OpsNoteSchema>;

export const OpsRunOutputSchema = z.object({
  schema: z.literal(OPS_RUN_SCHEMA),
  runId: z.string().min(1),
  outDir: z.string().min(1),
  exitCode: z.union([z.literal(0), z.literal(10), z.literal(11), z.literal(12)]),
  results: z.array(OpsReceiptSchema)
});
export type OpsRunOutput = z.infer<typeof OpsRunOutputSchema>;

export const OpsReportGroupSchema = z.object({
  clientVersion: z.string().min(1),
  cohort: z.string().min(1),
  workloadKind: z.string().min(1),
  proposalFreedom: z.string().min(1),
  modelRoute: z.string().min(1),
  policyHash: z.string().min(1),
  suite: OpsSuiteSchema,
  planned: z.number().int().nonnegative(),
  attempted: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  notStarted: z.number().int().nonnegative(),
  recordedInterventions: z.number().int().nonnegative(),
  recordedReviews: z.number().int().nonnegative(),
  totalElapsedMs: z.number().int().nonnegative(),
  acceptanceRate: z.number().nullable(),
  deliveryRate: z.number().nullable()
});
export type OpsReportGroup = z.infer<typeof OpsReportGroupSchema>;

export const OpsReportSchema = z.object({
  schema: z.literal(OPS_REPORT_SCHEMA),
  groups: z.array(OpsReportGroupSchema)
});
export type OpsReport = z.infer<typeof OpsReportSchema>;

/** Operations failure with a CLI exit code (never thrown to an unhandled path). */
export class OpsError extends Error {
  readonly exitCode: OpsExitCode;
  constructor(message: string, exitCode: OpsExitCode) {
    super(message);
    this.name = "OpsError";
    this.exitCode = exitCode;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function highestPriorityExit(codes: readonly OpsExitCode[]): OpsExitCode {
  if (codes.includes(12)) return 12;
  if (codes.includes(10)) return 10;
  if (codes.includes(11)) return 11;
  return 0;
}

export function isSemver(value: unknown): value is string {
  return typeof value === "string" && SemverSchema.test(value);
}

export function relativePathKey(value: string): string {
  return value.split(/[\\/]/).join("/");
}
