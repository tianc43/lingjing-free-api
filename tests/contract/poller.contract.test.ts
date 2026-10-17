import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LingjingTaskPoller } from "../../src/jobs/poller.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import { fingerprintUpstreamPayload } from "../../src/jobs/upstream-fingerprint.js";
import type { JobRecord, NewJob } from "../../src/jobs/types.js";
import type { LingjingTransport } from "../../src/lingjing/types.js";
import { unwrapEnvelope } from "../../src/lingjing/envelope.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTestDirectory(directory);
  }
});

const fixtureNewJob: NewJob = {
  kind: "image",
  sourceType: "image-generation",
  model: "fixture-model",
  apiId: "707",
  modelCode: "model-v1",
  expectedAssetScene: "image-generation",
  requestFingerprint: "a".repeat(64),
  idempotencyKeyHash: null,
  spaceId: 0
};
const fixtureSubmitPayload = {
  apiId: "707",
  refId: "fixture-ref",
  params: [{ idx: "1", values: "fixture prompt" }]
};

it("preserves a terminal task failure even when the official envelope also reports business failure", async () => {
  const { repository, job } = repositoryWithProcessingJob();
  const transport = { read: vi.fn(() => Promise.resolve().then(() => unwrapEnvelope({
    requestId: "s-poll-terminal-failure",
    error: null,
    result: { task: {
      taskId: job.upstreamTaskId, status: 2, success: false,
      error: "TASK_RUN_FAILED", errMsg: "Provider rejected this task"
    } }
  }, 200))) } as unknown as LingjingTransport;
  try {
    const result = await new LingjingTaskPoller({ repository, transport, now: () => 20_000 }).poll(job);
    expect(result).toMatchObject({
      status: "failed", errorCode: "lingjing_task_failed",
      errorDiagnostics: { httpStatusCode: 200, requestId: "s-poll-terminal-failure", message: "Provider rejected this task" },
      upstreamObservation: { state: "verified", taskStatus: "2", checkedAt: 20_000 }
    });
  } finally { repository.close(); }
});

function repositoryWithProcessingJob(): {
  repository: SqliteJobRepository;
  job: JobRecord;
} {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-poller-"));
  directories.push(directory);
  const repository = new SqliteJobRepository(join(directory, "jobs.sqlite"));
  const created = repository.createOrGet(fixtureNewJob).job;
  const submitting = repository.transition(created.id, ["queued"], {
    status: "submitting",
    submittedAt: 10_000,
    upstreamFingerprint: fingerprintUpstreamPayload(fixtureSubmitPayload)
  });
  const discovering = repository.transition(submitting.id, ["submitting"], {
    status: "discovering"
  });
  return {
    repository,
    job: repository.transition(discovering.id, ["discovering"], {
      status: "processing",
      upstreamTaskId: "fixture-task"
    })
  };
}

function repositoryWithUnknownJob(): {
  repository: SqliteJobRepository;
  job: JobRecord;
} {
  const { repository, job } = repositoryWithProcessingJob();
  return {
    repository,
    job: repository.transition(job.id, ["processing"], {
      status: "unknown",
      unknownHoldUntil: 20_000,
      errorCode: "generation_discovery_timeout"
    })
  };
}

function repositoryWithDiscoveringErrorJob(): {
  repository: SqliteJobRepository;
  job: JobRecord;
} {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-poller-"));
  directories.push(directory);
  const repository = new SqliteJobRepository(join(directory, "jobs.sqlite"));
  const created = repository.createOrGet(fixtureNewJob).job;
  const submitting = repository.transition(created.id, ["queued"], {
    status: "submitting",
    submittedAt: 10_000,
    upstreamFingerprint: fingerprintUpstreamPayload(fixtureSubmitPayload)
  });
  return {
    repository,
    job: repository.transition(submitting.id, ["submitting"], {
      status: "discovering",
      upstreamTaskId: "fixture-task",
      errorCode: "generation_discovery_read_failed"
    })
  };
}

function transportWithTask(task: unknown): {
  transport: LingjingTransport;
  read: ReturnType<typeof vi.fn>;
} {
  const read = vi.fn(() => Promise.resolve({ data: { task } }));
  return {
    transport: { read } as unknown as LingjingTransport,
    read
  };
}

describe("LingjingTaskPoller", () => {
  it.each([0, 1] as const)("persists a verified official status %s even while local output is pending", async (status) => {
    const { repository, job } = repositoryWithProcessingJob();
    const read = vi.fn((path: string) => Promise.resolve(path.includes("describeUserTask")
      ? { data: { task: { status, taskResults: [] } } }
      : { records: [] }));
    const poller = new LingjingTaskPoller({
      repository,
      transport: { read } as unknown as LingjingTransport,
      now: () => 15_000
    });

    try {
      const result = await poller.poll(job);
      expect(result.status).toBe("processing");
      expect(result.upstreamObservation).toMatchObject({
        state: "verified", checkedAt: 15_000, taskStatus: String(status)
      });
      expect(repository.findById(job.id)?.upstreamObservation).toEqual(result.upstreamObservation);
    } finally {
      repository.close();
    }
  });

  it("persists official completion alongside the usable output", async () => {
    const { repository, job } = repositoryWithProcessingJob();
    const { transport } = transportWithTask({ status: 1, videoUrl: "https://media.example/final.mp4" });
    const poller = new LingjingTaskPoller({ repository, transport, now: () => 15_000 });

    try {
      const result = await poller.poll(job);
      expect(result).toMatchObject({
        status: "completed",
        upstreamObservation: { state: "verified", checkedAt: 15_000, taskStatus: "1" },
        result: { outputs: [{ url: "https://media.example/final.mp4" }] }
      });
      expect(repository.findById(job.id)?.upstreamObservation).toEqual(result.upstreamObservation);
    } finally {
      repository.close();
    }
  });

  it("retains the official failure reason with a sanitized terminal diagnostic", async () => {
    const { repository, job } = repositoryWithProcessingJob();
    const { transport } = transportWithTask({
      status: 2,
      errMsg: "获取模型服务失败 token=private-token https://private.example/result",
      originError: { venderCode: "byteDance_seedance_video", errCode: "500:INTERNAL", errDesc: "获取模型服务失败" }
    });
    const poller = new LingjingTaskPoller({ repository, transport, now: () => 15_000 });

    try {
      const result = await poller.poll(job);
      expect(result).toMatchObject({
        status: "failed", errorCode: "lingjing_task_failed",
        upstreamObservation: { state: "verified", checkedAt: 15_000, taskStatus: "2" },
        errorDiagnostics: {
          taskStatus: "2", message: "获取模型服务失败 token=[REDACTED] [URL]",
          vendor: { code: "byteDance_seedance_video", errorCode: "500:INTERNAL", message: "获取模型服务失败" }
        }
      });
      expect(JSON.stringify(repository.findById(job.id)?.errorDiagnostics)).not.toContain("private-token");
    } finally {
      repository.close();
    }
  });

  it("preserves the official completion when the separate asset lookup is unavailable", async () => {
    const { repository, job } = repositoryWithProcessingJob();
    const read = vi.fn((path: string) => path.includes("describeUserTask")
      ? Promise.resolve({ data: { task: { status: 1, taskResults: [] } } })
      : Promise.reject(new Error("asset lookup unavailable")));
    const poller = new LingjingTaskPoller({ repository, transport: { read } as unknown as LingjingTransport, now: () => 15_000 });

    try {
      const result = await poller.poll(job);
      expect(result).toMatchObject({
        status: "processing", result: null,
        upstreamObservation: { state: "verified", checkedAt: 15_000, taskStatus: "1" }
      });
      expect(repository.findById(job.id)?.upstreamObservation).toEqual(result.upstreamObservation);
    } finally {
      repository.close();
    }
  });

  it("retains HTTP status and request ID after the official response envelope is unwrapped", async () => {
    const { repository, job } = repositoryWithProcessingJob();
    const response = unwrapEnvelope({
      requestId: "s-fixture-poll", error: null,
      result: { data: { task: { status: 0 } } }
    }, 200);
    const poller = new LingjingTaskPoller({
      repository, transport: { read: () => Promise.resolve(response) } as unknown as LingjingTransport, now: () => 15_000
    });

    try {
      const result = await poller.poll(job);
      expect(result.upstreamObservation).toMatchObject({
        state: "verified", checkedAt: 15_000, taskStatus: "0", httpStatusCode: 200, requestId: "s-fixture-poll"
      });
    } finally {
      repository.close();
    }
  });

  it.each([
    [0, "processing"],
    [1, "completed"],
    [2, "failed"]
  ] as const)("maps upstream status %s to %s", async (upstreamStatus, expectedStatus) => {
    const { repository, job } = repositoryWithProcessingJob();
    const { transport } = transportWithTask({
      status: upstreamStatus,
      taskResults: upstreamStatus === 1
        ? [{ imageUrl: "https://media.example/final.png" }]
        : [],
      errMsg: upstreamStatus === 2 ? "Sensitive upstream failure" : null
    });
    const poller = new LingjingTaskPoller({ repository, transport });

    const result = await poller.poll(job);

    expect(result.status).toBe(expectedStatus);
    repository.close();
  });

  it("uses the exact non-v1 task endpoint and nested body", async () => {
    const { repository, job } = repositoryWithProcessingJob();
    const { transport, read } = transportWithTask({ status: 0 });
    const poller = new LingjingTaskPoller({ repository, transport });

    await poller.poll(job);

    expect(read).toHaveBeenCalledWith(
      "/openApi/modelmarket/describeUserTask",
      {
        method: "POST",
        body: { params: { taskId: "fixture-task" } }
      }
    );
    repository.close();
  });

  it("clears a recovered unknown error when polling resumes processing", async () => {
    const { repository, job } = repositoryWithUnknownJob();
    const { transport } = transportWithTask({ status: 0 });
    const poller = new LingjingTaskPoller({ repository, transport });

    try {
      const result = await poller.poll(job);

      expect(result).toMatchObject({
        status: "processing",
        errorCode: null
      });
    } finally {
      repository.close();
    }
  });

  it("preserves a discovering error when polling starts processing", async () => {
    const { repository, job } = repositoryWithDiscoveringErrorJob();
    const { transport } = transportWithTask({ status: 0 });
    const poller = new LingjingTaskPoller({ repository, transport });

    try {
      const result = await poller.poll(job);

      expect(result).toMatchObject({
        status: "processing",
        errorCode: "generation_discovery_read_failed"
      });
    } finally {
      repository.close();
    }
  });

  it("clears a recovered unknown error when polling completes", async () => {
    const { repository, job } = repositoryWithUnknownJob();
    const { transport } = transportWithTask({
      status: 1,
      taskResults: [{ imageUrl: "https://media.example/final.png" }]
    });
    const poller = new LingjingTaskPoller({ repository, transport });

    try {
      const result = await poller.poll(job);

      expect(result).toMatchObject({
        status: "completed",
        errorCode: null
      });
    } finally {
      repository.close();
    }
  });

  it("keeps status one without media recoverable and consults assets", async () => {
    const { repository, job } = repositoryWithProcessingJob();
    const read = vi.fn((path: string) => Promise.resolve(path.includes("describeUserTask")
      ? { data: { task: { status: 1, taskResults: [] } } }
      : { records: [] }));
    const poller = new LingjingTaskPoller({
      repository,
      transport: { read } as unknown as LingjingTransport
    });

    const result = await poller.poll(job);

    expect(result.status).toBe("processing");
    expect(read).toHaveBeenCalledWith(
      "/joycreator/space/asset/list",
      expect.any(Object)
    );
    repository.close();
  });

  it("does not bind a same-payload asset owned by another known task", async () => {
    const { repository, job } = repositoryWithProcessingJob();
    const read = vi.fn((path: string) => Promise.resolve(
      path.includes("describeUserTask")
        ? { data: { task: { status: 1, taskResults: [] } } }
        : {
            records: [{
              id: "different-task-asset",
              scene: "image-generation",
              modelCode: "model-v1",
              createTime: 10_100,
              taskId: "fixture-different-task",
              reqParam: fixtureSubmitPayload,
              imageUrl: "https://media.example/wrong.png",
              status: 1
            }]
          }
    ));
    const poller = new LingjingTaskPoller({
      repository,
      transport: { read } as unknown as LingjingTransport
    });

    try {
      const result = await poller.poll(job);

      expect(result.status).toBe("processing");
      expect(result.result).toBeNull();
    } finally {
      repository.close();
    }
  });

  it("binds an asset owned by the exact known task", async () => {
    const { repository, job } = repositoryWithProcessingJob();
    const read = vi.fn((path: string) => Promise.resolve(
      path.includes("describeUserTask")
        ? { data: { task: { status: 1, taskResults: [] } } }
        : {
            records: [{
              id: "exact-task-asset",
              scene: "image-generation",
              modelCode: "model-v1",
              createTime: 10_100,
              taskId: "fixture-task",
              reqParam: fixtureSubmitPayload,
              imageUrl: "https://media.example/final.png",
              status: 1
            }]
          }
    ));
    const poller = new LingjingTaskPoller({
      repository,
      transport: { read } as unknown as LingjingTransport
    });

    try {
      const result = await poller.poll(job);

      expect(result).toMatchObject({
        status: "completed",
        result: {
          outputs: [{
            url: "https://media.example/final.png"
          }]
        }
      });
    } finally {
      repository.close();
    }
  });

  it("leaves the persisted job recoverable when polling reads fail", async () => {
    const { repository, job } = repositoryWithProcessingJob();
    const poller = new LingjingTaskPoller({
      repository,
      transport: {
        read: vi.fn(() => Promise.reject(new Error("read retries exhausted")))
      } as unknown as LingjingTransport
    });

    await expect(poller.poll(job)).rejects.toThrowError("read retries exhausted");
    expect(repository.findById(job.id)?.status).toBe("processing");
    repository.close();
  });
});
