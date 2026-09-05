import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_EXECUTION_POLICY,
  ExecutionPolicySchema,
  type ActorRef
} from "../contracts/schemas.js";
import type { ExecutionLeaseFence } from "../contracts/ports.js";
import type {
  AuditEvent,
  EvidenceBundle,
  EvidenceItem,
  ExecutionCommand,
  ExecutionLease,
  ExecutionProfile,
  FlowRun,
  HumanDecision,
  HumanGate,
  PermissionSnapshot,
  Project,
  OutboxDelivery,
  ProviderWorkspaceHandle,
  Task,
  WorkspaceRef
} from "../domain/models.js";
import { ConflictError, NotFoundError } from "../domain/errors.js";

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function fromJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return JSON.parse(value) as T;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export class SqliteStore {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL,
        flow_command TEXT NOT NULL,
        workspace_command TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        execution_policy_json TEXT NOT NULL,
        environment_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        repositories_json TEXT NOT NULL,
        default_repository_id TEXT NOT NULL,
        default_workflow_ref TEXT NOT NULL,
        execution_profile_id TEXT NOT NULL REFERENCES execution_profiles(id),
        workspace_policy_json TEXT NOT NULL,
        skill_profile_ref TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL,
        source_json TEXT NOT NULL,
        created_by_json TEXT NOT NULL,
        status TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        active_flow_run_id TEXT,
        revision INTEGER NOT NULL,
        failure_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS permission_snapshots (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        actor_json TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        source_json TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS flow_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        workflow_ref TEXT NOT NULL,
        execution_profile_id TEXT NOT NULL REFERENCES execution_profiles(id),
        permission_snapshot_id TEXT NOT NULL REFERENCES permission_snapshots(id),
        workspace_id TEXT,
        external_run_id TEXT,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        inputs_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        exit_code INTEGER,
        error_json TEXT,
        started_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS execution_commands (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT,
        input_hash TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        flow_run_id TEXT NOT NULL UNIQUE REFERENCES flow_runs(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        repository_id TEXT NOT NULL,
        repository_url TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        backend TEXT NOT NULL,
        workspace_policy_json TEXT NOT NULL,
        permission_snapshot_id TEXT NOT NULL REFERENCES permission_snapshots(id),
        callback_correlation_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        provider_response_json TEXT,
        last_error TEXT,
        dispatch_started_at TEXT,
        cancel_requested_at TEXT,
        cancel_acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(task_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS outbox_deliveries (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        aggregate_id TEXT NOT NULL REFERENCES execution_commands(id),
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claim_owner_id TEXT,
        claim_fencing_token INTEGER,
        claimed_at TEXT,
        claim_expires_at TEXT,
        delivered_at TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS execution_leases (
        id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL UNIQUE REFERENCES execution_commands(id),
        owner_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        status TEXT NOT NULL,
        project_id TEXT NOT NULL,
        repository_url TEXT NOT NULL,
        backend TEXT NOT NULL,
        writable INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        renewed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        flow_run_id TEXT NOT NULL REFERENCES flow_runs(id),
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        path TEXT NOT NULL,
        repository_url TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        branch TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        released_at TEXT,
        UNIQUE(provider, external_id)
      );

      CREATE TABLE IF NOT EXISTS flow_events (
        id TEXT PRIMARY KEY,
        flow_run_id TEXT NOT NULL REFERENCES flow_runs(id),
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        event_hash TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_workspace_handles (
        id TEXT PRIMARY KEY,
        flow_run_id TEXT NOT NULL REFERENCES flow_runs(id),
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        job_id TEXT,
        attempt INTEGER,
        status TEXT NOT NULL,
        path TEXT,
        repository_url TEXT,
        base_ref TEXT,
        base_commit TEXT,
        branch TEXT,
        metadata_json TEXT NOT NULL,
        last_event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, external_id)
      );

      CREATE TABLE IF NOT EXISTS human_gates (
        id TEXT PRIMARY KEY,
        external_gate_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        flow_run_id TEXT NOT NULL REFERENCES flow_runs(id),
        job_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        input_schema_json TEXT NOT NULL,
        allowed_approvers_json TEXT NOT NULL,
        status TEXT NOT NULL,
        due_at TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(flow_run_id, external_gate_id)
      );

      CREATE TABLE IF NOT EXISTS human_decisions (
        id TEXT PRIMARY KEY,
        gate_id TEXT NOT NULL REFERENCES human_gates(id),
        actor_json TEXT NOT NULL,
        decision TEXT NOT NULL,
        comment TEXT,
        input_json TEXT NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS human_decision_delivery_attempts (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES human_decisions(id),
        attempt INTEGER NOT NULL,
        delivery_status TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(decision_id, attempt)
      );

      CREATE TABLE IF NOT EXISTS evidence_bundles (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        flow_run_id TEXT NOT NULL REFERENCES flow_runs(id),
        status TEXT NOT NULL,
        summary TEXT,
        risks_json TEXT NOT NULL,
        conclusions_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finalized_at TEXT,
        UNIQUE(task_id, flow_run_id)
      );

      CREATE TABLE IF NOT EXISTS evidence_items (
        id TEXT PRIMARY KEY,
        bundle_id TEXT NOT NULL REFERENCES evidence_bundles(id),
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        uri TEXT NOT NULL,
        media_type TEXT,
        digest TEXT,
        size_bytes INTEGER,
        summary TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        correlation_id TEXT,
        causation_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_flow_runs_task ON flow_runs(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_execution_commands_status ON execution_commands(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_deliveries(status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_execution_leases_capacity ON execution_leases(status, project_id, repository_url, backend);
      CREATE INDEX IF NOT EXISTS idx_gates_status ON human_gates(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_provider_workspace_run ON provider_workspace_handles(flow_run_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_human_decisions_gate ON human_decisions(gate_id);
      CREATE INDEX IF NOT EXISTS idx_human_decision_delivery_attempts ON human_decision_delivery_attempts(decision_id, attempt);
      CREATE INDEX IF NOT EXISTS idx_evidence_items_bundle ON evidence_items(bundle_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_aggregate ON audit_events(aggregate_type, aggregate_id, created_at);
    `);
    const profileColumns = this.db.prepare("PRAGMA table_info(execution_profiles)").all() as Array<{ name: string }>;
    if (!profileColumns.some((column) => column.name === "execution_policy_json")) {
      const defaultPolicy = toJson(DEFAULT_EXECUTION_POLICY).replaceAll("'", "''");
      this.db.exec(`ALTER TABLE execution_profiles ADD COLUMN execution_policy_json TEXT NOT NULL DEFAULT '${defaultPolicy}'`);
    }
    const decisionColumns = this.db.prepare("PRAGMA table_info(human_decisions)").all() as Array<{ name: string }>;
    if (!decisionColumns.some((column) => column.name === "delivery_status")) {
      this.db.exec("ALTER TABLE human_decisions ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'delivered'");
    }
    if (!decisionColumns.some((column) => column.name === "last_error")) {
      this.db.exec("ALTER TABLE human_decisions ADD COLUMN last_error TEXT");
    }
    if (!decisionColumns.some((column) => column.name === "updated_at")) {
      this.db.exec("ALTER TABLE human_decisions ADD COLUMN updated_at TEXT");
      this.db.exec("UPDATE human_decisions SET updated_at = created_at WHERE updated_at IS NULL");
    }
    // Backfill the immutable decision's initial delivery projection as attempt 1.
    // This keeps databases created before delivery attempts were split compatible.
    this.db.exec(`INSERT OR IGNORE INTO human_decision_delivery_attempts (
      id, decision_id, attempt, delivery_status, last_error, created_at
    ) SELECT id || ':delivery:1', id, 1, delivery_status, last_error,
      COALESCE(updated_at, created_at) FROM human_decisions`);
    const eventColumns = this.db.prepare("PRAGMA table_info(flow_events)").all() as Array<{ name: string }>;
    if (!eventColumns.some((column) => column.name === "event_hash")) {
      this.db.exec("ALTER TABLE flow_events ADD COLUMN event_hash TEXT");
    }
    const commandColumns = this.db.prepare("PRAGMA table_info(execution_commands)").all() as Array<{ name: string }>;
    if (!commandColumns.some((column) => column.name === "provider_response_json")) {
      this.db.exec("ALTER TABLE execution_commands ADD COLUMN provider_response_json TEXT");
    }
    if (!commandColumns.some((column) => column.name === "dispatch_started_at")) {
      this.db.exec("ALTER TABLE execution_commands ADD COLUMN dispatch_started_at TEXT");
    }
    if (!commandColumns.some((column) => column.name === "cancel_requested_at")) {
      this.db.exec("ALTER TABLE execution_commands ADD COLUMN cancel_requested_at TEXT");
    }
    if (!commandColumns.some((column) => column.name === "cancel_acknowledged_at")) {
      this.db.exec("ALTER TABLE execution_commands ADD COLUMN cancel_acknowledged_at TEXT");
    }
    const outboxColumns = this.db.prepare("PRAGMA table_info(outbox_deliveries)").all() as Array<{ name: string }>;
    if (!outboxColumns.some((column) => column.name === "claim_owner_id")) {
      this.db.exec("ALTER TABLE outbox_deliveries ADD COLUMN claim_owner_id TEXT");
    }
    if (!outboxColumns.some((column) => column.name === "claim_fencing_token")) {
      this.db.exec("ALTER TABLE outbox_deliveries ADD COLUMN claim_fencing_token INTEGER");
    }
    if (!outboxColumns.some((column) => column.name === "claimed_at")) {
      this.db.exec("ALTER TABLE outbox_deliveries ADD COLUMN claimed_at TEXT");
    }
    if (!outboxColumns.some((column) => column.name === "claim_expires_at")) {
      this.db.exec("ALTER TABLE outbox_deliveries ADD COLUMN claim_expires_at TEXT");
    }
  }

  insertExecutionProfile(profile: ExecutionProfile): void {
    try {
      this.db.prepare(`INSERT INTO execution_profiles (
        id, name, mode, flow_command, workspace_command, timeout_ms,
        execution_policy_json, environment_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        profile.id,
        profile.name,
        profile.mode,
        profile.flowCommand,
        profile.workspaceCommand,
        profile.timeoutMs,
        toJson(profile.executionPolicy),
        toJson(profile.environment),
        toJson(profile.metadata),
        profile.createdAt,
        profile.updatedAt
      );
    } catch (error) {
      throw new ConflictError("Execution profile already exists", { name: profile.name, cause: String(error) });
    }
  }

  getExecutionProfile(id: string): ExecutionProfile {
    const row = this.db.prepare("SELECT * FROM execution_profiles WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError("execution profile", id);
    return {
      id: String(row["id"]),
      name: String(row["name"]),
      mode: row["mode"] as ExecutionProfile["mode"],
      flowCommand: String(row["flow_command"]),
      workspaceCommand: String(row["workspace_command"]),
      timeoutMs: Number(row["timeout_ms"]),
      executionPolicy: ExecutionPolicySchema.parse(
        fromJson(row["execution_policy_json"], DEFAULT_EXECUTION_POLICY)
      ),
      environment: fromJson(row["environment_json"], {}),
      metadata: fromJson(row["metadata_json"], {}),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"])
    };
  }

  insertProject(project: Project): void {
    try {
      this.db.prepare(`INSERT INTO projects (
        id, key, display_name, description, status, repositories_json,
        default_repository_id, default_workflow_ref, execution_profile_id,
        workspace_policy_json, skill_profile_ref, metadata_json,
        created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        project.id,
        project.key,
        project.displayName,
        project.description ?? null,
        project.status,
        toJson(project.repositories),
        project.defaultRepositoryId,
        project.defaultWorkflowRef,
        project.executionProfileId,
        toJson(project.workspacePolicy),
        project.skillProfileRef ?? null,
        toJson(project.metadata),
        project.createdAt,
        project.updatedAt,
        project.archivedAt ?? null
      );
    } catch (error) {
      throw new ConflictError("Project key already exists", { key: project.key, cause: String(error) });
    }
  }

  getProject(id: string): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ? OR key = ?").get(id, id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError("project", id);
    return {
      id: String(row["id"]),
      key: String(row["key"]),
      displayName: String(row["display_name"]),
      ...(optionalString(row["description"]) ? { description: optionalString(row["description"]) } : {}),
      status: row["status"] as Project["status"],
      repositories: fromJson(row["repositories_json"], []),
      defaultRepositoryId: String(row["default_repository_id"]),
      defaultWorkflowRef: String(row["default_workflow_ref"]),
      executionProfileId: String(row["execution_profile_id"]),
      workspacePolicy: fromJson(row["workspace_policy_json"], {
        provider: "none",
        mode: "read-only",
        branchTemplate: "zigma/{taskId}",
        cleanup: "manual",
        snapshotOnTerminal: false
      }),
      ...(optionalString(row["skill_profile_ref"]) ? { skillProfileRef: optionalString(row["skill_profile_ref"]) } : {}),
      metadata: fromJson(row["metadata_json"], {}),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
      ...(optionalString(row["archived_at"]) ? { archivedAt: optionalString(row["archived_at"]) } : {})
    };
  }

  insertTask(task: Task): void {
    this.db.prepare(`INSERT INTO tasks (
      id, project_id, title, description, priority, source_json, created_by_json,
      status, labels_json, metadata_json, active_flow_run_id, revision, failure_json,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      task.id,
      task.projectId,
      task.title,
      task.description,
      task.priority,
      toJson(task.source),
      toJson(task.createdBy),
      task.status,
      toJson(task.labels),
      toJson(task.metadata),
      task.activeFlowRunId ?? null,
      task.revision,
      task.failure ? toJson(task.failure) : null,
      task.createdAt,
      task.updatedAt,
      task.completedAt ?? null
    );
  }

  getTask(id: string): Task {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError("task", id);
    return {
      id: String(row["id"]),
      projectId: String(row["project_id"]),
      title: String(row["title"]),
      description: String(row["description"]),
      priority: row["priority"] as Task["priority"],
      source: fromJson(row["source_json"], { kind: "system", metadata: {} }),
      createdBy: fromJson(row["created_by_json"], { type: "system", id: "unknown" }),
      status: row["status"] as Task["status"],
      labels: fromJson(row["labels_json"], []),
      metadata: fromJson(row["metadata_json"], {}),
      ...(optionalString(row["active_flow_run_id"]) ? { activeFlowRunId: optionalString(row["active_flow_run_id"]) } : {}),
      revision: Number(row["revision"]),
      ...(optionalString(row["failure_json"]) ? { failure: fromJson(row["failure_json"], { code: "UNKNOWN", message: "Unknown failure", details: {} }) } : {}),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
      ...(optionalString(row["completed_at"]) ? { completedAt: optionalString(row["completed_at"]) } : {})
    };
  }

  updateTask(task: Task, expectedRevision: number): void {
    const result = this.db.prepare(`UPDATE tasks SET
      status = ?, active_flow_run_id = ?, revision = ?, failure_json = ?,
      metadata_json = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND revision = ?`).run(
        task.status,
        task.activeFlowRunId ?? null,
        task.revision,
        task.failure ? toJson(task.failure) : null,
        toJson(task.metadata),
        task.updatedAt,
        task.completedAt ?? null,
        task.id,
        expectedRevision
      );
    if (result.changes !== 1) {
      throw new ConflictError("Task revision conflict", { taskId: task.id, expectedRevision });
    }
  }

  insertPermissionSnapshot(snapshot: PermissionSnapshot): void {
    this.db.prepare(`INSERT INTO permission_snapshots (
      id, task_id, actor_json, capabilities_json, constraints_json, source_json,
      hash, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      snapshot.id,
      snapshot.taskId,
      toJson(snapshot.actor),
      toJson(snapshot.capabilities),
      toJson(snapshot.constraints),
      toJson(snapshot.source),
      snapshot.hash,
      snapshot.createdAt,
      snapshot.expiresAt ?? null
    );
  }

  getPermissionSnapshot(id: string): PermissionSnapshot {
    const row = this.db.prepare("SELECT * FROM permission_snapshots WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError("permission snapshot", id);
    return {
      id: String(row["id"]),
      taskId: String(row["task_id"]),
      actor: fromJson(row["actor_json"], { type: "system", id: "unknown" }),
      capabilities: fromJson(row["capabilities_json"], []),
      constraints: fromJson(row["constraints_json"], { repositoryIds: [], workflowRefs: [], toolNames: [], branchPatterns: [] }),
      source: fromJson(row["source_json"], { kind: "system", metadata: {} }),
      hash: String(row["hash"]),
      createdAt: String(row["created_at"]),
      ...(optionalString(row["expires_at"]) ? { expiresAt: optionalString(row["expires_at"]) } : {})
    };
  }

  insertFlowRun(run: FlowRun): void {
    this.db.prepare(`INSERT INTO flow_runs (
      id, task_id, workflow_ref, execution_profile_id, permission_snapshot_id,
      workspace_id, external_run_id, status, attempt, inputs_json, context_json,
      exit_code, error_json, started_at, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      run.id,
      run.taskId,
      run.workflowRef,
      run.executionProfileId,
      run.permissionSnapshotId,
      run.workspaceId ?? null,
      run.externalRunId ?? null,
      run.status,
      run.attempt,
      toJson(run.inputs),
      toJson(run.context),
      run.exitCode ?? null,
      run.error ? toJson(run.error) : null,
      run.startedAt ?? null,
      run.createdAt,
      run.updatedAt,
      run.completedAt ?? null
    );
  }

  insertExecutionCommand(command: ExecutionCommand): void {
    this.db.prepare(`INSERT INTO execution_commands (
      id, operation_id, idempotency_key, input_hash, task_id, flow_run_id,
      project_id, repository_id, repository_url, base_ref, backend,
      workspace_policy_json, permission_snapshot_id, callback_correlation_id,
      status, attempt, payload_json, provider_response_json, last_error,
      dispatch_started_at, cancel_requested_at, cancel_acknowledged_at,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      command.id, command.operationId, command.idempotencyKey ?? null, command.inputHash,
      command.taskId, command.flowRunId, command.projectId, command.repositoryId,
      command.repositoryUrl, command.baseRef, command.backend, toJson(command.workspacePolicy),
      command.permissionSnapshotId, command.callbackCorrelationId, command.status,
      command.attempt, toJson(command.payload), command.providerResponse ? toJson(command.providerResponse) : null,
      command.lastError ?? null, command.dispatchStartedAt ?? null, command.cancelRequestedAt ?? null,
      command.cancelAcknowledgedAt ?? null, command.createdAt,
      command.updatedAt, command.completedAt ?? null
    );
  }

  getExecutionCommand(id: string): ExecutionCommand {
    const row = this.db.prepare("SELECT * FROM execution_commands WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError("execution command", id);
    return this.mapExecutionCommand(row);
  }

  listDispatchableExecutionCommands(): ExecutionCommand[] {
    const rows = this.db.prepare("SELECT * FROM execution_commands WHERE status = 'pending' ORDER BY created_at ASC, id ASC").all() as Record<string, unknown>[];
    return rows.map((row) => this.mapExecutionCommand(row));
  }

  listDueOutboxDeliveries(now: string): OutboxDelivery[] {
    const rows = this.db.prepare(`SELECT * FROM outbox_deliveries
      WHERE status = 'pending' AND available_at <= ? ORDER BY available_at ASC, created_at ASC, id ASC`).all(now) as Record<string, unknown>[];
    return rows.map((row) => this.mapOutboxDelivery(row));
  }

  listInFlightExecutionCommands(): ExecutionCommand[] {
    const rows = this.db.prepare(`SELECT * FROM execution_commands
      WHERE status IN ('leased', 'dispatching', 'dispatched', 'cancel_requested', 'reconciling')
        OR id IN (SELECT command_id FROM execution_leases WHERE status != 'released')
      ORDER BY created_at ASC, id ASC`).all() as Record<string, unknown>[];
    return rows.map((row) => this.mapExecutionCommand(row));
  }

  getExecutionCommandForRun(flowRunId: string): ExecutionCommand | undefined {
    const row = this.db.prepare("SELECT * FROM execution_commands WHERE flow_run_id = ?").get(flowRunId) as Record<string, unknown> | undefined;
    return row ? this.mapExecutionCommand(row) : undefined;
  }

  findExecutionCommandByIdempotencyKey(taskId: string, key: string): ExecutionCommand | undefined {
    const row = this.db.prepare("SELECT * FROM execution_commands WHERE task_id = ? AND idempotency_key = ?").get(taskId, key) as Record<string, unknown> | undefined;
    return row ? this.mapExecutionCommand(row) : undefined;
  }

  updateExecutionCommand(command: ExecutionCommand): void {
    this.db.prepare(`UPDATE execution_commands SET status = ?, attempt = ?, payload_json = ?,
      provider_response_json = ?, last_error = ?, dispatch_started_at = ?,
      cancel_requested_at = ?, cancel_acknowledged_at = ?, updated_at = ?, completed_at = ? WHERE id = ?`).run(
      command.status, command.attempt, toJson(command.payload),
      command.providerResponse ? toJson(command.providerResponse) : null, command.lastError ?? null,
      command.dispatchStartedAt ?? null, command.cancelRequestedAt ?? null,
      command.cancelAcknowledgedAt ?? null, command.updatedAt, command.completedAt ?? null, command.id
    );
  }

  private mapExecutionCommand(row: Record<string, unknown>): ExecutionCommand {
    return {
      id: String(row["id"]), operationId: String(row["operation_id"]),
      ...(optionalString(row["idempotency_key"]) ? { idempotencyKey: optionalString(row["idempotency_key"]) } : {}),
      inputHash: String(row["input_hash"]), taskId: String(row["task_id"]),
      flowRunId: String(row["flow_run_id"]), projectId: String(row["project_id"]),
      repositoryId: String(row["repository_id"]), repositoryUrl: String(row["repository_url"]),
      baseRef: String(row["base_ref"]), backend: String(row["backend"]),
      workspacePolicy: fromJson(row["workspace_policy_json"], { provider: "none", mode: "read-only", branchTemplate: "zigma/{taskId}", cleanup: "manual", snapshotOnTerminal: false }),
      permissionSnapshotId: String(row["permission_snapshot_id"]),
      callbackCorrelationId: String(row["callback_correlation_id"]),
      status: row["status"] as ExecutionCommand["status"], attempt: Number(row["attempt"]),
      payload: fromJson(row["payload_json"], {}),
      ...(optionalString(row["provider_response_json"]) ? { providerResponse: fromJson(row["provider_response_json"], {}) } : {}),
      ...(optionalString(row["last_error"]) ? { lastError: optionalString(row["last_error"]) } : {}),
      ...(optionalString(row["dispatch_started_at"]) ? { dispatchStartedAt: optionalString(row["dispatch_started_at"]) } : {}),
      ...(optionalString(row["cancel_requested_at"]) ? { cancelRequestedAt: optionalString(row["cancel_requested_at"]) } : {}),
      ...(optionalString(row["cancel_acknowledged_at"]) ? { cancelAcknowledgedAt: optionalString(row["cancel_acknowledged_at"]) } : {}),
      createdAt: String(row["created_at"]), updatedAt: String(row["updated_at"]),
      ...(optionalString(row["completed_at"]) ? { completedAt: optionalString(row["completed_at"]) } : {})
    };
  }

  insertOutboxDelivery(delivery: OutboxDelivery): void {
    this.db.prepare(`INSERT INTO outbox_deliveries (
      id, topic, aggregate_id, payload_json, status, attempt, available_at,
      created_at, updated_at, claim_owner_id, claim_fencing_token, claimed_at,
      claim_expires_at, delivered_at, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      delivery.id, delivery.topic, delivery.aggregateId, toJson(delivery.payload), delivery.status,
      delivery.attempt, delivery.availableAt, delivery.createdAt, delivery.updatedAt,
      delivery.claimOwnerId ?? null, delivery.claimFencingToken ?? null,
      delivery.claimedAt ?? null, delivery.claimExpiresAt ?? null,
      delivery.deliveredAt ?? null, delivery.lastError ?? null
    );
  }

  listOutboxDeliveries(): OutboxDelivery[] {
    const rows = this.db.prepare("SELECT * FROM outbox_deliveries ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map((row) => this.mapOutboxDelivery(row));
  }

  getOutboxDeliveryForCommand(commandId: string): OutboxDelivery | undefined {
    const row = this.db.prepare("SELECT * FROM outbox_deliveries WHERE aggregate_id = ?").get(commandId) as Record<string, unknown> | undefined;
    return row ? this.mapOutboxDelivery(row) : undefined;
  }

  private mapOutboxDelivery(row: Record<string, unknown>): OutboxDelivery {
    return {
      id: String(row["id"]), topic: row["topic"] as OutboxDelivery["topic"],
      aggregateId: String(row["aggregate_id"]), payload: fromJson(row["payload_json"], {}),
      status: row["status"] as OutboxDelivery["status"], attempt: Number(row["attempt"]),
      availableAt: String(row["available_at"]), createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
      ...(optionalString(row["claim_owner_id"]) ? { claimOwnerId: optionalString(row["claim_owner_id"]) } : {}),
      ...(optionalNumber(row["claim_fencing_token"]) !== undefined ? { claimFencingToken: optionalNumber(row["claim_fencing_token"]) } : {}),
      ...(optionalString(row["claimed_at"]) ? { claimedAt: optionalString(row["claimed_at"]) } : {}),
      ...(optionalString(row["claim_expires_at"]) ? { claimExpiresAt: optionalString(row["claim_expires_at"]) } : {}),
      ...(optionalString(row["delivered_at"]) ? { deliveredAt: optionalString(row["delivered_at"]) } : {}),
      ...(optionalString(row["last_error"]) ? { lastError: optionalString(row["last_error"]) } : {})
    };
  }

  assertExecutionFence(fence: ExecutionLeaseFence, now: string): ExecutionLease {
    const row = this.db.prepare("SELECT * FROM execution_leases WHERE command_id = ?").get(fence.commandId) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError("execution lease", fence.commandId);
    const lease = this.mapExecutionLease(row);
    if (
      lease.id !== fence.leaseId
      || lease.ownerId !== fence.ownerId
      || lease.fencingToken !== fence.fencingToken
      || lease.status !== "active"
      || Date.parse(lease.expiresAt) <= Date.parse(now)
    ) {
      throw new ConflictError("Stale execution lease owner or fencing token", {
        commandId: fence.commandId,
        leaseId: fence.leaseId,
        ownerId: fence.ownerId,
        fencingToken: fence.fencingToken,
        currentLeaseId: lease.id,
        currentOwnerId: lease.ownerId,
        currentFencingToken: lease.fencingToken,
        status: lease.status,
        expiresAt: lease.expiresAt,
        now
      });
    }
    return lease;
  }

  fencedTransaction<T>(fence: ExecutionLeaseFence, now: string, fn: () => T): T {
    return this.transaction(() => {
      this.assertExecutionFence(fence, now);
      return fn();
    });
  }

  claimOutboxDelivery(
    deliveryId: string,
    fence: ExecutionLeaseFence,
    now: string,
    claimExpiresAt: string
  ): OutboxDelivery | undefined {
    return this.fencedTransaction(fence, now, () => {
      const row = this.db.prepare("SELECT * FROM outbox_deliveries WHERE id = ?").get(deliveryId) as Record<string, unknown> | undefined;
      if (!row) throw new NotFoundError("outbox delivery", deliveryId);
      const delivery = this.mapOutboxDelivery(row);
      if (delivery.aggregateId !== fence.commandId) {
        throw new ConflictError("Outbox delivery does not belong to the fenced command", {
          deliveryId,
          aggregateId: delivery.aggregateId,
          commandId: fence.commandId
        });
      }
      if (delivery.status !== "pending" || Date.parse(delivery.availableAt) > Date.parse(now)) return undefined;
      this.db.prepare(`UPDATE outbox_deliveries SET status='claimed', attempt=attempt+1,
        updated_at=?, claim_owner_id=?, claim_fencing_token=?, claimed_at=?, claim_expires_at=?,
        delivered_at=NULL, last_error=NULL WHERE id=? AND status='pending'`).run(
        now, fence.ownerId, fence.fencingToken, now, claimExpiresAt, deliveryId
      );
      return this.getOutboxDeliveryForCommand(fence.commandId);
    });
  }

  acknowledgeOutboxDelivery(deliveryId: string, fence: ExecutionLeaseFence, now: string): OutboxDelivery {
    return this.fencedTransaction(fence, now, () => {
      const delivery = this.requireClaimedOutbox(deliveryId, fence);
      const command = this.getExecutionCommand(fence.commandId);
      if (!command.providerResponse) {
        throw new ConflictError("Provider response must be durable before outbox acknowledgement", {
          deliveryId,
          commandId: command.id,
          commandStatus: command.status,
          providerResponsePersisted: command.providerResponse !== undefined
        });
      }
      this.db.prepare(`UPDATE outbox_deliveries SET status='delivered', updated_at=?, delivered_at=?,
        claim_expires_at=NULL, last_error=NULL WHERE id=?`).run(now, now, delivery.id);
      return this.getOutboxDeliveryForCommand(fence.commandId)!;
    });
  }

  releaseOutboxClaim(deliveryId: string, fence: ExecutionLeaseFence, now: string, lastError: string): OutboxDelivery {
    return this.fencedTransaction(fence, now, () => {
      const delivery = this.requireClaimedOutbox(deliveryId, fence);
      this.db.prepare(`UPDATE outbox_deliveries SET status='pending', available_at=?, updated_at=?,
        claim_owner_id=NULL, claim_fencing_token=NULL, claimed_at=NULL, claim_expires_at=NULL,
        delivered_at=NULL, last_error=? WHERE id=?`).run(now, now, lastError, delivery.id);
      return this.getOutboxDeliveryForCommand(fence.commandId)!;
    });
  }

  failOutboxDelivery(deliveryId: string, fence: ExecutionLeaseFence, now: string, lastError: string): OutboxDelivery {
    return this.fencedTransaction(fence, now, () => {
      const delivery = this.requireClaimedOutbox(deliveryId, fence);
      this.db.prepare(`UPDATE outbox_deliveries SET status='failed', updated_at=?, claim_expires_at=NULL,
        last_error=? WHERE id=?`).run(now, lastError, delivery.id);
      return this.getOutboxDeliveryForCommand(fence.commandId)!;
    });
  }

  cancelOutboxDeliveryForCommand(commandId: string, now: string): OutboxDelivery | undefined {
    const delivery = this.getOutboxDeliveryForCommand(commandId);
    if (!delivery || ["delivered", "failed", "cancelled"].includes(delivery.status)) return delivery;
    this.db.prepare(`UPDATE outbox_deliveries SET status='cancelled', updated_at=?,
      claim_expires_at=NULL, last_error=NULL WHERE aggregate_id=?`).run(now, commandId);
    return this.getOutboxDeliveryForCommand(commandId);
  }

  transferOutboxClaimToFence(commandId: string, fence: ExecutionLeaseFence, now: string, claimExpiresAt: string): void {
    this.assertExecutionFence(fence, now);
    this.db.prepare(`UPDATE outbox_deliveries SET claim_owner_id=?, claim_fencing_token=?,
      claimed_at=?, claim_expires_at=?, updated_at=? WHERE aggregate_id=? AND status='claimed'`).run(
      fence.ownerId, fence.fencingToken, now, claimExpiresAt, now, commandId
    );
  }

  resetExecutionForRedispatch(commandId: string, fence: ExecutionLeaseFence, now: string, reason: string): void {
    this.fencedTransaction(fence, now, () => {
      const command = this.getExecutionCommand(commandId);
      this.updateExecutionCommand({
        ...command,
        status: "pending",
        providerResponse: undefined,
        dispatchStartedAt: undefined,
        lastError: reason,
        updatedAt: now,
        completedAt: undefined
      });
      this.db.prepare(`UPDATE outbox_deliveries SET status='pending', available_at=?, updated_at=?,
        claim_owner_id=NULL, claim_fencing_token=NULL, claimed_at=NULL, claim_expires_at=NULL,
        delivered_at=NULL, last_error=? WHERE aggregate_id=?`).run(now, now, reason, commandId);
      const lease = this.getExecutionLease(commandId)!;
      this.updateExecutionLease({ ...lease, status: "released", renewedAt: now, releasedAt: now });
    });
  }

  private requireClaimedOutbox(deliveryId: string, fence: ExecutionLeaseFence): OutboxDelivery {
    const row = this.db.prepare("SELECT * FROM outbox_deliveries WHERE id = ?").get(deliveryId) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError("outbox delivery", deliveryId);
    const delivery = this.mapOutboxDelivery(row);
    if (
      delivery.status !== "claimed"
      || delivery.aggregateId !== fence.commandId
      || delivery.claimOwnerId !== fence.ownerId
      || delivery.claimFencingToken !== fence.fencingToken
    ) {
      throw new ConflictError("Outbox claim is not owned by the execution fence", {
        deliveryId,
        status: delivery.status,
        claimOwnerId: delivery.claimOwnerId,
        claimFencingToken: delivery.claimFencingToken,
        ownerId: fence.ownerId,
        fencingToken: fence.fencingToken
      });
    }
    return delivery;
  }

  admitExecutionCommand(input: {
    commandId: string;
    leaseId: string;
    ownerId: string;
    now: string;
    expiresAt: string;
    policy: import("../contracts/schemas.js").ExecutionPolicy;
  }): { outcome: "acquired"; lease: ExecutionLease } | { outcome: "queued"; limitedBy: string[] } | { outcome: "reconcile"; lease: ExecutionLease } {
    return this.transaction(() => {
      const command = this.getExecutionCommand(input.commandId);
      if (["completed", "failed", "cancelled"].includes(command.status)) {
        throw new ConflictError("Terminal execution command cannot acquire capacity", { commandId: command.id, status: command.status });
      }
      const existingRow = this.db.prepare("SELECT * FROM execution_leases WHERE command_id = ?").get(command.id) as Record<string, unknown> | undefined;
      if (existingRow) {
        const existing = this.mapExecutionLease(existingRow);
        if (existing.status === "active" && Date.parse(existing.expiresAt) <= Date.parse(input.now)) {
          const reconciling = { ...existing, status: "reconciling" as const, renewedAt: input.now };
          this.updateExecutionLease(reconciling);
          if (command.status !== "cancel_requested") {
            this.updateExecutionCommand({ ...command, status: "reconciling", updatedAt: input.now });
          }
          return { outcome: "reconcile", lease: reconciling };
        }
        if (existing.status === "active" && existing.ownerId === input.ownerId) {
          const renewed = { ...existing, renewedAt: input.now, expiresAt: input.expiresAt };
          this.updateExecutionLease(renewed);
          return { outcome: "acquired", lease: renewed };
        }
        if (existing.status !== "released") return { outcome: "queued", limitedBy: ["command"] };
      }

      const active = this.db.prepare("SELECT project_id, repository_url, backend, writable FROM execution_leases WHERE status IN ('active', 'reconciling')").all() as Array<Record<string, unknown>>;
      const limits = input.policy.capacity;
      const limitedBy: string[] = [];
      if (active.length >= limits.global) limitedBy.push("global");
      if (active.filter((row) => row["project_id"] === command.projectId).length >= limits.perProject) limitedBy.push("project");
      if (active.filter((row) => row["repository_url"] === command.repositoryUrl).length >= limits.perRepository) limitedBy.push("repository");
      if (active.filter((row) => row["backend"] === command.backend).length >= limits.perBackend) limitedBy.push("backend");
      const writable = command.workspacePolicy.mode === "writable";
      if (writable && active.filter((row) => row["repository_url"] === command.repositoryUrl && Number(row["writable"]) === 1).length >= input.policy.admission.writablePerRepository) limitedBy.push("writable-repository");
      if (limitedBy.length > 0) return { outcome: "queued", limitedBy };

      const fencingToken = existingRow ? Number(existingRow["fencing_token"]) + 1 : 1;
      const lease: ExecutionLease = {
        id: input.leaseId, commandId: command.id, ownerId: input.ownerId, fencingToken,
        status: "active", projectId: command.projectId, repositoryUrl: command.repositoryUrl,
        backend: command.backend, writable, acquiredAt: input.now, renewedAt: input.now,
        expiresAt: input.expiresAt
      };
      if (existingRow) {
        this.db.prepare(`UPDATE execution_leases SET id=?, owner_id=?, fencing_token=?, status='active',
          acquired_at=?, renewed_at=?, expires_at=?, released_at=NULL WHERE command_id=?`).run(
          lease.id, lease.ownerId, lease.fencingToken, lease.acquiredAt, lease.renewedAt, lease.expiresAt, command.id
        );
      } else {
        this.db.prepare(`INSERT INTO execution_leases (id, command_id, owner_id, fencing_token, status,
          project_id, repository_url, backend, writable, acquired_at, renewed_at, expires_at, released_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
          lease.id, lease.commandId, lease.ownerId, lease.fencingToken, lease.status, lease.projectId,
          lease.repositoryUrl, lease.backend, lease.writable ? 1 : 0, lease.acquiredAt, lease.renewedAt, lease.expiresAt
        );
      }
      this.updateExecutionCommand({ ...command, status: "leased", updatedAt: input.now });
      return { outcome: "acquired", lease };
    });
  }

  renewExecutionLease(
    fence: ExecutionLeaseFence,
    now: string,
    expiresAt: string
  ): ExecutionLease {
    return this.transaction(() => {
      const lease = this.assertExecutionFence(fence, now);
      const renewed = { ...lease, renewedAt: now, expiresAt };
      this.updateExecutionLease(renewed);
      this.db.prepare(`UPDATE outbox_deliveries SET claim_expires_at=?, updated_at=?
        WHERE aggregate_id=? AND status='claimed' AND claim_owner_id=? AND claim_fencing_token=?`).run(
        expiresAt, now, fence.commandId, fence.ownerId, fence.fencingToken
      );
      return renewed;
    });
  }

  takeoverExecutionLeaseForReconciliation(input: {
    commandId: string;
    leaseId: string;
    ownerId: string;
    now: string;
    expiresAt: string;
  }): ExecutionLease | undefined {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM execution_leases WHERE command_id = ?").get(input.commandId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const current = this.mapExecutionLease(row);
      if (current.status === "released") return undefined;
      if (current.status === "active" && Date.parse(current.expiresAt) > Date.parse(input.now)) return undefined;

      const lease: ExecutionLease = {
        ...current,
        id: input.leaseId,
        ownerId: input.ownerId,
        fencingToken: current.fencingToken + 1,
        status: "active",
        acquiredAt: input.now,
        renewedAt: input.now,
        expiresAt: input.expiresAt,
        releasedAt: undefined
      };
      this.db.prepare(`UPDATE execution_leases SET id=?, owner_id=?, fencing_token=?, status='active',
        acquired_at=?, renewed_at=?, expires_at=?, released_at=NULL WHERE command_id=?`).run(
        lease.id, lease.ownerId, lease.fencingToken, lease.acquiredAt,
        lease.renewedAt, lease.expiresAt, input.commandId
      );
      const command = this.getExecutionCommand(input.commandId);
      if (!["completed", "failed", "cancelled", "cancel_requested"].includes(command.status)) {
        this.updateExecutionCommand({ ...command, status: "reconciling", updatedAt: input.now });
      }
      this.db.prepare(`UPDATE outbox_deliveries SET claim_owner_id=?, claim_fencing_token=?,
        claimed_at=?, claim_expires_at=?, updated_at=? WHERE aggregate_id=? AND status='claimed'`).run(
        lease.ownerId, lease.fencingToken, input.now, input.expiresAt, input.now, input.commandId
      );
      return lease;
    });
  }

  pauseExecutionLeaseForReconciliation(fence: ExecutionLeaseFence, now: string, reason: string): ExecutionLease {
    return this.fencedTransaction(fence, now, () => {
      const lease = this.getExecutionLease(fence.commandId)!;
      const paused = { ...lease, status: "reconciling" as const, renewedAt: now };
      this.updateExecutionLease(paused);
      const command = this.getExecutionCommand(fence.commandId);
      if (!["completed", "failed", "cancelled", "cancel_requested"].includes(command.status)) {
        this.updateExecutionCommand({ ...command, status: "reconciling", lastError: reason, updatedAt: now });
      } else if (command.status === "cancel_requested") {
        this.updateExecutionCommand({ ...command, lastError: reason, updatedAt: now });
      }
      return paused;
    });
  }

  releaseExecutionLease(fence: ExecutionLeaseFence, now: string): ExecutionLease {
    return this.fencedTransaction(fence, now, () => {
      const lease = this.getExecutionLease(fence.commandId)!;
      const released = { ...lease, status: "released" as const, renewedAt: now, releasedAt: now };
      this.updateExecutionLease(released);
      return released;
    });
  }

  getExecutionLease(commandId: string): ExecutionLease | undefined {
    const row = this.db.prepare("SELECT * FROM execution_leases WHERE command_id = ?").get(commandId) as Record<string, unknown> | undefined;
    return row ? this.mapExecutionLease(row) : undefined;
  }

  listExecutionLeases(): ExecutionLease[] {
    const rows = this.db.prepare("SELECT * FROM execution_leases ORDER BY acquired_at ASC, command_id ASC").all() as Record<string, unknown>[];
    return rows.map((row) => this.mapExecutionLease(row));
  }

  private updateExecutionLease(lease: ExecutionLease): void {
    this.db.prepare("UPDATE execution_leases SET owner_id=?, fencing_token=?, status=?, renewed_at=?, expires_at=?, released_at=? WHERE command_id=?").run(
      lease.ownerId, lease.fencingToken, lease.status, lease.renewedAt, lease.expiresAt, lease.releasedAt ?? null, lease.commandId
    );
  }

  private mapExecutionLease(row: Record<string, unknown>): ExecutionLease {
    return {
      id: String(row["id"]), commandId: String(row["command_id"]), ownerId: String(row["owner_id"]),
      fencingToken: Number(row["fencing_token"]), status: row["status"] as ExecutionLease["status"],
      projectId: String(row["project_id"]), repositoryUrl: String(row["repository_url"]),
      backend: String(row["backend"]), writable: Number(row["writable"]) === 1,
      acquiredAt: String(row["acquired_at"]), renewedAt: String(row["renewed_at"]), expiresAt: String(row["expires_at"]),
      ...(optionalString(row["released_at"]) ? { releasedAt: optionalString(row["released_at"]) } : {})
    };
  }

  getFlowRun(id: string): FlowRun {
    const row = this.db.prepare("SELECT * FROM flow_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError("flow run", id);
    return this.mapFlowRun(row);
  }

  listFlowRunsForTask(taskId: string): FlowRun[] {
    const rows = this.db.prepare("SELECT * FROM flow_runs WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as Record<string, unknown>[];
    return rows.map((row) => this.mapFlowRun(row));
  }

  private mapFlowRun(row: Record<string, unknown>): FlowRun {
    return {
      id: String(row["id"]),
      taskId: String(row["task_id"]),
      workflowRef: String(row["workflow_ref"]),
      executionProfileId: String(row["execution_profile_id"]),
      permissionSnapshotId: String(row["permission_snapshot_id"]),
      ...(optionalString(row["workspace_id"]) ? { workspaceId: optionalString(row["workspace_id"]) } : {}),
      ...(optionalString(row["external_run_id"]) ? { externalRunId: optionalString(row["external_run_id"]) } : {}),
      status: row["status"] as FlowRun["status"],
      attempt: Number(row["attempt"]),
      inputs: fromJson(row["inputs_json"], {}),
      context: fromJson(row["context_json"], {}),
      ...(optionalNumber(row["exit_code"]) !== undefined ? { exitCode: optionalNumber(row["exit_code"]) } : {}),
      ...(optionalString(row["error_json"]) ? { error: fromJson(row["error_json"], { code: "UNKNOWN", message: "Unknown error", details: {} }) } : {}),
      ...(optionalString(row["started_at"]) ? { startedAt: optionalString(row["started_at"]) } : {}),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
      ...(optionalString(row["completed_at"]) ? { completedAt: optionalString(row["completed_at"]) } : {})
    };
  }

  updateFlowRun(run: FlowRun): void {
    this.db.prepare(`UPDATE flow_runs SET
      workspace_id = ?, external_run_id = ?, status = ?, context_json = ?,
      exit_code = ?, error_json = ?, started_at = ?, updated_at = ?, completed_at = ?
      WHERE id = ?`).run(
        run.workspaceId ?? null,
        run.externalRunId ?? null,
        run.status,
        toJson(run.context),
        run.exitCode ?? null,
        run.error ? toJson(run.error) : null,
        run.startedAt ?? null,
        run.updatedAt,
        run.completedAt ?? null,
        run.id
      );
  }

  insertWorkspace(workspace: WorkspaceRef): void {
    this.db.prepare(`INSERT INTO workspaces (
      id, task_id, flow_run_id, provider, external_id, path, repository_url,
      base_ref, base_commit, branch, mode, status, metadata_json,
      created_at, updated_at, released_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      workspace.id,
      workspace.taskId,
      workspace.flowRunId,
      workspace.provider,
      workspace.externalId,
      workspace.path,
      workspace.repositoryUrl,
      workspace.baseRef,
      workspace.baseCommit,
      workspace.branch,
      workspace.mode,
      workspace.status,
      toJson(workspace.metadata),
      workspace.createdAt,
      workspace.updatedAt,
      workspace.releasedAt ?? null
    );
  }

  getWorkspace(id: string): WorkspaceRef {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError("workspace", id);
    return {
      id: String(row["id"]),
      taskId: String(row["task_id"]),
      flowRunId: String(row["flow_run_id"]),
      provider: String(row["provider"]),
      externalId: String(row["external_id"]),
      path: String(row["path"]),
      repositoryUrl: String(row["repository_url"]),
      baseRef: String(row["base_ref"]),
      baseCommit: String(row["base_commit"]),
      branch: String(row["branch"]),
      mode: row["mode"] as WorkspaceRef["mode"],
      status: row["status"] as WorkspaceRef["status"],
      metadata: fromJson(row["metadata_json"], {}),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
      ...(optionalString(row["released_at"]) ? { releasedAt: optionalString(row["released_at"]) } : {})
    };
  }

  updateWorkspace(workspace: WorkspaceRef): void {
    this.db.prepare(`UPDATE workspaces SET status = ?, metadata_json = ?, updated_at = ?, released_at = ? WHERE id = ?`).run(
      workspace.status,
      toJson(workspace.metadata),
      workspace.updatedAt,
      workspace.releasedAt ?? null,
      workspace.id
    );
  }

  insertFlowEvent(event: { id: string; flowRunId: string; type: string; occurredAt: string; payload: Record<string, unknown>; inputHash: string; createdAt: string }): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO flow_events (id, flow_run_id, type, occurred_at, payload_json, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      event.id,
      event.flowRunId,
      event.type,
      event.occurredAt,
      toJson(event.payload),
      event.inputHash,
      event.createdAt
    );
    if (result.changes === 0) {
      const existing = this.db.prepare("SELECT flow_run_id, event_hash FROM flow_events WHERE id = ?").get(event.id) as Record<string, unknown>;
      if (existing["flow_run_id"] !== event.flowRunId || (existing["event_hash"] && existing["event_hash"] !== event.inputHash)) {
        throw new ConflictError("Flow event id was reused with different content", { eventId: event.id, flowRunId: event.flowRunId });
      }
    }
    return result.changes === 1;
  }

  upsertProviderWorkspaceHandle(handle: ProviderWorkspaceHandle): ProviderWorkspaceHandle {
    const existing = this.db.prepare("SELECT * FROM provider_workspace_handles WHERE provider = ? AND external_id = ?").get(handle.provider, handle.externalId) as Record<string, unknown> | undefined;
    if (existing && existing["flow_run_id"] !== handle.flowRunId) {
      throw new ConflictError("Provider workspace handle belongs to a different Flow run", { provider: handle.provider, externalId: handle.externalId });
    }
    this.db.prepare(`INSERT INTO provider_workspace_handles (
      id, flow_run_id, provider, external_id, scope, job_id, attempt, status, path,
      repository_url, base_ref, base_commit, branch, metadata_json, last_event_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, external_id) DO UPDATE SET status=excluded.status, path=excluded.path,
      repository_url=excluded.repository_url, base_ref=excluded.base_ref, base_commit=excluded.base_commit,
      branch=excluded.branch, metadata_json=excluded.metadata_json, last_event_id=excluded.last_event_id,
      updated_at=excluded.updated_at`).run(
      handle.id, handle.flowRunId, handle.provider, handle.externalId, handle.scope,
      handle.jobId ?? null, handle.attempt ?? null, handle.status, handle.path ?? null,
      handle.repositoryUrl ?? null, handle.baseRef ?? null, handle.baseCommit ?? null,
      handle.branch ?? null, toJson(handle.metadata), handle.lastEventId, handle.createdAt, handle.updatedAt
    );
    return this.listProviderWorkspaceHandles(handle.flowRunId).find((item) => item.provider === handle.provider && item.externalId === handle.externalId)!;
  }

  listProviderWorkspaceHandles(flowRunId: string): ProviderWorkspaceHandle[] {
    const rows = this.db.prepare("SELECT * FROM provider_workspace_handles WHERE flow_run_id = ? ORDER BY created_at ASC").all(flowRunId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row["id"]), flowRunId: String(row["flow_run_id"]), provider: String(row["provider"]), externalId: String(row["external_id"]),
      scope: row["scope"] as ProviderWorkspaceHandle["scope"],
      ...(optionalString(row["job_id"]) ? { jobId: optionalString(row["job_id"]) } : {}),
      ...(optionalNumber(row["attempt"]) !== undefined ? { attempt: optionalNumber(row["attempt"]) } : {}),
      status: String(row["status"]), ...(optionalString(row["path"]) ? { path: optionalString(row["path"]) } : {}),
      ...(optionalString(row["repository_url"]) ? { repositoryUrl: optionalString(row["repository_url"]) } : {}),
      ...(optionalString(row["base_ref"]) ? { baseRef: optionalString(row["base_ref"]) } : {}),
      ...(optionalString(row["base_commit"]) ? { baseCommit: optionalString(row["base_commit"]) } : {}),
      ...(optionalString(row["branch"]) ? { branch: optionalString(row["branch"]) } : {}),
      metadata: fromJson(row["metadata_json"], {}), lastEventId: String(row["last_event_id"]),
      createdAt: String(row["created_at"]), updatedAt: String(row["updated_at"])
    }));
  }

  insertHumanGate(gate: HumanGate): void {
    try {
      this.db.prepare(`INSERT INTO human_gates (
        id, external_gate_id, task_id, flow_run_id, job_id, step_id, prompt,
        input_schema_json, allowed_approvers_json, status, due_at, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        gate.id,
        gate.externalGateId,
        gate.taskId,
        gate.flowRunId,
        gate.jobId,
        gate.stepId,
        gate.prompt,
        toJson(gate.inputSchema),
        toJson(gate.allowedApprovers),
        gate.status,
        gate.dueAt ?? null,
        toJson(gate.metadata),
        gate.createdAt,
        gate.updatedAt
      );
    } catch (error) {
      throw new ConflictError("Human gate already exists", { externalGateId: gate.externalGateId, cause: String(error) });
    }
  }

  getHumanGate(id: string): HumanGate {
    const row = this.db.prepare("SELECT * FROM human_gates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError("human gate", id);
    return {
      id: String(row["id"]),
      externalGateId: String(row["external_gate_id"]),
      taskId: String(row["task_id"]),
      flowRunId: String(row["flow_run_id"]),
      jobId: String(row["job_id"]),
      stepId: String(row["step_id"]),
      prompt: String(row["prompt"]),
      inputSchema: fromJson(row["input_schema_json"], {}),
      allowedApprovers: fromJson(row["allowed_approvers_json"], []),
      status: row["status"] as HumanGate["status"],
      ...(optionalString(row["due_at"]) ? { dueAt: optionalString(row["due_at"]) } : {}),
      metadata: fromJson(row["metadata_json"], {}),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"])
    };
  }

  updateHumanGate(gate: HumanGate): void {
    this.db.prepare("UPDATE human_gates SET status = ?, updated_at = ? WHERE id = ?").run(gate.status, gate.updatedAt, gate.id);
  }

  insertHumanDecision(decision: HumanDecision): void {
    this.db.prepare(`INSERT INTO human_decisions (
      id, gate_id, actor_json, decision, comment, input_json, delivery_status,
      last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      decision.id,
      decision.gateId,
      toJson(decision.actor),
      decision.decision,
      decision.comment ?? null,
      toJson(decision.input),
      decision.deliveryStatus,
      decision.lastError ?? null,
      decision.createdAt,
      decision.updatedAt
    );
    this.insertHumanDecisionDeliveryAttempt(decision, decision.deliveryAttempt ?? 1);
  }

  getHumanDecision(gateId: string): HumanDecision | undefined {
    const row = this.db.prepare(`SELECT d.*,
      a.attempt AS delivery_attempt,
      a.delivery_status AS attempt_delivery_status,
      a.last_error AS attempt_last_error,
      a.created_at AS attempt_created_at
      FROM human_decisions d
      LEFT JOIN human_decision_delivery_attempts a
        ON a.decision_id = d.id
       AND a.attempt = (SELECT MAX(a2.attempt) FROM human_decision_delivery_attempts a2 WHERE a2.decision_id = d.id)
      WHERE d.gate_id = ?`).get(gateId) as Record<string, unknown> | undefined;
    return row ? this.humanDecisionFromRow(row) : undefined;
  }

  updateHumanDecisionDelivery(decision: HumanDecision): void {
    const latest = this.db.prepare(
      "SELECT MAX(attempt) AS attempt FROM human_decision_delivery_attempts WHERE decision_id = ?"
    ).get(decision.id) as { attempt?: number | null } | undefined;
    this.insertHumanDecisionDeliveryAttempt(decision, Number(latest?.attempt ?? decision.deliveryAttempt ?? 0) + 1);
  }

  private insertHumanDecisionDeliveryAttempt(decision: HumanDecision, attempt: number): void {
    this.db.prepare(`INSERT INTO human_decision_delivery_attempts (
      id, decision_id, attempt, delivery_status, last_error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`).run(
      `${decision.id}:delivery:${attempt}`,
      decision.id,
      attempt,
      decision.deliveryStatus,
      decision.lastError ?? null,
      decision.updatedAt
    );
  }

  private humanDecisionFromRow(row: Record<string, unknown>): HumanDecision {
    return {
      id: String(row["id"]),
      gateId: String(row["gate_id"]),
      actor: fromJson(row["actor_json"], { type: "system", id: "unknown" }),
      decision: row["decision"] as HumanDecision["decision"],
      ...(optionalString(row["comment"]) ? { comment: optionalString(row["comment"]) } : {}),
      input: fromJson(row["input_json"], {}),
      deliveryStatus: (optionalString(row["attempt_delivery_status"]) ?? String(row["delivery_status"])) as HumanDecision["deliveryStatus"],
      ...((optionalString(row["attempt_last_error"]) ?? optionalString(row["last_error"])) ? {
        lastError: optionalString(row["attempt_last_error"]) ?? optionalString(row["last_error"])
      } : {}),
      createdAt: String(row["created_at"]),
      updatedAt: optionalString(row["attempt_created_at"]) ?? optionalString(row["updated_at"]) ?? String(row["created_at"]),
      ...(optionalNumber(row["delivery_attempt"]) !== undefined ? { deliveryAttempt: optionalNumber(row["delivery_attempt"]) } : {})
    };
  }

  listHumanDecisions(gateId: string): HumanDecision[] {
    const rows = this.db.prepare(`SELECT d.*,
      a.attempt AS delivery_attempt,
      a.delivery_status AS attempt_delivery_status,
      a.last_error AS attempt_last_error,
      a.created_at AS attempt_created_at
      FROM human_decisions d
      LEFT JOIN human_decision_delivery_attempts a
        ON a.decision_id = d.id
       AND a.attempt = (SELECT MAX(a2.attempt) FROM human_decision_delivery_attempts a2 WHERE a2.decision_id = d.id)
      WHERE d.gate_id = ? ORDER BY d.created_at ASC`).all(gateId) as Record<string, unknown>[];
    return rows.map((row) => this.humanDecisionFromRow(row));
  }

  insertEvidenceBundle(bundle: EvidenceBundle): void {
    this.db.prepare(`INSERT INTO evidence_bundles (
      id, task_id, flow_run_id, status, summary, risks_json, conclusions_json,
      created_at, updated_at, finalized_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      bundle.id,
      bundle.taskId,
      bundle.flowRunId,
      bundle.status,
      bundle.summary ?? null,
      toJson(bundle.risks),
      toJson(bundle.conclusions),
      bundle.createdAt,
      bundle.updatedAt,
      bundle.finalizedAt ?? null
    );
  }

  getEvidenceBundle(id: string): EvidenceBundle {
    const row = this.db.prepare("SELECT * FROM evidence_bundles WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError("evidence bundle", id);
    return this.mapEvidenceBundle(row);
  }

  getEvidenceBundleByRun(flowRunId: string): EvidenceBundle {
    const row = this.db.prepare("SELECT * FROM evidence_bundles WHERE flow_run_id = ?").get(flowRunId) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError("evidence bundle for flow run", flowRunId);
    return this.mapEvidenceBundle(row);
  }

  private mapEvidenceBundle(row: Record<string, unknown>): EvidenceBundle {
    return {
      id: String(row["id"]),
      taskId: String(row["task_id"]),
      flowRunId: String(row["flow_run_id"]),
      status: row["status"] as EvidenceBundle["status"],
      ...(optionalString(row["summary"]) ? { summary: optionalString(row["summary"]) } : {}),
      risks: fromJson(row["risks_json"], []),
      conclusions: fromJson(row["conclusions_json"], []),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
      ...(optionalString(row["finalized_at"]) ? { finalizedAt: optionalString(row["finalized_at"]) } : {})
    };
  }

  updateEvidenceBundle(bundle: EvidenceBundle): void {
    this.db.prepare(`UPDATE evidence_bundles SET status = ?, summary = ?, risks_json = ?, conclusions_json = ?, updated_at = ?, finalized_at = ? WHERE id = ?`).run(
      bundle.status,
      bundle.summary ?? null,
      toJson(bundle.risks),
      toJson(bundle.conclusions),
      bundle.updatedAt,
      bundle.finalizedAt ?? null,
      bundle.id
    );
  }

  insertEvidenceItem(item: EvidenceItem): void {
    this.db.prepare(`INSERT INTO evidence_items (
      id, bundle_id, kind, name, uri, media_type, digest, size_bytes, summary,
      metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      item.id,
      item.bundleId,
      item.kind,
      item.name,
      item.uri,
      item.mediaType ?? null,
      item.digest ?? null,
      item.sizeBytes ?? null,
      item.summary ?? null,
      toJson(item.metadata),
      item.createdAt
    );
  }

  listEvidenceItems(bundleId: string): EvidenceItem[] {
    const rows = this.db.prepare("SELECT * FROM evidence_items WHERE bundle_id = ? ORDER BY created_at ASC").all(bundleId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row["id"]),
      bundleId: String(row["bundle_id"]),
      kind: row["kind"] as EvidenceItem["kind"],
      name: String(row["name"]),
      uri: String(row["uri"]),
      ...(optionalString(row["media_type"]) ? { mediaType: optionalString(row["media_type"]) } : {}),
      ...(optionalString(row["digest"]) ? { digest: optionalString(row["digest"]) } : {}),
      ...(optionalNumber(row["size_bytes"]) !== undefined ? { sizeBytes: optionalNumber(row["size_bytes"]) } : {}),
      ...(optionalString(row["summary"]) ? { summary: optionalString(row["summary"]) } : {}),
      metadata: fromJson(row["metadata_json"], {}),
      createdAt: String(row["created_at"])
    }));
  }

  insertAuditEvent(event: AuditEvent): void {
    this.db.prepare(`INSERT INTO audit_events (
      id, aggregate_type, aggregate_id, action, actor_json, payload_json,
      correlation_id, causation_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.id,
      event.aggregateType,
      event.aggregateId,
      event.action,
      toJson(event.actor),
      toJson(event.payload),
      event.correlationId ?? null,
      event.causationId ?? null,
      event.createdAt
    );
  }

  listAuditEvents(aggregateType: AuditEvent["aggregateType"], aggregateId: string): AuditEvent[] {
    const rows = this.db.prepare("SELECT * FROM audit_events WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY created_at ASC").all(aggregateType, aggregateId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row["id"]),
      aggregateType: row["aggregate_type"] as AuditEvent["aggregateType"],
      aggregateId: String(row["aggregate_id"]),
      action: String(row["action"]),
      actor: fromJson<ActorRef>(row["actor_json"], { type: "system", id: "unknown" }),
      payload: fromJson(row["payload_json"], {}),
      ...(optionalString(row["correlation_id"]) ? { correlationId: optionalString(row["correlation_id"]) } : {}),
      ...(optionalString(row["causation_id"]) ? { causationId: optionalString(row["causation_id"]) } : {}),
      createdAt: String(row["created_at"])
    }));
  }
}
