/**
 * Task service (FR-002, FR-003): task lifecycle and state-machine
 * enforcement. All status changes flow through `transition()` so every
 * change is validated and audited.
 */

import type { Repos } from "../db/repos.js";
import { invalidState, notFound } from "../errors.js";
import type { ActorRef, CreateTaskInput, TaskStatus, ZigmaTask } from "../types/index.js";
import { CreateTaskInputSchema, TASK_TRANSITIONS } from "../types/index.js";

export class TaskService {
  constructor(private repos: Repos) {}

  create(rawInput: CreateTaskInput): ZigmaTask {
    const input = CreateTaskInputSchema.parse(rawInput);
    const project = this.repos.projects.get(input.projectId);
    if (!project) throw notFound("Project", input.projectId);
    if (project.status === "archived") {
      throw invalidState(`Project ${project.id} is archived`);
    }
    const task = this.repos.tasks.insert({
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      source: input.source,
      status: "created",
      priority: input.priority,
      createdBy: input.createdBy,
    });
    this.repos.audit.append({
      type: "task.created",
      actor: input.createdBy,
      projectId: input.projectId,
      taskId: task.id,
      detail: { title: task.title, source: task.source, priority: task.priority },
    });
    return task;
  }

  get(taskId: string): ZigmaTask {
    const task = this.repos.tasks.get(taskId);
    if (!task) throw notFound("Task", taskId);
    return task;
  }

  /**
   * Transition a task, enforcing the FR-003 state machine.
   * No-op when the status is unchanged (idempotent sync).
   */
  transition(
    taskId: string,
    to: TaskStatus,
    opts: { actor?: ActorRef; reason?: string; currentFlowRunId?: string | null } = {}
  ): ZigmaTask {
    const task = this.get(taskId);
    if (task.status === to) return task;
    const allowed = TASK_TRANSITIONS[task.status] ?? [];
    if (!allowed.includes(to)) {
      throw invalidState(
        `Illegal task transition ${task.status} -> ${to} for ${taskId}`,
        { from: task.status, to, allowed }
      );
    }
    this.repos.tasks.updateStatus(taskId, to, opts.currentFlowRunId);
    this.repos.audit.append({
      type: "task.status_changed",
      actor: opts.actor,
      projectId: task.projectId,
      taskId,
      flowRunId: opts.currentFlowRunId ?? task.currentFlowRunId,
      detail: { from: task.status, to, reason: opts.reason },
    });
    return this.get(taskId);
  }
}
