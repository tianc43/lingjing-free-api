import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LingjingTaskPoller } from "../../src/jobs/poller.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import type { JobRecord, NewJob } from "../../src/jobs/types.js";
import type { LingjingTransport } from "../../src/lingjing/types.js";
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
    upstreamFingerprint: "b".repeat(64)
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
    upstreamFingerprint: "b".repeat(64)
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
