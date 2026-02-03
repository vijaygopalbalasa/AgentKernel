import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JobRunner } from "../job-runner.js";

describe("JobRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it("runs jobs on interval", async () => {
    const runner = new JobRunner({ logExecutions: false });
    let runs = 0;

    runner.register(
      { id: "job-1", name: "Job 1", intervalMs: 1000 },
      () => {
        runs += 1;
      }
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(3100);

    expect(runs).toBeGreaterThanOrEqual(3);
    await runner.stop();
  });

  it("prevents overlapping executions", async () => {
    const runner = new JobRunner({ logExecutions: false });
    let runs = 0;
    let resolveRun: (() => void) | null = null;

    runner.register(
      { id: "job-2", name: "Job 2", intervalMs: 1000 },
      () => {
        runs += 1;
        return new Promise<void>((resolve) => {
          resolveRun = resolve;
        });
      }
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(3000);

    expect(runs).toBe(1);

    resolveRun?.();
    await vi.advanceTimersByTimeAsync(1000);

    expect(runs).toBe(2);
    await runner.stop();
  });
});
