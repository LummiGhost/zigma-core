import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Real provider suites spawn several CLIs each; bound file-level contention.
    ...(process.platform === "win32" ? { maxWorkers: 2 } : {}),
    coverage: { enabled: false }
  }
});
