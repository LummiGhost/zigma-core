import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Client package identity, resolved from package.json in both layouts:
 * src/version.ts compiles to dist/version.js and URL("../package.json") always
 * resolves to the package root beside src/ or dist/.
 */
function readPackageVersion(): string {
  let source: string;
  try {
    source = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  } catch (error) {
    throw new Error(`cannot read package.json beside ${fileURLToPath(import.meta.url)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error("package.json is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("package.json must contain an object");
  }
  const version = (parsed as Record<string, unknown>)["version"];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json has no string version field");
  }
  return version;
}

export const packageVersion: string = readPackageVersion();
