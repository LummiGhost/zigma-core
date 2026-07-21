import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { CoreService } from "../application/core-service.js";
import { CoreError } from "../domain/errors.js";

export function buildServer(core: CoreService): FastifyInstance {
  const app = Fastify({ logger: true });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.issues
        }
      });
    }
    if (error instanceof CoreError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details
        }
      });
    }
    app.log.error(error);
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unknown error"
      }
    });
  });

  app.get("/health", async () => ({ ok: true, service: "zigma-core" }));

  app.post("/v1/execution-profiles", async (request, reply) => {
    const profile = core.createExecutionProfile(request.body as never);
    return reply.status(201).send({ data: profile });
  });

  app.get<{ Params: { id: string } }>("/v1/execution-profiles/:id", async (request) => ({
    data: core.getExecutionProfile(request.params.id)
  }));

  app.post("/v1/projects", async (request, reply) => {
    const project = core.createProject(request.body as never);
    return reply.status(201).send({ data: project });
  });

  app.get<{ Params: { id: string } }>("/v1/projects/:id", async (request) => ({
    data: core.getProject(request.params.id)
  }));

  app.post("/v1/tasks", async (request, reply) => {
    const task = core.createTask(request.body as never);
    return reply.status(201).send({ data: task });
  });

  app.get<{ Params: { id: string } }>("/v1/tasks/:id", async (request) => ({
    data: core.getTaskView(request.params.id)
  }));

  app.post<{ Params: { id: string } }>("/v1/tasks/:id/start", async (request, reply) => {
    const view = await core.startTask(request.params.id, request.body as never);
    return reply.status(202).send({ data: view });
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/v1/tasks/:id/cancel", async (request) => ({
    data: await core.cancelTask(request.params.id, request.body?.reason ?? "Cancelled through Core API")
  }));

  app.post<{ Params: { id: string } }>("/v1/flow-runs/:id/events", async (request) => ({
    data: core.recordFlowEvent(request.params.id, request.body as never)
  }));

  app.post("/v1/human-gates", async (request, reply) => {
    const gate = core.createHumanGate(request.body as never);
    return reply.status(201).send({ data: gate });
  });

  app.post<{ Params: { id: string } }>("/v1/human-gates/:id/decisions", async (request) => ({
    data: await core.decideHumanGate(request.params.id, request.body as never)
  }));

  app.post<{ Params: { id: string } }>("/v1/flow-runs/:id/evidence", async (request, reply) => {
    const item = core.addEvidenceItem(request.params.id, request.body as never);
    return reply.status(201).send({ data: item });
  });

  app.get<{ Params: { id: string } }>("/v1/flow-runs/:id/evidence", async (request) => ({
    data: core.getEvidence(request.params.id)
  }));

  app.post<{ Params: { id: string } }>("/v1/flow-runs/:id/evidence/finalize", async (request) => ({
    data: core.finalizeEvidence(request.params.id, request.body as never)
  }));

  app.get<{ Params: { id: string } }>("/v1/tasks/:id/audit-events", async (request) => ({
    data: core.listTaskAudit(request.params.id)
  }));

  return app;
}
