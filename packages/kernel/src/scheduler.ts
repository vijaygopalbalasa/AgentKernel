// Scheduler — Simple job scheduler for AgentRun
// Provides interval-based recurring jobs with error handling and graceful shutdown

import { z } from "zod";
import { createLogger, type Logger } from "./logger.js";

/** Job status enumeration */
export type JobStatus = "pending" | "running" | "paused" | "stopped" | "error";

/** Job configuration schema */
export const JobConfigSchema = z.object({
  /** Unique job identifier */
  id: z.string().min(1),
  /** Human-readable job name */
  name: z.string().min(1),
  /** Interval between runs in milliseconds */
  intervalMs: z.number().int().positive(),
  /** Initial delay before first run (default: 0) */
  initialDelayMs: z.number().int().nonnegative().default(0),
  /** Run immediately on start (default: false) */
  runImmediately: z.boolean().default(false),
  /** Maximum consecutive failures before pausing (0 = unlimited) */
  maxConsecutiveFailures: z.number().int().nonnegative().default(3),
  /** Enabled state (default: true) */
  enabled: z.boolean().default(true),
});

export type JobConfig = z.infer<typeof JobConfigSchema>;

/** Job handler function */
export type JobHandler = () => Promise<void> | void;

/** Registered job with runtime state */
export interface Job {
  config: JobConfig;
  handler: JobHandler;
  status: JobStatus;
  lastRun?: Date;
  lastError?: string;
  consecutiveFailures: number;
  runCount: number;
  timer?: NodeJS.Timeout;
}

/** Job execution result for listeners */
export interface JobExecutionResult {
  jobId: string;
  status: "success" | "failure";
  duration: number;
  error?: string;
  timestamp: Date;
}

/** Job event listener */
export type JobEventListener = (result: JobExecutionResult) => void;

/** Scheduler configuration */
export interface SchedulerConfig {
  /** Log job executions (default: true) */
  logExecutions?: boolean;
  /** Default interval for jobs without explicit interval (default: 60000ms) */
  defaultIntervalMs?: number;
  /** Grace period for shutdown in ms (default: 5000) */
  shutdownGracePeriodMs?: number;
}

/**
 * Simple job scheduler for recurring tasks.
 * Features:
 * - Interval-based scheduling
 * - Error handling with consecutive failure tracking
 * - Graceful shutdown
 * - Job pause/resume
 * - Execution events
 */
export class Scheduler {
  private jobs: Map<string, Job> = new Map();
  private listeners: JobEventListener[] = [];
  private running = false;
  private log: Logger;
  private config: Required<SchedulerConfig>;

  constructor(config: SchedulerConfig = {}) {
    this.log = createLogger({ name: "scheduler" });
    this.config = {
      logExecutions: config.logExecutions ?? true,
      defaultIntervalMs: config.defaultIntervalMs ?? 60000,
      shutdownGracePeriodMs: config.shutdownGracePeriodMs ?? 5000,
    };
  }

  /**
   * Register a new job.
   */
  register(config: Partial<JobConfig> & { id: string; name: string }, handler: JobHandler): void {
    const fullConfig = JobConfigSchema.parse({
      intervalMs: this.config.defaultIntervalMs,
      ...config,
    });

    if (this.jobs.has(fullConfig.id)) {
      this.log.warn("Job already registered, replacing", { jobId: fullConfig.id });
      this.unregister(fullConfig.id);
    }

    const job: Job = {
      config: fullConfig,
      handler,
      status: "pending",
      consecutiveFailures: 0,
      runCount: 0,
    };

    this.jobs.set(fullConfig.id, job);
    this.log.info("Job registered", { jobId: fullConfig.id, name: fullConfig.name, intervalMs: fullConfig.intervalMs });

    // Auto-start if scheduler is running and job is enabled
    if (this.running && fullConfig.enabled) {
      this.startJob(job);
    }
  }

  /**
   * Unregister a job.
   */
  unregister(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    this.stopJob(job);
    this.jobs.delete(jobId);
    this.log.info("Job unregistered", { jobId });
    return true;
  }

  /**
   * Start the scheduler.
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.log.info("Scheduler started", { jobCount: this.jobs.size });

    for (const job of this.jobs.values()) {
      if (job.config.enabled) {
        this.startJob(job);
      }
    }
  }

  /**
   * Stop the scheduler gracefully.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    this.log.info("Scheduler stopping", { jobCount: this.jobs.size });

    // Stop all jobs
    for (const job of this.jobs.values()) {
      this.stopJob(job);
    }

    // Wait for any running jobs to complete (with timeout)
    const runningJobs = Array.from(this.jobs.values()).filter((j) => j.status === "running");
    if (runningJobs.length > 0) {
      this.log.info("Waiting for running jobs", { count: runningJobs.length });
      await new Promise((resolve) => setTimeout(resolve, this.config.shutdownGracePeriodMs));
    }

    this.log.info("Scheduler stopped");
  }

  /**
   * Pause a specific job.
   */
  pause(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    this.stopJob(job);
    job.status = "paused";
    this.log.info("Job paused", { jobId });
    return true;
  }

  /**
   * Resume a paused job.
   */
  resume(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "paused") return false;

    job.consecutiveFailures = 0;
    if (this.running) {
      this.startJob(job);
    }
    this.log.info("Job resumed", { jobId });
    return true;
  }

  /**
   * Trigger a job to run immediately (outside of schedule).
   */
  async trigger(jobId: string): Promise<JobExecutionResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return {
        jobId,
        status: "failure",
        duration: 0,
        error: "Job not found",
        timestamp: new Date(),
      };
    }

    return this.executeJob(job);
  }

  /**
   * Get job status.
   */
  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * List all jobs.
   */
  listJobs(): Job[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Check if scheduler is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Subscribe to job execution events.
   */
  onExecution(listener: JobEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /** Start a job's timer */
  private startJob(job: Job): void {
    const config = job.config;

    // Handle initial execution
    const scheduleExecution = () => {
      job.timer = setInterval(async () => {
        await this.executeJob(job);
      }, config.intervalMs);
      job.status = "pending";
    };

    if (config.runImmediately) {
      this.executeJob(job).then(() => {
        if (this.running && job.status !== "paused" && job.status !== "stopped") {
          scheduleExecution();
        }
      }).catch((error) => {
        this.log.error("Initial job execution failed", {
          jobId: job.config.id,
          error: error instanceof Error ? error.message : String(error),
        });
        if (this.running && job.status !== "paused" && job.status !== "stopped") {
          scheduleExecution();
        }
      });
    } else if (config.initialDelayMs > 0) {
      job.timer = setTimeout(() => {
        if (this.running && job.status !== "paused" && job.status !== "stopped") {
          scheduleExecution();
          this.executeJob(job);
        }
      }, config.initialDelayMs);
      job.status = "pending";
    } else {
      scheduleExecution();
    }

    this.log.debug("Job started", { jobId: config.id, intervalMs: config.intervalMs });
  }

  /** Stop a job's timer */
  private stopJob(job: Job): void {
    if (job.timer) {
      clearInterval(job.timer);
      clearTimeout(job.timer);
      job.timer = undefined;
    }
    if (job.status !== "paused") {
      job.status = "stopped";
    }
  }

  /** Execute a job */
  private async executeJob(job: Job): Promise<JobExecutionResult> {
    const startTime = Date.now();
    job.status = "running";
    job.lastRun = new Date();
    job.runCount++;

    let result: JobExecutionResult;

    try {
      await job.handler();

      job.consecutiveFailures = 0;
      job.lastError = undefined;
      job.status = "pending";

      result = {
        jobId: job.config.id,
        status: "success",
        duration: Date.now() - startTime,
        timestamp: new Date(),
      };

      if (this.config.logExecutions) {
        this.log.debug("Job completed", {
          jobId: job.config.id,
          duration: result.duration,
          runCount: job.runCount,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.consecutiveFailures++;
      job.lastError = message;

      result = {
        jobId: job.config.id,
        status: "failure",
        duration: Date.now() - startTime,
        error: message,
        timestamp: new Date(),
      };

      this.log.warn("Job failed", {
        jobId: job.config.id,
        error: message,
        consecutiveFailures: job.consecutiveFailures,
        maxAllowed: job.config.maxConsecutiveFailures,
      });

      // Auto-pause if too many consecutive failures
      if (
        job.config.maxConsecutiveFailures > 0 &&
        job.consecutiveFailures >= job.config.maxConsecutiveFailures
      ) {
        this.stopJob(job);
        job.status = "error";
        this.log.error("Job auto-paused due to consecutive failures", {
          jobId: job.config.id,
          failures: job.consecutiveFailures,
        });
      } else {
        job.status = "pending";
      }
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(result);
      } catch {
        // Ignore listener errors
      }
    }

    return result;
  }
}

/** Global scheduler instance */
let globalScheduler: Scheduler | undefined;

/**
 * Get or create the global scheduler instance.
 */
export function getScheduler(config?: SchedulerConfig): Scheduler {
  if (!globalScheduler) {
    globalScheduler = new Scheduler(config);
  }
  return globalScheduler;
}

/**
 * Reset the global scheduler (for testing).
 */
export async function resetScheduler(): Promise<void> {
  if (globalScheduler) {
    await globalScheduler.stop();
    globalScheduler = undefined;
  }
}

/**
 * Create a new scheduler instance.
 */
export function createScheduler(config?: SchedulerConfig): Scheduler {
  return new Scheduler(config);
}
