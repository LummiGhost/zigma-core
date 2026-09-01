import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CreateExecutionProfileInputSchema,
  DEFAULT_EXECUTION_POLICY
} from "../src/contracts/schemas.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("execution profile policy", () => {
  it("normalizes legacy and partial profile payloads", () => {
    expect(CreateExecutionProfileInputSchema.parse({ name: "legacy" }).executionPolicy)
      .toEqual(DEFAULT_EXECUTION_POLICY);

    expect(CreateExecutionProfileInputSchema.parse({
      name: "limited",
      executionPolicy: {
        capacity: { global: 2, perRepository: 1 },
        admission: { writablePerRepository: 1 }
      }
    }).executionPolicy).toEqual({
      contractVersion: 1,
      capacity: {
        global: 2,
        perProject: 4,
        perRepository: 1,
        perBackend: 4
      },
      admission: {
        writablePerRepository: 1,
        queueDiscipline: "fifo",
        requireDistinctWorkspace: true
      }
    });
  });

  it("rejects invalid and contradictory policies", () => {
    expect(() => CreateExecutionProfileInputSchema.parse({
      name: "zero",
      executionPolicy: { capacity: { global: 0 } }
    })).toThrow();

    expect(() => CreateExecutionProfileInputSchema.parse({
      name: "shared-workspace",
      executionPolicy: { admission: { requireDistinctWorkspace: false } }
    })).toThrow();

    expect(() => CreateExecutionProfileInputSchema.parse({
      name: "contradictory",
      executionPolicy: {
        capacity: { perRepository: 1 },
        admission: { writablePerRepository: 2 }
      }
    })).toThrow(/writablePerRepository/);
  });

  it("round-trips a custom policy through SQLite", () => {
    const store = new SqliteStore(":memory:");
    const policy = CreateExecutionProfileInputSchema.parse({
      name: "custom",
      executionPolicy: {
        capacity: {
          global: 8,
          perProject: 6,
          perRepository: 3,
          perBackend: 2
        },
        admission: { writablePerRepository: 2 }
      }
    }).executionPolicy;

    store.insertExecutionProfile({
      id: "profile_custom",
      name: "custom",
      mode: "local-cli",
      flowCommand: "zigma-flow",
      workspaceCommand: "zigma-workspace",
      timeoutMs: 60_000,
      executionPolicy: policy,
      environment: {},
      metadata: {},
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z"
    });

    expect(store.getExecutionProfile("profile_custom").executionPolicy).toEqual(policy);
    store.close();
  });

  it("migrates legacy databases with finite policy defaults", () => {
    const directory = mkdtempSync(join(tmpdir(), "zigma-core-policy-"));
    tempDirectories.push(directory);
    const filename = join(directory, "core.db");
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      CREATE TABLE execution_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL,
        flow_command TEXT NOT NULL,
        workspace_command TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        environment_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO execution_profiles VALUES (
        'profile_legacy', 'legacy', 'local-cli', 'zigma-flow',
        'zigma-workspace', 60000, '{}', '{}',
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const migrated = new SqliteStore(filename);
    expect(migrated.getExecutionProfile("profile_legacy").executionPolicy)
      .toEqual(DEFAULT_EXECUTION_POLICY);
    const columns = migrated.db.prepare("PRAGMA table_info(execution_profiles)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("execution_policy_json");
    migrated.close();
  });
});
