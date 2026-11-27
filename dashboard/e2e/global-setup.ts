import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeFileEndpoints } from './support/api';
import { startStack } from './support/stack';

const dashboardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Builds the dashboard if needed, starts the stack and records whether the file endpoints exist yet. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(path.join(dashboardDir, 'dist/index.html'))) {
    execFileSync('npm', ['run', 'build'], { cwd: dashboardDir, stdio: 'inherit' });
  }
  const stack = await startStack();
  try {
    process.env['E2E_FILES_READY'] = (await probeFileEndpoints()) ? '1' : '0';
  } catch (e) {
    await stack.stop();
    throw e;
  }
  return () => stack.stop();
}
