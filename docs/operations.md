# Standard operator workflow

Core 0.1.4 adds `ops run`, `ops report` and `ops note` for repeatable local
execution, independent acceptance and artifact delivery. `ops run` uses an
**already running Core HTTP service**. It does not start or stop Core, open its
database, reset a Flow run, merge changes or publish a package.

Core owns task/admission state, Flow owns workflow execution and Workspace owns
Git workspaces. The operator owns the workflow, acceptance rules and delivery
decision. See the [API](api-contracts.md) and
[integration contracts](integration-contracts.md) for those boundaries.

## 1. Prepare a fixed execution environment

Use Node.js 22.5 or newer. Install the required suite in an operator-owned
runtime directory, and keep that installation unchanged during a batch. The
published-suite regression below creates such a fresh installation and records
its exact package identities. `ops run` itself **does not install or resolve
npm latest**: it checks the configured server/providers and records their
observed versions and provider command-file hashes.

The examples use PowerShell and replaceable `C:/...` paths. Substitute existing
absolute paths and real IDs before running them. On Unix, use the corresponding
executable provider entry points instead of Windows `.cmd` shims. A shim must
forward arguments and exit status to its fixed CLI target.

Use an isolated repository clone with a known accepted base. Configure its
Flow backend and workflow before dispatch. A Workspace `read-only` policy is
an execution mode, **not an OS sandbox**. Generic commands run with the local
operator's permissions; this workflow does not establish host write isolation.

In one terminal, start the fixed Core installation:

```powershell
$env:ZIGMA_CORE_URL = 'http://127.0.0.1:4736/v1'
& 'C:/zigma-runtime/node_modules/.bin/zigma-core.cmd' `
  --db 'C:/ops-state/core.db' serve --host 127.0.0.1 --port 4736 --workers 1
```

Keep the server and its installed code available until task/worker outcomes are
known. Configure authentication in the operator's local environment; do not
put credentials in the examples, task descriptions or receipts.

In another terminal, check the server:

```powershell
$opsCoreUrl = 'http://127.0.0.1:4736'
Invoke-RestMethod "$opsCoreUrl/health"
```

The health response must identify `zigma-core` and include a semver `version`.
The operations client version is recorded separately from this server version.

Save this as `ops-profile.json`, replacing both provider paths. Operations
requires absolute provider commands resolving to regular files; a bare command
from `PATH` is insufficient.

```json
{
  "name": "local-ops",
  "mode": "local-cli",
  "flowCommand": "C:/zigma-runtime/node_modules/.bin/zigma-flow.cmd",
  "workspaceCommand": "C:/zigma-runtime/node_modules/.bin/zigma-workspace.cmd",
  "timeoutMs": 900000,
  "executionPolicy": {
    "contractVersion": 1,
    "capacity": { "global": 1, "perProject": 1, "perRepository": 1, "perBackend": 1 },
    "admission": { "writablePerRepository": 1, "queueDiscipline": "fifo", "requireDistinctWorkspace": true }
  },
  "environment": { "ZIGMA_WORKSPACE_STATE_DIR": "C:/ops-state/workspaces" },
  "metadata": {}
}
```

Register it through the running server:

```powershell
$opsProfileResponse = Invoke-RestMethod -Method Post `
  -Uri "$opsCoreUrl/v1/execution-profiles" -ContentType 'application/json' `
  -InFile './ops-profile.json'
$opsProfileResponse.data.id
```

Save `ops-project.json`, replacing `PROFILE_ID`, the repository path and workflow
path. Receipt-copy delivery requires `provider: "zigma-workspace-cli"` and
`cleanup: "manual"`, so the workspace remains available for acceptance/copying.

```json
{
  "key": "product-ops",
  "displayName": "Product isolated development",
  "repositories": [
    { "id": "product", "provider": "generic-git", "url": "C:/work/product-isolated", "defaultRef": "main", "writable": false, "metadata": {} }
  ],
  "defaultRepositoryId": "product",
  "defaultWorkflowRef": "C:/work/product-isolated/ops/workflow.yml",
  "executionProfileId": "PROFILE_ID",
  "workspacePolicy": {
    "provider": "zigma-workspace-cli",
    "mode": "read-only",
    "branchTemplate": "zigma/{taskId}",
    "cleanup": "manual",
    "snapshotOnTerminal": true
  },
  "metadata": { "projectRoot": "C:/work/product-isolated" }
}
```

```powershell
$opsProjectResponse = Invoke-RestMethod -Method Post `
  -Uri "$opsCoreUrl/v1/projects" -ContentType 'application/json' `
  -InFile './ops-project.json'
$opsProjectResponse.data.id
```

The older database administration commands remain available. In particular,
`task start --db ...` is not the HTTP operations runner described here.

## 2. Define the batch and independent checker

Save a manifest such as `batch.json` below. This example assumes an existing
**script-only** workflow producing `candidate.json` and a real, independent
checker at the supplied path. It is a template, not a ready-made product gate.
Replace every path/ID and implement the product-specific checker first.

```json
{
  "schema": "zigma.ops/1",
  "coreUrl": "http://127.0.0.1:4736",
  "projectId": "PROJECT_ID",
  "cohort": "candidate-contract-v1",
  "workloadKind": "deterministic",
  "proposalFreedom": "none",
  "modelRoute": "no-model",
  "workflowRef": "C:/work/product-isolated/ops/workflow.yml",
  "backend": "claude-code",
  "suiteLeaseFile": "C:/ops-state/suite-use.lock",
  "freezeFiles": [
    "C:/work/product-isolated/ops/workflow.yml",
    "C:/work/product-isolated/.zigma-flow/config.json",
    "C:/ops/checks/accept.cjs",
    "C:/ops/checks/acceptance-policy.json"
  ],
  "acceptance": {
    "command": "C:/Program Files/nodejs/node.exe",
    "args": ["C:/ops/checks/accept.cjs"],
    "timeoutMs": 300000
  },
  "delivery": { "files": ["candidate.json"] },
  "tasks": [
    { "key": "case-001", "title": "Check case 001", "description": "Run the approved script-only case", "inputs": { "caseId": "001" } },
    { "key": "case-002", "title": "Check case 002", "description": "Run the next comparable case", "inputs": { "caseId": "002" } }
  ],
  "callerContext": {
    "actor": { "type": "user", "id": "local-operator" },
    "capabilities": ["task:start", "workflow:invoke", "workspace:create"],
    "constraints": {
      "repositoryIds": ["product"],
      "workflowRefs": ["C:/work/product-isolated/ops/workflow.yml"],
      "toolNames": [],
      "branchPatterns": ["zigma/*"],
      "maxRunDurationMs": 900000
    },
    "source": { "kind": "cli", "metadata": {} }
  },
  "timeoutMs": 300000,
  "pollIntervalMs": 250,
  "cancelGraceMs": 30000,
  "preflightTimeoutMs": 60000
}
```

`coreUrl` is a loopback HTTP origin with an explicit port, without `/v1`,
credentials, query or fragment. Task keys are unique and match
`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.

Relative host paths in `freezeFiles`, `suiteLeaseFile` and explicit acceptance
`cwd` are resolved against the manifest directory. Use an absolute `workflowRef`
as above so Core/Flow and the local runner identify the same file. Delivery
paths are relative to the returned task workspace. Acceptance `cwd` defaults
to that workspace. Executables/arguments are passed without a shell; there is
no manifest-variable interpolation in `acceptance.args`.

Freeze the checker, its policy, helper sources and relevant backend settings.
The runner also freezes the workflow and provider command entry files. Hashing
a `.cmd` shim does not freeze all code it references: include relevant target
files explicitly or preserve the verified package installation. This is not
a complete source-to-build or dependency-integrity attestation.

The checker receives `ZIGMA_OPS_WORKSPACE`, `ZIGMA_OPS_TASK_ID` and
`ZIGMA_OPS_OUT_DIR`. It must inspect the actual candidate and print one JSON
object to stdout; diagnostics belong on stderr. A wrapper that merely prints
`pass` is not independent acceptance.

| Checker stdout | Checker exit | Operations outcome |
| --- | --- | --- |
| `{"status":"pass","reason":"required checks passed"}` | 0 | Eligible for delivery |
| `{"status":"fail","reason":"measured failure"}` | Nonzero; use 10 | Rejected, exit 10 |
| `{"status":"blocked","reason":"required evidence missing"}` | Nonzero; use 11 | Blocked, exit 11 |
| Invalid/missing JSON status, pass with nonzero exit, or non-pass with exit 0 | Any | Contract failure, exit 12 |

Command timeout/signal or a spawned command with an unknown outcome is blocked
and retains the lease. Trusted commands must wait for their children before
reporting normal success. Best-effort owned-process termination is not proof
that arbitrary detached descendants have stopped. Provider preflight commands
use the same bounded-command rule.

`workloadKind` is `deterministic`, `fault-injection`, `live-model` or
`real-repair`; `proposalFreedom` is `none`, `preapproved`, `bounded` or
`unrestricted`. These are reporting labels, not permission controls or switches
that disable model calls. Inspect the actual workflow/backend. `modelRoute` is
operator-supplied and recorded as such; it is not an automatically verified
provider/model identity.

## 3. Execute and collect delivery

```powershell
& 'C:/zigma-runtime/node_modules/.bin/zigma-core.cmd' ops run `
  --manifest './batch.json' --out 'C:/ops-results/batch-001'
```

The output directory's parent must exist and `batch-001` must be new. Reusing
an existing directory is rejected before dispatch; it is not a resume command.
The runner obtains the exclusive suite lease before provider preflight, checks
the fixed server/profile/provider identities, and writes a plan before any
task POST. It then creates and starts each task sequentially through Core.

Flow completion alone is insufficient. Both execution-command and Flow
terminal states are checked before independent acceptance. Normal matching
completed/failed invoke results establish invocation return; cancellation
requires explicit quiescence proof. Awaiting-human runs remain blocked without
automatic cancellation. Unknown command outcomes retain the lease and prevent
later dispatch, even if Core's workflow has already stopped.

The runner checks frozen assets before dispatch and after execution/checking/
copying. It copies only requested regular files, rejecting traversal, absolute
paths, `.git` metadata, symlinks/junctions and escaped source/destination paths.
Each copied file is hashed; the current per-file limit is 32 MiB, and captured
command output is bounded to 1 MiB per stream. A delivered receipt means a local
validated artifact copy, not a merged PR, deployed application or scientific
validation beyond the independent checker's declared scope.

```text
batch-001/
  plan.json
  run.json
  interventions.jsonl             # created only when notes are recorded
  tasks/case-001/
    progress.json
    receipt.json
    acceptance.stdout.log
    acceptance.stderr.log
    artifacts/candidate.json
```

`plan.json` retains the intended task denominator, frozen hashes, suite versions,
client version and policy hash. A final task receipt is created exclusively;
progress is a replaceable intermediate observation. Some logs/final files may
be absent after an interrupted or unknown phase. Preserve the original output;
do not edit a failed receipt into a successful one.

| Operations exit | Meaning |
| --- | --- |
| 0 | Every recorded task delivered after passing independent acceptance |
| 10 | Known execution or acceptance failure |
| 11 | Blocked, missing evidence, awaiting human, cancelled or unknown outcome |
| 12 | Input/preflight contract, integrity, frozen-input or delivery-path error |

For mixed batches the priority is 12, then 10, then 11, then 0. Inspect the
individual receipts: a nonzero batch can still contain successful deliveries.
Preflight failures can leave an output directory without a plan; such a
directory is not a completed batch and is not included in `ops report`.
CLI argument-parser errors can return a native nonzero exit before an
operations JSON result is produced.

## 4. Report comparable tasks and record intervention

```powershell
zigma-core ops report --dir 'C:/ops-results/batch-001'
zigma-core ops report --dir 'C:/ops-results'
zigma-core ops note --dir 'C:/ops-results/batch-001' --task case-001 `
  --kind review --reason 'Independent candidate review completed'
zigma-core ops note --dir 'C:/ops-results/batch-001' --task case-001 `
  --kind repair --reason 'Describe the actual operator repair'
```

Reporting accepts one batch or its parent and examines immediate child batches.
It validates plan/receipt identities and contradictions rather than treating
arbitrary JSON as accepted evidence. Notes append to the batch; they do not
change receipts, resume tasks or clear leases. Note kinds are `review`,
`repair`, `reset`, `retry`, `other`; reviews are counted separately from other
recorded interventions. Notes are **self-reported**, so no notes does not prove
the absence of outside human activity. Do not include credentials in reasons or
checker output; captured diagnostic logs remain local artifacts.

Groups keep cohort, workload kind, proposal freedom, declared model route,
policy hash, suite versions and operations-client version separate. Policy
hashes include frozen files and the execution/permission/timeout/checker/
delivery configuration. A changed policy or client belongs to a different
measurement group; do not pool it into a convenient success rate.

| Field | Interpretation |
| --- | --- |
| `planned` | All tasks in retained plans |
| `attempted` | Tasks whose final receipt records a start attempt; not a count of model calls |
| `accepted` | Receipts with passing independent acceptance |
| `delivered` | Receipts that also completed validated local artifact delivery |
| `failed` / `blocked` / `notStarted` | Corresponding final receipt outcomes |
| `unknown` | Planned tasks without a final receipt; no attempt/success is invented |
| `acceptanceRate` | `accepted / attempted`, or null when no attempts are recorded |
| `deliveryRate` | `delivered / planned`, or null when the denominator is zero |
| `totalElapsedMs` | Sum of per-task `elapsedMs` from available receipts |

Per-task elapsed time covers task creation/start, waiting, independent checking
and delivery. It excludes batch preflight, later review/merge/release and is
not model billing time. Report unknown counts alongside rates: missing final
receipts can also hide actual attempts. Neither this conditional acceptance
rate nor a Flow `completed` counter proves first-attempt model success or genuine
rework success. Pre-plan failures are absent from these denominators and must
be accounted for separately before making an overall reliability claim.

## 5. Recover an unknown run without replaying it

1. Keep Core, the suite installation, lease and original batch evidence intact.
   Stop new dispatch and suite updates using the same lease. An old lock is
   not automatically stale merely because its recorded PID ended.
2. Inspect `progress.json`, receipt reasons and the recorded task/run/command
   IDs. Query `GET /v1/tasks/:id` through the existing service. For an
   acceptance-command unknown result, progress also records its observed PID;
   check that process's identity and descendants independently.
3. If cancellation is required, use `POST /v1/tasks/:id/cancel`. Follow Core and
   the provider's authoritative quiescence evidence; task `blocked` or one
   process exit alone is insufficient. A Flow owner can be inspected with its
   existing `--cwd WORKSPACE inspect --run RUN_ID --json` command. Do not reset
   state files, guess a run ID, kill every Node/CLI process or clean a live
   workspace. Awaiting-human tasks use the existing human-gate decision path.
4. Only after independently confirming the affected providers, checker and
   owned writers are quiet may the operator release the matching retained
   suite lease and record the recovery action. The operations runner has no
   blanket stale-lock cleanup command. Use a **new** output directory for any
   later attempt, preserving the earlier failed/unknown batch.

## 6. Qualify published packages and a candidate

These are development commands from a Core source checkout with dependencies
installed. The npm runtime package contains `dist`/`docs`, not the development
test runner or Vitest dependency.

```powershell
npm ci
npm run test:published-suite -- --artifacts-dir 'C:/ops-regressions'
```

This resolves each package's npm `latest` once, downloads and verifies immutable
tarball identities/integrities, installs them in a fresh owned prefix, checks
the actual CLIs/handshakes, and runs **all six M4 files, currently seven test
cases**. Any failed, skipped or unexecuted required case fails the gate. It
covers parallel capacity, conflict rollback, Core-driven cancellation,
restart windows, worker loss and admission invariants. It does not call a paid
model, rebuild provider source or prove arbitrary model-repair ability.

For a changed Core, build it first and test it against newly resolved published
Flow/Workspace packages:

```powershell
npm run build
npm run test:published-suite -- --core-cli './dist/cli.js' `
  --artifacts-dir 'C:/ops-regressions'
```

The receipt distinguishes candidate Core from registry-published packages and
records candidate CLI/dist inventory, manifest/lock hashes and Git diagnostics.
It does not claim a source-to-build attestation. After publishing, rerun the
default latest-published gate; a candidate result is not a published-package
result. Keep its `receipt.json`, `suite-lock.json`, pack manifests, test report
and logs, including failures.

## 7. Run the comparable synthetic benchmark

The benchmark creates an isolated temporary repository and its own Core service,
then uses the standard operations commands for three counter-predicate tasks.
It retains artifacts under the chosen parent. The provider arguments below
are **JavaScript CLI entry files**, not `.cmd` shims.

```powershell
npm run build
npm run test:ops-benchmark -- --mode deterministic `
  --flow-cli 'C:/zigma-runtime/node_modules/@zigma-ai/zigma-flow/dist/cli.js' `
  --workspace-cli 'C:/zigma-runtime/node_modules/@zigma-ai/zigma-workspace/dist/cli/index.js' `
  --artifacts-dir 'C:/ops-benchmarks'
```

Default deterministic mode emits a fixed valid fixture and checks 20 synthetic
values independently. It proves the execution/check/delivery path; it performs
no model repair. An actual model call requires **both** explicit live mode and
a Claude CLI path, using the operator's existing authentication/routing:

```powershell
npm run test:ops-benchmark -- --mode live-model `
  --claude-cli 'C:/tools/claude.exe' --model-route 'operator-verified-route' `
  --flow-cli 'C:/zigma-runtime/node_modules/@zigma-ai/zigma-flow/dist/cli.js' `
  --workspace-cli 'C:/zigma-runtime/node_modules/@zigma-ai/zigma-workspace/dist/cli/index.js' `
  --artifacts-dir 'C:/ops-benchmarks'
```

Live mode can incur provider charges. It asks for a bounded Boolean-expression
proposal, with CLI tools/MCP/hooks disabled, validates it and delivers a small
JSON artifact. The three cases remain **synthetic**; even a fully accepted
batch is not three independent real-repository fixes or proof of general
autonomy. The route label remains operator-supplied. An unknown/retained-lease
benchmark keeps its Core/evidence for inspection rather than declaring success.

## 8. Iterate in small accepted slices

Choose a narrow product change, keep its numerical/data/compatibility contract
fixed, and run the relevant regression plus the real integration path at risk.
Use independent review to decide whether a candidate is acceptable; retain
failed attempts instead of resetting them into successful records. Expand
checks when evidence reveals a new risk, rather than repeating unrelated long
suites after every small change.

When the operator has authorized direct merging/releasing, merge a reviewed
change after required checks pass and publish a patch for affected modules.
Unchanged modules need no ceremonial release. Qualify the published combination
before the next product batch, record the actual versions, and never replace
an active suite under its lease.

Keep task progress in Core/receipts and review evidence in the PR. Update this
guide or a stable contract when operator behavior changes; a small iteration
does not require a new report bundle or phase document. Preserve authoritative
repositories, reference bytes, data/state compatibility and independent
scientific gates. Framework success or a synthetic benchmark cannot authorize
an unverified CFD result, wider write permissions or full autonomous repair.
