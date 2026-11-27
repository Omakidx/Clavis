// Background jobs in the API process (docs/clavis-sync-design.md §6.5): setInterval loops, each guarded by a
// session-level pg_try_advisory_lock so a second replica would be harmless. JOBS_ENABLED=0 never starts them.
import type { DbHandle } from '../db/client';
import type { Logger } from '../logger';
import type { ObjectStorage } from '../storage/types';
import { LOCK_IDS, withAdvisoryLock } from './lock';
import { expireUploads, runObjectDeletions, runPurge, sweepOrphans } from './tasks';

export { LOCK_IDS, withAdvisoryLock } from './lock';
export { expireUploads, runObjectDeletions, runPurge, sweepOrphans } from './tasks';

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface JobsHandle {
  /** Stop scheduling and wait for runs already in flight. */
  stop(): Promise<void>;
}

interface JobSpec {
  name: string;
  lockId: number;
  intervalMs: number;
  /** First run after this delay: soon after boot, staggered so jobs do not start together. */
  initialDelayMs: number;
  run: () => Promise<unknown>;
}

export function startJobs(opts: {
  handle: DbHandle;
  storage: ObjectStorage | undefined;
  logger: Logger;
  alertBytes?: number | undefined;
  /** Test seam: scale all delays and intervals. */
  scale?: number;
}): JobsHandle {
  const { handle, storage, logger } = opts;
  const k = opts.scale ?? 1;
  const jobs: JobSpec[] = [
    {
      name: 'expire-uploads',
      lockId: LOCK_IDS.expireUploads,
      intervalMs: 5 * MIN,
      initialDelayMs: 20_000,
      run: () => expireUploads(handle.db, logger),
    },
    {
      name: 'purge',
      lockId: LOCK_IDS.purge,
      intervalMs: 24 * HOUR,
      initialDelayMs: 2 * MIN,
      run: () => runPurge(handle.db, logger),
    },
  ];
  if (storage) {
    jobs.push(
      {
        name: 'object-deletions',
        lockId: LOCK_IDS.objectDeletions,
        intervalMs: MIN,
        initialDelayMs: 10_000,
        run: () => runObjectDeletions(handle.db, storage, logger),
      },
      {
        name: 'orphan-sweep',
        lockId: LOCK_IDS.orphanSweep,
        intervalMs: 7 * 24 * HOUR,
        initialDelayMs: 10 * MIN,
        run: () => sweepOrphans(handle.db, storage, logger, { alertBytes: opts.alertBytes }),
      },
    );
  } else {
    logger.warn('S3 is not configured: object deletions and the orphan sweep are not running');
  }

  let stopped = false;
  const inFlight = new Set<Promise<unknown>>();
  const timers: NodeJS.Timeout[] = [];

  const tick = (job: JobSpec) => {
    if (stopped) return;
    const p = withAdvisoryLock(handle.pool, job.lockId, job.run)
      .then((r) => {
        if (!r.ran) logger.debug({ job: job.name }, 'job skipped: another instance holds the lock');
      })
      .catch((err: Error) => logger.error({ job: job.name, name: err.name }, 'job failed'))
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  };

  for (const job of jobs) {
    const first = setTimeout(() => {
      tick(job);
      const every = setInterval(() => tick(job), job.intervalMs * k);
      every.unref();
      timers.push(every);
    }, job.initialDelayMs * k);
    first.unref();
    timers.push(first);
  }

  return {
    async stop() {
      stopped = true;
      for (const t of timers) {
        clearTimeout(t);
        clearInterval(t);
      }
      await Promise.allSettled([...inFlight]);
    },
  };
}
