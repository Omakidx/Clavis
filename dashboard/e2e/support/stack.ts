import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The local stack for the dashboard e2e: the real API (which serves dashboard/dist), a fresh throwaway
 * Postgres database and the fake Google, all started by server/scripts/e2e-up.mjs. Ports default to
 * 8797/8798 so the extension e2e (8787/8788) can run at the same time. MinIO is the dev bucket from
 * server/docker-compose.dev.yml (development credentials only).
 */
export const API_PORT = Number(process.env['E2E_DASH_API_PORT'] ?? 8797);
export const GOOGLE_PORT = Number(process.env['E2E_DASH_GOOGLE_PORT'] ?? 8798);
export const API_ORIGIN = `http://localhost:${API_PORT}`;
export const GOOGLE_ORIGIN = `http://127.0.0.1:${GOOGLE_PORT}`;
/** The extension ID the e2e stack allows (server/scripts/e2e-up.mjs default). */
export const EXTENSION_ID = 'ebfpdncfkebjagolnbmfdhikaipiflbl';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '../../../server');

const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(true));
  });

export interface RunningStack {
  stop(): Promise<void>;
  log(): string;
}

export async function startStack(): Promise<RunningStack> {
  for (const port of [API_PORT, GOOGLE_PORT]) {
    if (!(await portFree(port)))
      throw new Error(`Port ${port} is in use; stop the other stack first.`);
  }
  let output = '';
  const child: ChildProcess = spawn(process.execPath, ['scripts/e2e-up.mjs'], {
    cwd: serverDir,
    env: {
      ...process.env,
      LOG_LEVEL: process.env['E2E_DASH_LOG_LEVEL'] ?? 'warn',
      E2E_API_PORT: String(API_PORT),
      FAKE_GOOGLE_PORT: String(GOOGLE_PORT),
      S3_ENDPOINT: process.env['E2E_S3_ENDPOINT'] ?? 'http://127.0.0.1:9000',
      S3_REGION: process.env['E2E_S3_REGION'] ?? 'us-east-1',
      S3_BUCKET: process.env['E2E_S3_BUCKET'] ?? 'clavis-dev',
      S3_ACCESS_KEY_ID: process.env['E2E_S3_ACCESS_KEY_ID'] ?? 'clavis-dev',
      S3_SECRET_ACCESS_KEY: process.env['E2E_S3_SECRET_ACCESS_KEY'] ?? 'clavis-dev-only',
      S3_FORCE_PATH_STYLE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()));

  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (output.includes('E2E stack ready')) {
      ready = true;
      break;
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) {
    child.kill('SIGTERM');
    throw new Error(`The e2e stack did not start:\n${output}`);
  }
  return {
    log: () => output,
    async stop() {
      child.kill('SIGINT'); // e2e-up drops its database on SIGINT
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}
