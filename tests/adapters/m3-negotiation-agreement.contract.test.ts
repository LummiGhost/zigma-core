/**
 * M3.5 negotiation agreement — env-gated on ZIGMA_WORKSPACE_CLI_PATH.
 *
 * Feeds the REAL `contract-info --json` output (and doctored variants of it)
 * through BOTH validators that consume it:
 *
 *   1. Core's M0 adapter validator (`validateContractInfo` in
 *      src/adapters/zigma-workspace-cli.ts) — the role Core plays today.
 *   2. zigma-workspace's own managed-role validator
 *      (`validateProviderContract` from the built dist, imported via file URL
 *      from dist/core/negotiation.js — the public negotiation module; the
 *      api barrel is avoided because it drags in better-sqlite3).
 *
 * Agreement contract: every variant that violates a SHARED rule (provider
 * identity, contract version, package version, capability list shape, shared
 * capabilities) must be accepted/rejected identically by both. The three
 * role-specific gates (managed-only capabilities, managed_supported, Core-only
 * capabilities) are asserted as documented asymmetries — each validator
 * remains correct for its own role, and the asymmetry is intentional, not a
 * fork.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
  REQUIRED_WORKSPACE_CAPABILITIES,
  validateContractInfo,
} from "../../src/adapters/zigma-workspace-cli.js";

const workspaceCliPath = process.env["ZIGMA_WORKSPACE_CLI_PATH"];
const describeRealProvider = workspaceCliPath !== undefined && workspaceCliPath !== ""
  ? describe
  : describe.skip;

type CoreContractInfo = Parameters<typeof validateContractInfo>[0];

interface ManagedValidator {
  validateProviderContract: (
    info: Record<string, unknown>,
    required: readonly string[],
  ) => { supported: boolean };
  MANAGED_REQUIRED_CAPABILITIES: readonly string[];
}

interface Outcome {
  accepted: boolean;
  message?: string;
}

function fetchRealContractInfo(): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [workspaceCliPath!, "contract-info", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const envelope = JSON.parse(stdout) as { contract_version: number; ok: boolean; data: Record<string, unknown> };
  expect(envelope.contract_version).toBe(1);
  expect(envelope.ok).toBe(true);
  return envelope.data;
}

function mutate(
  base: Record<string, unknown>,
  change: (data: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  return change(structuredClone(base));
}

function coreOutcome(data: Record<string, unknown>): Outcome {
  try {
    validateContractInfo(data as unknown as CoreContractInfo);
    return { accepted: true };
  } catch (error) {
    return { accepted: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function managedOutcome(validator: ManagedValidator, data: Record<string, unknown>): Outcome {
  try {
    validator.validateProviderContract(data, validator.MANAGED_REQUIRED_CAPABILITIES);
    return { accepted: true };
  } catch (error) {
    return { accepted: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function expectAgreement(
  validator: ManagedValidator,
  variants: Array<{ name: string; data: Record<string, unknown> }>,
): void {
  for (const variant of variants) {
    const core = coreOutcome(variant.data);
    const managed = managedOutcome(validator, variant.data);
    expect(core.accepted, `${variant.name}: Core validator must reject`).toBe(false);
    expect(managed.accepted, `${variant.name}: managed validator must reject`).toBe(false);
    expect(core.message).toBeTruthy();
    expect(managed.message).toBeTruthy();
  }
}

describeRealProvider("M3 negotiation agreement (ZIGMA_WORKSPACE_CLI_PATH)", () => {
  let real: Record<string, unknown>;
  let validator: ManagedValidator;

  beforeAll(async () => {
    real = fetchRealContractInfo();
    // The built negotiation module, not the api barrel: the barrel loads the
    // database layer (better-sqlite3) which the Core test process must not
    // depend on just to validate a contract.
    const negotiationPath = resolve(dirname(workspaceCliPath!), "..", "core", "negotiation.js");
    validator = (await import(pathToFileURL(negotiationPath).href)) as unknown as ManagedValidator;
  });

  it("accepts the real provider contract through both validators", () => {
    expect(coreOutcome(real)).toEqual({ accepted: true });
    expect(managedOutcome(validator, real)).toEqual({ accepted: true });
  });

  it("rejects shared-contract violations identically", () => {
    const capabilities = real["capabilities"] as string[];
    const sharedCapabilities = REQUIRED_WORKSPACE_CAPABILITIES.filter((capability) =>
      validator.MANAGED_REQUIRED_CAPABILITIES.includes(capability),
    );
    expect(sharedCapabilities.length).toBeGreaterThan(0);

    expectAgreement(validator, [
      { name: "contract_version bump", data: mutate(real, (d) => ({ ...d, contract_version: 2 })) },
      { name: "foreign provider", data: mutate(real, (d) => ({ ...d, provider: "other-provider" })) },
      { name: "non-array capabilities", data: mutate(real, (d) => ({ ...d, capabilities: "not-an-array" })) },
      {
        name: "shared capability removed",
        data: mutate(real, (d) => ({
          ...d,
          capabilities: capabilities.filter((capability) => capability !== sharedCapabilities[0]),
        })),
      },
    ]);
  });

  it("keeps the documented role asymmetries — each validator enforces its own role only", () => {
    const capabilities = real["capabilities"] as string[];
    const managedOnly = validator.MANAGED_REQUIRED_CAPABILITIES.find(
      (capability) => !(REQUIRED_WORKSPACE_CAPABILITIES as readonly string[]).includes(capability),
    );
    const coreOnly = REQUIRED_WORKSPACE_CAPABILITIES.find(
      (capability) => !validator.MANAGED_REQUIRED_CAPABILITIES.includes(capability),
    );
    expect(managedOnly).toBeDefined();
    expect(coreOnly).toBeDefined();

    const managedOnlyRemoved = mutate(real, (d) => ({
      ...d,
      capabilities: capabilities.filter((capability) => capability !== managedOnly),
    }));
    const coreOnlyRemoved = mutate(real, (d) => ({
      ...d,
      capabilities: capabilities.filter((capability) => capability !== coreOnly),
    }));
    const unsupported = mutate(real, (d) => ({ ...d, managed_supported: false }));

    // Removing a managed-only capability strands the Flow bridge (which gates
    // on the provider's own managed role), but Core's M0 role never used those
    // capabilities and may accept the provider.
    expect(coreOutcome(managedOnlyRemoved).accepted).toBe(true);
    expect(managedOutcome(validator, managedOnlyRemoved).accepted).toBe(false);

    // managed_supported: false is a managed-role gate. Core's M0 role does not
    // consume managed workspaces, so it does not reject the provider for it.
    expect(coreOutcome(unsupported).accepted).toBe(true);
    expect(managedOutcome(validator, unsupported).accepted).toBe(false);

    // Removing a Core-only capability breaks the M0 adapter but does not
    // strand the managed lifecycle, so the managed validator stays green.
    expect(coreOutcome(coreOnlyRemoved).accepted).toBe(false);
    expect(managedOutcome(validator, coreOnlyRemoved).accepted).toBe(true);

    // package_version is a Core-only diagnostic gate: Core rejects an empty
    // version, the managed validator never inspects it. Same payload,
    // role-specific outcome — an asymmetry, not a fork.
    const emptyPackageVersion = mutate(real, (d) => ({ ...d, package_version: "" }));
    expect(coreOutcome(emptyPackageVersion).accepted).toBe(false);
    expect(managedOutcome(validator, emptyPackageVersion).accepted).toBe(true);
  });
});
