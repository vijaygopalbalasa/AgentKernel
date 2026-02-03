// Scheduler tests
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  Scheduler,
  createScheduler,
  getScheduler,
  resetScheduler,
  JobConfigSchema,
  type JobExecutionResult,
} from "./scheduler.js";

describe("Scheduler", () => {
  let scheduler: Scheduler;

  beforeEach(async () => {
    await resetScheduler();
    scheduler = createScheduler({ logExecutions: false });
  });

  afterEach(async () => {
    await scheduler.stop();
  });

  describe("register", () => {
    it("should register a job", () => {
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 1000 },
        () => {}
      );

      const job = scheduler.getJob("test-job");
      expect(job).toBeDefined();
      expect(job?.config.id).toBe("test-job");
      expect(job?.config.name).toBe("Test Job");
      expect(job?.status).toBe("pending");
    });

    it("should replace existing job with same id", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      scheduler.register(
        { id: "test-job", name: "Test Job 1", intervalMs: 1000 },
        handler1
      );
      scheduler.register(
        { id: "test-job", name: "Test Job 2", intervalMs: 2000 },
        handler2
      );

      const job = scheduler.getJob("test-job");
      expect(job?.config.name).toBe("Test Job 2");
      expect(job?.config.intervalMs).toBe(2000);
    });

    it("should use default interval if not specified", () => {
      const customScheduler = createScheduler({ defaultIntervalMs: 5000 });
      customScheduler.register({ id: "test-job", name: "Test Job" }, () => {});

      const job = customScheduler.getJob("test-job");
      expect(job?.config.intervalMs).toBe(5000);
    });
  });

  describe("unregister", () => {
    it("should unregister a job", () => {
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 1000 },
        () => {}
      );

      const result = scheduler.unregister("test-job");

      expect(result).toBe(true);
      expect(scheduler.getJob("test-job")).toBeUndefined();
    });

    it("should return false for nonexistent job", () => {
      const result = scheduler.unregister("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("start/stop", () => {
    it("should start the scheduler", () => {
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
    });

    it("should stop the scheduler", async () => {
      scheduler.start();
      await scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });

    it("should auto-start jobs on scheduler start", async () => {
      const handler = vi.fn();
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 50, runImmediately: true },
        handler
      );

      scheduler.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(handler).toHaveBeenCalled();
    });

    it("should not run disabled jobs", async () => {
      const handler = vi.fn();
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 50, enabled: false, runImmediately: true },
        handler
      );

      scheduler.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("pause/resume", () => {
    it("should pause a job", () => {
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 1000 },
        () => {}
      );
      scheduler.start();

      const result = scheduler.pause("test-job");

      expect(result).toBe(true);
      expect(scheduler.getJob("test-job")?.status).toBe("paused");
    });

    it("should resume a paused job", () => {
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 1000 },
        () => {}
      );
      scheduler.start();
      scheduler.pause("test-job");

      const result = scheduler.resume("test-job");

      expect(result).toBe(true);
      const job = scheduler.getJob("test-job");
      expect(job?.status).not.toBe("paused");
    });

    it("should return false for nonexistent job", () => {
      expect(scheduler.pause("nonexistent")).toBe(false);
      expect(scheduler.resume("nonexistent")).toBe(false);
    });
  });

  describe("trigger", () => {
    it("should trigger immediate job execution", async () => {
      const handler = vi.fn();
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 10000 },
        handler
      );

      const result = await scheduler.trigger("test-job");

      expect(result.status).toBe("success");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should return error for nonexistent job", async () => {
      const result = await scheduler.trigger("nonexistent");

      expect(result.status).toBe("failure");
      expect(result.error).toContain("not found");
    });

    it("should handle job errors", async () => {
      const handler = vi.fn(() => {
        throw new Error("Test error");
      });
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 10000 },
        handler
      );

      const result = await scheduler.trigger("test-job");

      expect(result.status).toBe("failure");
      expect(result.error).toBe("Test error");
    });
  });

  describe("job execution", () => {
    it("should run jobs at specified interval", async () => {
      const handler = vi.fn();
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 50 },
        handler
      );

      scheduler.start();
      await new Promise((resolve) => setTimeout(resolve, 180));

      expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("should track run count", async () => {
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 50 },
        () => {}
      );
      scheduler.start();
      await new Promise((resolve) => setTimeout(resolve, 180));

      const job = scheduler.getJob("test-job");
      expect(job?.runCount).toBeGreaterThanOrEqual(2);
    });

    it("should track last run time", async () => {
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 50, runImmediately: true },
        () => {}
      );
      scheduler.start();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const job = scheduler.getJob("test-job");
      expect(job?.lastRun).toBeInstanceOf(Date);
    });

    it("should track consecutive failures", async () => {
      let callCount = 0;
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 10000, maxConsecutiveFailures: 0 },
        () => {
          callCount++;
          throw new Error("Intentional failure");
        }
      );

      await scheduler.trigger("test-job");
      await scheduler.trigger("test-job");

      const job = scheduler.getJob("test-job");
      expect(job?.consecutiveFailures).toBe(2);
      expect(job?.lastError).toBe("Intentional failure");
    });

    it("should auto-pause after max consecutive failures", async () => {
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 10000, maxConsecutiveFailures: 2 },
        () => {
          throw new Error("Failure");
        }
      );

      await scheduler.trigger("test-job");
      await scheduler.trigger("test-job");

      const job = scheduler.getJob("test-job");
      expect(job?.status).toBe("error");
    });

    it("should reset consecutive failures on success", async () => {
      let shouldFail = true;
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 10000, maxConsecutiveFailures: 3 },
        () => {
          if (shouldFail) throw new Error("Failure");
        }
      );

      await scheduler.trigger("test-job");
      expect(scheduler.getJob("test-job")?.consecutiveFailures).toBe(1);

      shouldFail = false;
      await scheduler.trigger("test-job");
      expect(scheduler.getJob("test-job")?.consecutiveFailures).toBe(0);
    });
  });

  describe("event listeners", () => {
    it("should notify listeners on job execution", async () => {
      const results: JobExecutionResult[] = [];
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 10000 },
        () => {}
      );
      scheduler.onExecution((result) => results.push(result));

      await scheduler.trigger("test-job");

      expect(results).toHaveLength(1);
      expect(results[0]?.jobId).toBe("test-job");
      expect(results[0]?.status).toBe("success");
    });

    it("should allow unsubscribing", async () => {
      const results: JobExecutionResult[] = [];
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 10000 },
        () => {}
      );
      const unsubscribe = scheduler.onExecution((result) => results.push(result));

      unsubscribe();
      await scheduler.trigger("test-job");

      expect(results).toHaveLength(0);
    });
  });

  describe("listJobs", () => {
    it("should list all registered jobs", () => {
      scheduler.register({ id: "job-1", name: "Job 1", intervalMs: 1000 }, () => {});
      scheduler.register({ id: "job-2", name: "Job 2", intervalMs: 2000 }, () => {});

      const jobs = scheduler.listJobs();

      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.config.id)).toContain("job-1");
      expect(jobs.map((j) => j.config.id)).toContain("job-2");
    });
  });

  describe("runImmediately option", () => {
    it("should run job immediately when enabled", async () => {
      const handler = vi.fn();
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 10000, runImmediately: true },
        handler
      );

      scheduler.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("initialDelayMs option", () => {
    it("should delay first execution", async () => {
      const handler = vi.fn();
      scheduler.register(
        { id: "test-job", name: "Test Job", intervalMs: 1000, initialDelayMs: 100 },
        handler
      );

      scheduler.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(handler).not.toHaveBeenCalled();

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(handler).toHaveBeenCalled();
    });
  });
});

describe("JobConfigSchema", () => {
  it("should validate valid config", () => {
    const config = {
      id: "test-job",
      name: "Test Job",
      intervalMs: 1000,
    };

    const result = JobConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("should apply defaults", () => {
    const config = {
      id: "test-job",
      name: "Test Job",
      intervalMs: 1000,
    };

    const result = JobConfigSchema.parse(config);
    expect(result.initialDelayMs).toBe(0);
    expect(result.runImmediately).toBe(false);
    expect(result.maxConsecutiveFailures).toBe(3);
    expect(result.enabled).toBe(true);
  });

  it("should reject invalid interval", () => {
    const config = {
      id: "test-job",
      name: "Test Job",
      intervalMs: -1,
    };

    const result = JobConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("Global scheduler functions", () => {
  afterEach(async () => {
    await resetScheduler();
  });

  it("should create singleton scheduler", () => {
    const scheduler1 = getScheduler();
    const scheduler2 = getScheduler();
    expect(scheduler1).toBe(scheduler2);
  });

  it("should reset singleton scheduler", async () => {
    const scheduler1 = getScheduler();
    scheduler1.start();

    await resetScheduler();

    const scheduler2 = getScheduler();
    expect(scheduler2).not.toBe(scheduler1);
    expect(scheduler2.isRunning()).toBe(false);
  });
});
