import { describe, expect, it, vi } from "vitest";
import { ArchiveRecoveryWorker } from "../../src/jobs/archive-recovery-worker.js";

describe("archive recovery", () => {
  it("retries due completed outputs without resubmitting", async () => {
    const output = { url:"https://upstream/v.mp4", posterUrl:null, width:null, height:null, duration:5, format:"mp4" };
    const job = { id:"job", userId:"u", projectId:"p", result:{ outputs:[output] } };
    const replace = vi.fn();
    const archiveAll = vi.fn(() => Promise.resolve([{ ...output, url:"/v1/assets/asset" }]));
    const repository = {
      archiveDue: () => [job],
      findById: () => null,
      replaceArchivedResult: replace,
      markArchiveFailure: vi.fn()
    };
    const worker = new ArchiveRecoveryWorker(repository as never, { archiveAll });
    expect(await worker.scan()).toEqual({ completed:1, failed:0 });
    expect(replace).toHaveBeenCalledWith("job", { outputs:[expect.objectContaining({ url:"/v1/assets/asset" })] },undefined);
    expect(archiveAll).toHaveBeenCalledTimes(1);
  });
});
