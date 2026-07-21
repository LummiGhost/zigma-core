/**
 * Zigma Core error model. Flat, serializable errors with stable codes,
 * mirroring the zigma-flow Host API error shape.
 */

export type CoreErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "INVALID_STATE"
  | "PERMISSION_DENIED"
  | "FLOW_INVOCATION_FAILED"
  | "WORKSPACE_FAILED"
  | "CONFLICT"
  | "INTERNAL";

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly details?: Record<string, unknown>;
  readonly suggestion?: string;

  constructor(
    code: CoreErrorCode,
    message: string,
    details?: Record<string, unknown>,
    suggestion?: string
  ) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    this.details = details;
    this.suggestion = suggestion;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      suggestion: this.suggestion,
    };
  }
}

export function notFound(what: string, id: string): CoreError {
  return new CoreError("NOT_FOUND", `${what} not found: ${id}`, { id });
}

export function invalidState(message: string, details?: Record<string, unknown>): CoreError {
  return new CoreError("INVALID_STATE", message, details);
}

export function permissionDenied(message: string, details?: Record<string, unknown>): CoreError {
  return new CoreError("PERMISSION_DENIED", message, details);
}
