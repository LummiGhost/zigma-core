/**
 * Minimal HTTP API for Zigma Core (MVP, no framework).
 *
 * Routes:
 *   GET    /health
 *   POST   /projects                      GET /projects        GET /projects/:id
 *   POST   /projects/:id/archive         POST /projects/:id/repositories
 *   POST   /tasks                         GET /tasks            GET /tasks/:id
 *   GET    /tasks/:id/status
 *   POST   /tasks/:id/start
 *   POST   /tasks/:id/sync
 *   POST   /tasks/:id/cancel
 *   POST   /tasks/:id/links
 *   POST   /tasks/:id/evidence            GET /evidence/:id
 *   GET    /gates?status=awaiting
 *   POST   /gates/:id/approve             POST /gates/:id/reject
 *   GET    /audit?taskId=&limit=
 *
 * Authentication is out of scope for the MVP; run behind a trusted boundary.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CoreError } from "../errors.js";
import type { ZigmaCore } from "../api/core.js";

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

export function createHttpServer(core: ZigmaCore): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    try {
      // health
      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, service: "zigma-core", time: new Date().toISOString() });
      }

      // projects
      if (parts[0] === "projects") {
        if (method === "POST" && parts.length === 1) {
          return send(res, 201, core.createProject(await readJson(req)));
        }
        if (method === "GET" && parts.length === 1) {
          return send(res, 200, core.listProjects());
        }
        if (method === "GET" && parts.length === 2) {
          return send(res, 200, core.getProject(parts[1]));
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "archive") {
          return send(res, 200, core.archiveProject(parts[1]));
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "repositories") {
          const body = await readJson(req);
          return send(res, 201, core.registerRepository({ ...body, projectId: parts[1] }));
        }
      }

      // tasks
      if (parts[0] === "tasks") {
        if (method === "POST" && parts.length === 1) {
          return send(res, 201, core.createTask(await readJson(req)));
        }
        if (method === "GET" && parts.length === 1) {
          const projectId = url.searchParams.get("projectId") ?? undefined;
          const status = (url.searchParams.get("status") as any) ?? undefined;
          return send(res, 200, core.listTasks({ projectId, status }));
        }
        if (method === "GET" && parts.length === 2) {
          return send(res, 200, core.getTask(parts[1]));
        }
        if (method === "GET" && parts.length === 3 && parts[2] === "status") {
          return send(res, 200, core.getTaskStatus(parts[1]));
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "start") {
          const body = await readJson(req);
          return send(res, 202, await core.startTask(parts[1], body));
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "sync") {
          return send(res, 200, await core.syncTask(parts[1]));
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "cancel") {
          const body = await readJson(req);
          await core.cancelTask(parts[1], body.reason ?? "cancelled via api", body.actor);
          return send(res, 200, { ok: true });
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "links") {
          const body = await readJson(req);
          return send(res, 201, core.addExternalLink({ ...body, taskId: parts[1] }));
        }
        if (method === "POST" && parts.length === 3 && parts[2] === "evidence") {
          const body = await readJson(req);
          return send(res, 201, await core.collectEvidence(parts[1], body.flowRunRefId));
        }
      }

      // evidence
      if (parts[0] === "evidence" && method === "GET" && parts.length === 2) {
        return send(res, 200, core.getEvidence(parts[1]));
      }

      // gates
      if (parts[0] === "gates") {
        if (method === "GET" && parts.length === 1) {
          const status = (url.searchParams.get("status") as any) ?? undefined;
          const taskId = url.searchParams.get("taskId") ?? undefined;
          return send(res, 200, core.listGates({ status, taskId }));
        }
        if (method === "POST" && parts.length === 3 && (parts[2] === "approve" || parts[2] === "reject")) {
          const body = await readJson(req);
          const input = { ...body, gateRequestId: parts[1] };
          const result =
            parts[2] === "approve" ? await core.approveGate(input) : await core.rejectGate(input);
          return send(res, 200, result);
        }
      }

      // audit
      if (parts[0] === "audit" && method === "GET") {
        const taskId = url.searchParams.get("taskId") ?? undefined;
        const limit = url.searchParams.get("limit");
        return send(res, 200, core.listAudit({ taskId, limit: limit ? Number(limit) : undefined }));
      }

      return send(res, 404, { code: "NOT_FOUND", message: `No route: ${method} ${url.pathname}` });
    } catch (err) {
      if (err instanceof CoreError) {
        const status =
          err.code === "NOT_FOUND"
            ? 404
            : err.code === "PERMISSION_DENIED"
              ? 403
              : err.code === "VALIDATION_FAILED" || err.code === "INVALID_STATE"
                ? 409
                : 500;
        return send(res, status, err.toJSON());
      }
      if (err instanceof SyntaxError) {
        return send(res, 400, { code: "VALIDATION_FAILED", message: "Invalid JSON body" });
      }
      // zod errors
      if ((err as any)?.issues) {
        return send(res, 400, {
          code: "VALIDATION_FAILED",
          message: "Input validation failed",
          details: (err as any).issues,
        });
      }
      return send(res, 500, {
        code: "INTERNAL",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
