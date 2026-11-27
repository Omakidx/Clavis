import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory of the running bundle (server/dist locally, /app/dist in the image). */
export const here = path.dirname(fileURLToPath(import.meta.url));

/** Built dashboard: /app/public in the image, ../dashboard/dist in a repo checkout. */
export function findDashboardDir(): string | undefined {
  const candidates = [path.resolve(here, '../public'), path.resolve(here, '../../dashboard/dist')];
  return candidates.find((dir) => existsSync(path.join(dir, 'index.html')));
}

/** SQL migrations: server/migrations in a checkout, /app/migrations in the image. */
export function migrationsDir(): string {
  return path.resolve(here, '../migrations');
}
