export class CoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "CoreError";
  }
}

export class NotFoundError extends CoreError {
  constructor(kind: string, id: string) {
    super("NOT_FOUND", `${kind} not found: ${id}`, 404, { kind, id });
  }
}

export class ConflictError extends CoreError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("CONFLICT", message, 409, details);
  }
}

export class ForbiddenError extends CoreError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("FORBIDDEN", message, 403, details);
  }
}

export class IntegrationError extends CoreError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("INTEGRATION_ERROR", message, 502, details);
  }
}
