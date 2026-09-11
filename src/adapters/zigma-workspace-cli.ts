import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type {
  PreparedWorkspace,
  WorkspaceEvidence,
  WorkspaceInvocationContext,
  WorkspacePreparationRequest,
  WorkspaceProvider
} from "../contracts/ports.js";
import { IntegrationError } from "../domain/errors.js";

interface WorkspaceEnvelope<T> {
  contract_version: number;
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

interface WorkspaceContractInfo {
  provider: string;
  package_version: string;
  contract_version: number;
  capabilities: unknown;
}

interface WorkspaceArtifactDescriptor {
  id?: unknown;
  kind?: unknown;
  uri?: unknown;
  media_type?: unknown;
  digest?: unknown;
}

interface VerifiedArtifact {
  id?: string;
  kind?: string;
  uri: string;
  mediaType: string;
  digest: string;
  sizeBytes: number;
}

interface WorkspaceDiffData {
  workspace_id: string;
  base_commit: string;
  head_commit: string | null;
  changed_files: string[];
  untracked_files: string[];
  status_text: string;
  patch_artifact: WorkspaceArtifactDescriptor | null;
  summary: string;
}

interface WorkspaceSnapshotData {
  snapshot_id: string;
  workspace_id: string;
  kind: string;
  artifacts: WorkspaceArtifactDescriptor[];
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WORKSPACE_CONTRACT_VERSION = 1;
const WORKSPACE_PROVIDER = "zigma-workspace";
/** Core's M0 role requirements — deliberately narrower than the provider's managed lifecycle role. */
export const REQUIRED_WORKSPACE_CAPABILITIES = [
  "workspace-create-v1",
  "workspace-bind-run-v1",
  "workspace-diff-artifact-v1",
  "workspace-snapshot-artifacts-v1",
  "workspace-cleanup-v1"
] as const;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function contractCacheKey(command: string, environment: Record<string, string>): string {
  return JSON.stringify([
    command,
    process.env["PATH"] ?? "",
    process.env["PATHEXT"] ?? "",
    Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))
  ]);
}

function parseEnvelope<T>(output: string, processExitCode: number, operation: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new IntegrationError("zigma-workspace returned invalid JSON", {
      operation,
      exitCode: processExitCode,
      output: output.slice(-4_000)
    });
  }
  if (!isRecord(parsed)) {
    throw new IntegrationError("zigma-workspace stdout must be a V1 envelope object", { operation, exitCode: processExitCode });
  }
  const envelope = parsed as unknown as WorkspaceEnvelope<T>;
  if (envelope.contract_version !== WORKSPACE_CONTRACT_VERSION) {
    throw new IntegrationError(
      `zigma-workspace contract version mismatch: expected ${WORKSPACE_CONTRACT_VERSION}, got ${String(envelope.contract_version)}`,
      {
        contractVersion: envelope.contract_version,
        expectedVersion: WORKSPACE_CONTRACT_VERSION,
        operation
      }
    );
  }
  if (envelope.ok !== true) {
    if (envelope.ok !== false || !isRecord(envelope.error)
      || typeof envelope.error.code !== "string" || !envelope.error.code
      || typeof envelope.error.message !== "string" || !envelope.error.message) {
      throw new IntegrationError("zigma-workspace error envelope is malformed", { operation, exitCode: processExitCode });
    }
    throw new IntegrationError(envelope.error?.message ?? "zigma-workspace command failed", {
      operation,
      exitCode: processExitCode,
      providerCode: envelope.error?.code,
      details: envelope.error?.details
    });
  }
  if (processExitCode !== 0) {
    throw new IntegrationError("zigma-workspace process failed despite a success envelope", {
      operation,
      exitCode: processExitCode
    });
  }
  if (envelope.data === undefined) {
    throw new IntegrationError("zigma-workspace success envelope is missing data", { operation });
  }
  return envelope.data;
}

/** Exported for the M3 cross-repo negotiation-agreement contract test. */
export function validateContractInfo(info: WorkspaceContractInfo): WorkspaceContractInfo {
  if (info.contract_version !== WORKSPACE_CONTRACT_VERSION) {
    throw new IntegrationError(
      `zigma-workspace advertised contract version mismatch: expected ${WORKSPACE_CONTRACT_VERSION}, got ${String(info.contract_version)}`,
      { contractVersion: info.contract_version, expectedVersion: WORKSPACE_CONTRACT_VERSION }
    );
  }
  if (info.provider !== WORKSPACE_PROVIDER) {
    throw new IntegrationError(
      `zigma-workspace provider mismatch: expected ${WORKSPACE_PROVIDER}, got ${String(info.provider)}`,
      { provider: info.provider, expectedProvider: WORKSPACE_PROVIDER }
    );
  }
  // Keep the advertised package version in the cached handshake for operator
  // diagnostics, but negotiate compatibility solely through identity, v1, and
  // required capabilities so compatible provider releases keep working.
  if (typeof info.package_version !== "string" || !info.package_version.trim()) {
    throw new IntegrationError("zigma-workspace contract-info package_version must be a non-empty string", {
      packageVersion: info.package_version
    });
  }
  if (!Array.isArray(info.capabilities) || !info.capabilities.every((item) => typeof item === "string")) {
    throw new IntegrationError("zigma-workspace contract-info capabilities must be a string array");
  }
  const missingCapabilities = REQUIRED_WORKSPACE_CAPABILITIES.filter(
    (capability) => !(info.capabilities as string[]).includes(capability)
  );
  if (missingCapabilities.length > 0) {
    throw new IntegrationError("zigma-workspace is missing required provider capabilities", {
      missingCapabilities,
      requiredCapabilities: [...REQUIRED_WORKSPACE_CAPABILITIES]
    });
  }
  return info;
}

async function verifyArtifact(
  descriptor: WorkspaceArtifactDescriptor,
  operation: "diff" | "snapshot",
  requireIdentity: boolean
): Promise<VerifiedArtifact> {
  const uri = descriptor.uri;
  const mediaType = descriptor.media_type;
  const digest = descriptor.digest;
  if (typeof uri !== "string" || typeof mediaType !== "string" || typeof digest !== "string") {
    throw new IntegrationError(`zigma-workspace ${operation} returned an invalid artifact descriptor`);
  }
  if (!SHA256_DIGEST_PATTERN.test(digest)) {
    throw new IntegrationError(`zigma-workspace ${operation} returned an invalid SHA-256 digest`, { digest });
  }
  let artifactPath: string;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:") throw new Error("not a file URI");
    artifactPath = fileURLToPath(parsed);
  } catch {
    throw new IntegrationError(`zigma-workspace ${operation} artifact URI must be a local file URI`, { uri });
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(artifactPath);
  } catch (error) {
    throw new IntegrationError(`zigma-workspace ${operation} artifact could not be read`, {
      uri,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  const actualDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actualDigest !== digest) {
    throw new IntegrationError(`zigma-workspace ${operation} artifact digest mismatch`, {
      uri,
      expectedDigest: digest,
      actualDigest
    });
  }

  const verified: VerifiedArtifact = { uri, mediaType, digest, sizeBytes: bytes.byteLength };
  if (requireIdentity) {
    if (typeof descriptor.id !== "string" || !descriptor.id || typeof descriptor.kind !== "string" || !descriptor.kind) {
      throw new IntegrationError("zigma-workspace snapshot artifact is missing id or kind");
    }
    verified.id = descriptor.id;
    verified.kind = descriptor.kind;
  }
  return verified;
}

export class ZigmaWorkspaceCliAdapter implements WorkspaceProvider {
  private readonly contractCache = new Map<string, Promise<WorkspaceContractInfo>>();

  private async ensureCompatibleProvider(context: WorkspaceInvocationContext): Promise<void> {
    const key = contractCacheKey(context.command, context.environment);
    let pending = this.contractCache.get(key);
    if (!pending) {
      pending = (async () => {
        const result = await execa(context.command, ["contract-info", "--json"], {
          env: { ...process.env, ...context.environment },
          timeout: context.timeoutMs,
          reject: false,
          all: true
        });
        const info = parseEnvelope<WorkspaceContractInfo>(
          result.stdout ?? result.all ?? "",
          result.exitCode ?? 1,
          "contract-info"
        );
        return validateContractInfo(info);
      })();
      this.contractCache.set(key, pending);
      pending.catch(() => this.contractCache.delete(key));
    }
    await pending;
  }

  async preflight(context: WorkspaceInvocationContext): Promise<void> {
    await this.ensureCompatibleProvider(context);
  }

  private async invoke<T>(context: WorkspaceInvocationContext, args: string[]): Promise<T> {
    await this.ensureCompatibleProvider(context);
    const result = await execa(context.command, [...args, "--json"], {
      env: { ...process.env, ...context.environment },
      timeout: context.timeoutMs,
      reject: false,
      all: true
    });
    return parseEnvelope<T>(result.stdout ?? result.all ?? "", result.exitCode ?? 1, args[0] ?? "unknown");
  }

  async prepare(request: WorkspacePreparationRequest): Promise<PreparedWorkspace> {
    const data = await this.invoke<{
      workspace_id: string;
      path: string;
      branch: string;
      base_ref: string;
      base_commit: string;
      mode: "writable" | "read-only";
      status: string;
      manifest_path: string;
      created_at: string;
    }>({ command: request.command, timeoutMs: request.timeoutMs, environment: request.environment }, [
      "create",
      "--repo",
      request.repository.url,
      "--base",
      request.baseRef,
      "--branch",
      request.branch,
      "--mode",
      request.policy.mode,
      "--project",
      request.projectId,
      "--task",
      request.taskId,
      "--flow-run",
      request.flowRunId,
      "--operation-id",
      `core:workspace:create:${request.flowRunId}`
    ]);
    return {
      provider: "zigma-workspace-cli",
      externalId: data.workspace_id,
      path: data.path,
      repositoryUrl: request.repository.url,
      baseRef: data.base_ref,
      baseCommit: data.base_commit,
      branch: data.branch,
      mode: data.mode,
      metadata: {
        manifestPath: data.manifest_path,
        providerStatus: data.status,
        providerCreatedAt: data.created_at
      }
    };
  }

  async bindRun(externalWorkspaceId: string, taskId: string, flowRunId: string, context: WorkspaceInvocationContext): Promise<void> {
    await this.invoke(context, [
      "bind-run",
      "--workspace",
      externalWorkspaceId,
      "--task",
      taskId,
      "--flow-run",
      flowRunId,
      "--operation-id",
      `core:workspace:bind:${flowRunId}`
    ]);
  }

  async collectEvidence(externalWorkspaceId: string, context: WorkspaceInvocationContext): Promise<WorkspaceEvidence> {
    const diff = await this.invoke<WorkspaceDiffData>(context, ["diff", "--workspace", externalWorkspaceId]);
    if (!("patch_artifact" in diff) || (diff.patch_artifact !== null && typeof diff.patch_artifact !== "object")) {
      throw new IntegrationError("zigma-workspace diff response is missing patch_artifact");
    }
    const patchArtifact = diff.patch_artifact === null
      ? undefined
      : await verifyArtifact(diff.patch_artifact, "diff", false);

    const snapshot = await this.invoke<WorkspaceSnapshotData>(context, ["snapshot", "--workspace", externalWorkspaceId]);
    if (!Array.isArray(snapshot.artifacts) || snapshot.artifacts.length === 0) {
      throw new IntegrationError("zigma-workspace snapshot response is missing artifacts");
    }
    const snapshotArtifacts = await Promise.all(
      snapshot.artifacts.map((artifact) => verifyArtifact(artifact, "snapshot", true))
    );

    return {
      items: [
        {
          kind: "workspace-diff",
          name: "workspace-diff",
          uri: patchArtifact?.uri ?? `zigma-workspace://${externalWorkspaceId}/diff`,
          ...(patchArtifact
            ? { mediaType: patchArtifact.mediaType, digest: patchArtifact.digest, sizeBytes: patchArtifact.sizeBytes }
            : {}),
          summary: diff.summary,
          metadata: {
            baseCommit: diff.base_commit,
            headCommit: diff.head_commit,
            changedFiles: diff.changed_files,
            untrackedFiles: diff.untracked_files,
            statusText: diff.status_text
          }
        },
        ...snapshotArtifacts.map((artifact) => ({
          kind: "workspace-snapshot" as const,
          name: `workspace-snapshot-${artifact.kind}`,
          uri: artifact.uri,
          mediaType: artifact.mediaType,
          digest: artifact.digest,
          sizeBytes: artifact.sizeBytes,
          metadata: {
            snapshotId: snapshot.snapshot_id,
            snapshotKind: snapshot.kind,
            artifactId: artifact.id,
            artifactKind: artifact.kind,
            createdAt: snapshot.created_at
          }
        }))
      ]
    };
  }

  async cleanup(externalWorkspaceId: string, context: WorkspaceInvocationContext): Promise<void> {
    const result = await this.invoke<{
      workspace_id: string;
      path: string;
      removed: boolean;
      message: string;
    }>(context, ["cleanup", "--workspace", externalWorkspaceId]);
    if (!result.removed) {
      throw new IntegrationError("zigma-workspace did not confirm physical cleanup", {
        workspaceId: externalWorkspaceId,
        path: result.path,
        message: result.message
      });
    }
  }
}
