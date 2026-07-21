/**
 * SQLite persistence for Zigma Core (MVP).
 *
 * Storage strategy: relational keys + status columns for everything that
 * must be queried or joined; JSON columns for nested value objects
 * (actor, source, grants, evidence payloads). This keeps the schema stable
 * while models evolve during the draft phase, and matches the PRD's table
 * list in section 8.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type CoreDb = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  default_repository_id TEXT,
  default_flow_workflow_id TEXT,
  project_root TEXT,
  workspace_policy_id TEXT,
  skill_profile_id TEXT,
  code_platform_profile_id TEXT,
  execution_profile_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'local-cli',
  zigma_flow_command TEXT NOT NULL DEFAULT 'zigma-flow',
  working_directory_policy TEXT NOT NULL DEFAULT 'project-root',
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  timeout_seconds INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  created_by TEXT NOT NULL,
  current_flow_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS permission_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  flow_run_id TEXT,
  revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  source TEXT NOT NULL,
  project_scope TEXT NOT NULL,
  grants TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_psnap_task ON permission_snapshots(task_id);

CREATE TABLE IF NOT EXISTS flow_run_refs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT,
  workflow_id TEXT NOT NULL,
  zigma_flow_run_id TEXT,
  execution_profile_id TEXT NOT NULL,
  permission_snapshot_id TEXT NOT NULL,
  status TEXT NOT NULL,
  invocation_cwd TEXT NOT NULL,
  pid INTEGER,
  evidence_bundle_id TEXT,
  last_sync_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_frun_task ON flow_run_refs(task_id);

CREATE TABLE IF NOT EXISTS workspace_refs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  project_id TEXT,
  flow_run_id TEXT,
  zigma_workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  repository_url TEXT,
  base_ref TEXT,
  base_commit TEXT,
  branch TEXT,
  mode TEXT NOT NULL DEFAULT 'writable',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human_gate_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  flow_run_id TEXT NOT NULL REFERENCES flow_run_refs(id),
  zigma_flow_run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  instructions TEXT,
  allowed_approvers TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  entered_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(flow_run_id, job_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_gate_status ON human_gate_requests(status);

CREATE TABLE IF NOT EXISTS human_decisions (
  id TEXT PRIMARY KEY,
  gate_request_id TEXT NOT NULL REFERENCES human_gate_requests(id),
  task_id TEXT NOT NULL,
  flow_run_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  comment TEXT,
  actor TEXT NOT NULL,
  decided_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_bundles (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  flow_run_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_links (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  flow_run_id TEXT,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  actor TEXT,
  project_id TEXT,
  task_id TEXT,
  flow_run_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_events(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
`;

export function openDatabase(path: string): CoreDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
