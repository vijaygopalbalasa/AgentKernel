// Job Runner — Runtime background job orchestration using kernel Scheduler
// Provides safe execution (no overlap) and lifecycle controls

import {
  type JobConfig,
  type JobExecutionResult,
  type JobEventListener,
  type SchedulerConfig,
  createScheduler,
} from "@agentkernel/kernel";
import { createLogger } from "@agentkernel/kernel";

export interface JobRunnerConfig extends SchedulerConfig {
  lockProvider?: JobLockProvider;
}

export type JobLockRelease = () => Promise<void> | void;
export type JobLockProvider = (jobId: string) => Promise<JobLockRelease | null>;

export interface JobRunnerJobConfig extends Partial<JobConfig> {
  id: string;
  name: string;
  intervalMs: number;
}

export class JobRunner {
  private scheduler = createScheduler({ logExecutions: false });
  private activeJobs = new Set<string>();
  private log = createLogger({ name: "job-runner" });
  private lockProvider?: JobLockProvider;

  constructor(config: JobRunnerConfig = {}) {
    this.scheduler = createScheduler({
      logExecutions: config.logExecutions ?? false,
      defaultIntervalMs: config.defaultIntervalMs ?? 60000,
      shutdownGracePeriodMs: config.shutdownGracePeriodMs ?? 5000,
    });
    this.lockProvider = config.lockProvider;
  }

  start(): void {
    this.scheduler.start();
  }

  async stop(): Promise<void> {
    await this.scheduler.stop();
    this.activeJobs.clear();
  }

  register(config: JobRunnerJobConfig, handler: () => Promise<void> | void): void {
    this.scheduler.register(config, async () => {
      if (this.activeJobs.has(config.id)) {
        this.log.warn("Job skipped due to overlapping run", { jobId: config.id });
        return;
      }

      this.activeJobs.add(config.id);
      let releaseLock: JobLockRelease | null = null;
      try {
        if (this.lockProvider) {
          releaseLock = await this.lockProvider(config.id);
          if (!releaseLock) {
            this.log.debug("Job lock not acquired; skipping run", { jobId: config.id });
            return;
          }
        }
        await handler();
      } finally {
        if (releaseLock) {
          try {
            await releaseLock();
          } catch (error) {
            this.log.warn("Job lock release failed", {
              jobId: config.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        this.activeJobs.delete(config.id);
      }
    });
  }

  unregister(jobId: string): boolean {
    return this.scheduler.unregister(jobId);
  }

  pause(jobId: string): boolean {
    return this.scheduler.pause(jobId);
  }

  resume(jobId: string): boolean {
    return this.scheduler.resume(jobId);
  }

  async trigger(jobId: string): Promise<JobExecutionResult> {
    return this.scheduler.trigger(jobId);
  }

  listJobs() {
    return this.scheduler.listJobs();
  }

  onExecution(listener: JobEventListener): () => void {
    return this.scheduler.onExecution(listener);
  }
}
