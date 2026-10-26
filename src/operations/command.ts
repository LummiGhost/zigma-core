import { execa } from "execa";

export interface OwnedCommandOptions {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  maxBuffer?: number;
}

export interface OwnedCommandResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
  pid?: number;
  unknown: boolean;
  timedOut: boolean;
}

/** Bound the observer itself, including descendants that keep inherited pipes open.
 * Unknown results retain the caller's lease even after best-effort termination.
 * A trusted command must wait for its children before reporting normal success.
 */
export async function runOwnedCommand(command: string, args: string[], options: OwnedCommandOptions): Promise<OwnedCommandResult> {
  const child = execa(command, args, {
    cwd: options.cwd, env: options.env, reject: false, shell: false,
    windowsHide: true, cleanup: false, detached: process.platform !== "win32",
    maxBuffer: options.maxBuffer ?? 1024 * 1024
  });
  const completion = child.then(result => ({ result }), error => ({ error }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ deadline: true }>(resolve => {
    timer = setTimeout(() => resolve({ deadline: true }), options.timeoutMs);
  });
  const outcome = await Promise.race([completion, deadline]);
  if (timer) clearTimeout(timer);
  const timedOut = "deadline" in outcome;
  const result = "result" in outcome ? outcome.result : undefined;
  const unknown = timedOut || (Boolean(child.pid) && (!result || result.signal !== undefined || result.exitCode === undefined));
  if (unknown) {
    // Only an owned, still-live root is eligible for tree termination. A root
    // that already exited may have a reused PID; its lease remains for recovery.
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform === "win32") {
          await execa("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            reject: false, timeout: 3000, forceKillAfterDelay: 500, windowsHide: true
          });
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        try { child.kill("SIGKILL"); } catch { /* Retain unknown state. */ }
      }
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
  return {
    stdout: String(result?.stdout ?? ""),
    stderr: String(result?.stderr ?? ("error" in outcome ? outcome.error instanceof Error ? outcome.error.message : String(outcome.error) : "")),
    ...(result?.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    unknown, timedOut
  };
}
