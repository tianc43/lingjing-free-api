import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobRunnerRegistry } from "../../src/generation/runner-registry.js";
import {
  createSignalStopHandler,
  shutdownServer
} from "../../src/index.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";

describe("shutdownServer", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "lingjing-shutdown-"));
    directories.push(directory);
    const repository = new SqliteJobRepository(
      join(directory, "jobs.sqlite")
    );
    const registry = new JobRunnerRegistry();
    const events: string[] = [];
    return {
      repository,
      registry,
      events,
      app: {
        close: vi.fn(() => {
          events.push("http-close");
          return Promise.resolve();
        }),
        server: {
          closeAllConnections: vi.fn(() => {
            events.push("connections-close");
          })
        }
      },
      coordinator: {
        stopPollers: vi.fn(() => {
          events.push("pollers-stop");
        })
      },
      recovery: {
        close: vi.fn(() => {
          events.push("recovery-close");
        })
      },
      logger: {
        warn: vi.fn()
      }
    };
  }

  it("leaves SQLite open when submit draining times out and closes on retry", async () => {
    const app = fixture();
    const reservation = app.registry.reserveSubmitCriticalSection();

    await expect(shutdownServer({
      ...app,
      submitDrainTimeoutMs: 5,
      runnerIdleTimeoutMs: 100
    })).rejects.toThrow("Timed out draining submit critical sections");

    expect(app.repository.findById("missing")).toBeNull();
    expect(app.coordinator.stopPollers).not.toHaveBeenCalled();
    expect(app.recovery.close).not.toHaveBeenCalled();
    reservation.cancel();

    await shutdownServer({
      ...app,
      submitDrainTimeoutMs: 100,
      runnerIdleTimeoutMs: 100
    });

    expect(app.events).toEqual([
      "http-close",
      "http-close",
      "recovery-close",
      "pollers-stop",
      "connections-close"
    ]);
    expect(() => app.repository.findById("missing")).toThrow(
      "Job repository is closed"
    );
  });

  it("never closes SQLite when a runner remains active after poller abort", async () => {
    const app = fixture();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.registry.startOnce("blocked-poller", () => blocked);

    await expect(shutdownServer({
      ...app,
      submitDrainTimeoutMs: 100,
      runnerIdleTimeoutMs: 5
    })).rejects.toThrow("Timed out waiting for job runners");

    expect(app.repository.findById("missing")).toBeNull();
    release?.();
    await app.registry.waitUntilIdle();

    await shutdownServer({
      ...app,
      submitDrainTimeoutMs: 100,
      runnerIdleTimeoutMs: 100
    });
    expect(() => app.repository.findById("missing")).toThrow(
      "Job repository is closed"
    );
  });

  it("allows a later signal to retry after a fail-safe stop rejection", async () => {
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error("drain timed out"))
      .mockResolvedValueOnce(undefined);
    const logger = { error: vi.fn() };
    const target: { exitCode?: number } = {};
    const onSignal = createSignalStopHandler({
      stop,
      dependencies: { logger }
    }, target);

    onSignal();
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledOnce();
    });
    expect(target.exitCode).toBe(1);

    onSignal();
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledTimes(2);
    });
  });
});
