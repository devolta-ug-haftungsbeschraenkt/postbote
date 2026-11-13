import type { Sql } from 'postgres'

/**
 * Queue contract. Production: Postgres `jobs`-Tabelle mit
 * `FOR UPDATE SKIP LOCKED` (Bauplan §2 — Postgres-only, Redis später optional).
 * Tests/Demo: MemoryJobQueue mit identischer Semantik (Attempts + Backoff).
 */

export type JobType = 'send_email' | 'dispatch_webhook'

export interface Job {
  id: string
  type: JobType
  payload: Record<string, unknown>
  attempts: number
  maxAttempts: number
}

export interface JobResult {
  /** true → job failed temporarily, reschedule with backoff. */
  retry: boolean
  error?: string
}

export type JobHandler = (job: Job) => Promise<JobResult>

/** Exponential backoff: 30s, 60s, 120s … capped at 15 min (Bauplan §4). */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000)
}

export interface JobQueue {
  enqueue(job: { type: string; payload: Record<string, unknown> }): Promise<void>
  registerHandler(type: JobType, handler: JobHandler): void
  start(): Promise<void>
  stop(): Promise<void>
}

export class MemoryJobQueue implements JobQueue {
  private readonly handlers = new Map<JobType, JobHandler>()
  private readonly pending: {
    job: Job
    runAfter: number
    timer: ReturnType<typeof setTimeout> | null
  }[] = []
  private stopped = false

  constructor(private readonly log: (msg: string) => void = () => {}) {}

  registerHandler(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler)
  }

  async enqueue(job: { type: string; payload: Record<string, unknown> }): Promise<void> {
    const full: Job = {
      id: crypto.randomUUID(),
      type: job.type as JobType,
      payload: job.payload,
      attempts: 0,
      maxAttempts: 10,
    }
    const entry = {
      job: full,
      runAfter: Date.now(),
      timer: null as ReturnType<typeof setTimeout> | null,
    }
    this.pending.push(entry)
    this.schedule(entry, 0)
  }

  private schedule(
    entry: { job: Job; runAfter: number; timer: ReturnType<typeof setTimeout> | null },
    delayMs: number,
  ): void {
    if (this.stopped) return
    entry.timer = setTimeout(() => {
      void this.process(entry)
    }, delayMs)
  }

  private async process(entry: {
    job: Job
    runAfter: number
    timer: ReturnType<typeof setTimeout> | null
  }): Promise<void> {
    if (this.stopped) return
    const handler = this.handlers.get(entry.job.type)
    if (!handler) {
      this.log(`no handler for job type ${entry.job.type}`)
      return
    }
    entry.job.attempts++
    try {
      const result = await handler(entry.job)
      if (result.retry && entry.job.attempts < entry.job.maxAttempts) {
        const delay = backoffMs(entry.job.attempts)
        this.log(
          `job ${entry.job.type} ${entry.job.id} deferred (attempt ${entry.job.attempts}), retry in ${delay}ms: ${result.error ?? ''}`,
        )
        entry.runAfter = Date.now() + delay
        this.schedule(entry, delay)
        return
      }
      if (result.retry) {
        this.log(
          `job ${entry.job.id} dead after ${entry.job.attempts} attempts: ${result.error ?? ''}`,
        )
      }
    } catch (err) {
      this.log(`job ${entry.job.id} threw: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      const index = this.pending.indexOf(entry)
      if (index >= 0) this.pending.splice(index, 1)
    }
  }

  async start(): Promise<void> {
    this.stopped = false
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const entry of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
    }
  }
}

/**
 * Postgres queue: `FOR UPDATE SKIP LOCKED` so multiple workers can run
 * concurrently without double-sending (Bauplan §2).
 */
export class PostgresJobQueue implements JobQueue {
  private readonly handlers = new Map<JobType, JobHandler>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(
    private readonly sql: Sql,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  registerHandler(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler)
  }

  async enqueue(job: { type: string; payload: Record<string, unknown> }): Promise<void> {
    await this.sql`
      INSERT INTO jobs (id, type, payload, status, max_attempts)
      VALUES (${crypto.randomUUID()}, ${job.type}, ${sqlJson(job.payload)}, 'pending', 10)
    `
  }

  async start(): Promise<void> {
    this.stopped = false
    this.pollTimer = setInterval(() => void this.claimAndRun(), 1_000)
    void this.claimAndRun()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
  }

  private async claimAndRun(): Promise<void> {
    if (this.stopped) return
    const rows = await this.sql`
      WITH next_job AS (
        SELECT id FROM jobs
        WHERE status = 'pending' AND run_after <= now()
        FOR UPDATE SKIP LOCKED
        LIMIT 5
      )
      UPDATE jobs j
      SET status = 'processing', locked_at = now(), attempts = j.attempts + 1
      FROM next_job
      WHERE j.id = next_job.id
      RETURNING j.id, j.type, j.payload, j.attempts, j.max_attempts
    `
    interface ClaimedJobRow {
      id: string
      type: string
      payload: Record<string, unknown>
      attempts: number
      max_attempts: number
    }
    for (const row of rows as unknown as ClaimedJobRow[]) {
      const job: Job = {
        id: row.id,
        type: row.type as JobType,
        payload: row.payload as Record<string, unknown>,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
      }
      const handler = this.handlers.get(job.type)
      if (!handler) {
        this.log(`no handler for job type ${job.type}`)
        await this.sql`UPDATE jobs SET status = 'failed' WHERE id = ${job.id}`
        continue
      }
      let result: JobResult
      try {
        result = await handler(job)
      } catch (err) {
        result = { retry: true, error: err instanceof Error ? err.message : String(err) }
      }
      if (result.retry && job.attempts < job.maxAttempts) {
        await this.sql`
          UPDATE jobs
          SET status = 'pending',
              run_after = now() + make_interval(secs => ${backoffMs(job.attempts) / 1000})
          WHERE id = ${job.id}
        `
      } else if (result.retry) {
        this.log(`job ${job.id} dead after ${job.attempts} attempts: ${result.error ?? ''}`)
        await this.sql`UPDATE jobs SET status = 'failed' WHERE id = ${job.id}`
      } else {
        await this.sql`UPDATE jobs SET status = 'done' WHERE id = ${job.id}`
      }
    }
  }
}

function sqlJson(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}
