import {
  listRecentAssets,
  matchAsset
} from "./discovery.js";
import { abortable } from "./abort.js";
import { normalizeJobResult } from "./output-normalizer.js";
import type { LingjingAsset } from "./assets.js";
import type {
  JobRecord,
  JobStatus,
  JobTransition
} from "./types.js";
import type { LingjingTransport } from "../lingjing/types.js";

export interface TaskPoller {
  poll(job: JobRecord, signal?: AbortSignal): Promise<JobRecord>;
}

export interface PollerRepository {
  transition(
    id: string,
    expectedStatuses: readonly JobStatus[],
    transition: JobTransition
  ): JobRecord;
}

export interface LingjingTaskPollerOptions {
  repository: PollerRepository;
  transport: LingjingTransport;
  now?: () => number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function findTask(
  value: unknown,
  depth = 0,
  seen = new Set<object>()
): Record<string, unknown> | null {
  const item = record(value);
  if (item === null || seen.has(item) || depth > 5) return null;
  seen.add(item);
  if (
    item.status !== undefined
    || item.taskResults !== undefined
    || item.taskId !== undefined
  ) {
    return item;
  }
  for (const key of ["task", "data", "result", "taskInfo"]) {
    const nested = findTask(item[key], depth + 1, seen);
    if (nested !== null) return nested;
  }
  return null;
}

function upstreamStatus(value: unknown): 0 | 1 | 2 | null {
  const status = typeof value === "string" ? Number(value) : value;
  return status === 0 || status === 1 || status === 2 ? status : null;
}

function taskAsAsset(
  task: Record<string, unknown>,
  job: JobRecord
): Partial<LingjingAsset> {
  return {
    ...task,
    id: typeof task.id === "string" ? task.id : job.upstreamTaskId ?? job.id,
    createTime: typeof task.createTime === "number"
      ? task.createTime
      : job.submittedAt ?? job.createdAt
  };
}

export class LingjingTaskPoller implements TaskPoller {
  private readonly now: () => number;

  constructor(private readonly options: LingjingTaskPollerOptions) {
    this.now = options.now ?? Date.now;
  }

  async poll(job: JobRecord, signal?: AbortSignal): Promise<JobRecord> {
    if (job.upstreamTaskId === null) {
      throw new Error(`Job ${job.id} has no upstream task id`);
    }
    signal?.throwIfAborted();
    const response = await abortable(
      this.options.transport.read<unknown>(
        "/openApi/modelmarket/describeUserTask",
        {
          method: "POST",
          body: { params: { taskId: job.upstreamTaskId } }
        }
      ),
      signal,
      "Task polling aborted"
    );
    signal?.throwIfAborted();
    const task = findTask(response);
    if (task === null) throw new Error("Lingjing task response is malformed");
    const status = upstreamStatus(task.status);
    if (status === null) throw new Error("Lingjing task status is invalid");

    if (status === 0) {
      if (job.status === "processing") return job;
      return this.options.repository.transition(
        job.id,
        ["discovering", "unknown"],
        {
          status: "processing",
          errorCode: null
        }
      );
    }

    if (status === 2) {
      return this.options.repository.transition(
        job.id,
        ["discovering", "processing", "unknown"],
        {
          status: "failed",
          failedAt: this.now(),
          errorCode: "lingjing_task_failed"
        }
      );
    }

    let result = normalizeJobResult(taskAsAsset(task, job));
    if (result === null) {
      const assets = await listRecentAssets(
        this.options.transport,
        job,
        signal
      );
      signal?.throwIfAborted();
      const taskAsset = assets.find((asset) => (
        asset.taskId !== null && asset.taskId === job.upstreamTaskId
      ));
      const discovered = taskAsset ?? matchAsset(job, assets).asset;
      if (discovered !== undefined) result = normalizeJobResult(discovered);
    }
    if (result === null) return job;

    return this.options.repository.transition(
      job.id,
      ["discovering", "processing", "unknown"],
      {
        status: "completed",
        completedAt: this.now(),
        result,
        errorCode: null
      }
    );
  }
}
