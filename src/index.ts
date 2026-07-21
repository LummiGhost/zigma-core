/** Public entry point for @zigma-ai/zigma-core. */
export * from "./types/index.js";
export { ZigmaCore, type ZigmaCoreOptions } from "./api/core.js";
export { CoreError, type CoreErrorCode } from "./errors.js";
export type {
  FlowInvoker,
  FlowInvokeRequest,
  FlowInvokeHandle,
  FlowRunStatusMirror,
  FlowGateDecision,
} from "./adapters/flow/types.js";
export { LocalCliFlowInvoker } from "./adapters/flow/localCli.js";
export {
  LocalCliWorkspaceClient,
  type WorkspaceClient,
  type CreateWorkspaceRequest,
  type WorkspaceInfo,
  type WorkspaceDiff,
} from "./adapters/workspace/index.js";
export { createHttpServer } from "./http/server.js";
export { grantsToPermissionStrings } from "./services/permissionService.js";
