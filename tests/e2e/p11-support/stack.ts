import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * The local Clavis Sync stack for the P11 e2e: the real API + a fresh Postgres database + the fake
 * Google, started by server/scripts/e2e-up.mjs (npm run e2e:up), and one extension build per test
 * identity (the Google login hint is baked in at build time). Nothing here talks to the internet.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverDir = path.join(repoRoot, 'server');
const run = promisify(execFile);

/** The slice of `pg` used here. The root package has no pg dependency: it is loaded from server/node_modules. */
interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}
interface PgModule {
  Pool: new (config: { connectionString: string; max: number }) => PgQueryable;
  Client: new (config: { connectionString: string }) => PgQueryable & { connect(): Promise<void> };
}
const loadPg = (): PgModule =>
  createRequire(path.join(serverDir, 'package.json'))('pg') as PgModule;

/**
 * The stack needs server/node_modules, Postgres and MinIO. The cross-platform CI browser shards have none of
 * them, so there these specs skip; the "Sync e2e" CI job provides the services and sets CLAVIS_E2E_STACK=1,
 * which makes them run. Locally (no CI variable) they always run.
 */
export const STACK_UNAVAILABLE =
  Boolean(process.env['CI']) && process.env['CLAVIS_E2E_STACK'] !== '1';
export const STACK_SKIP_REASON =
  'Needs the local Clavis Sync stack (Postgres, MinIO, server deps); runs in the "Sync e2e" CI job';

export const API_ORIGIN = 'http://localhost:8787';
export const GOOGLE_ORIGIN = 'http://127.0.0.1:8788';
const ADMIN_URL =
  process.env['E2E_ADMIN_DATABASE_URL'] ??
  'postgres://clavis:clavis-dev-only@127.0.0.1:5433/postgres';

export interface Stack {
  database: string;
  /** Run a read-only SQL query against the e2e database. */
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  /** Stop the API and fake Google and wait for the database to be dropped. */
  stop(): Promise<void>;
  /** Combined stdout/stderr of the stack, for diagnostics. */
  log(): string;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(true));
  });
}

export async function startStack(): Promise<Stack> {
  for (const port of [8787, 8788]) {
    if (!(await portFree(port)))
      throw new Error(`Port ${port} is in use; stop the other stack first.`);
  }
  let output = '';
  const child: ChildProcess = spawn(process.execPath, ['scripts/e2e-up.mjs'], {
    cwd: serverDir,
    env: { ...process.env, LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()));

  let database = '';
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const match = /E2E stack ready[\s\S]*\(database (clavis_e2e_[0-9a-f]+)\)/.exec(output);
    if (match) {
      database = match[1]!;
      break;
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (database === '') {
    child.kill('SIGTERM');
    throw new Error(`The e2e stack did not start:\n${output}`);
  }

  const pg = loadPg();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  return {
    database,
    log: () => output,
    async sql(query, params = []) {
      const result = await pool.query(query, params);
      return result.rows as never[];
    },
    async stop() {
      await pool.end().catch(() => undefined);
      child.kill('SIGINT');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

/** Build the extension for the e2e stack as `email` into a temp dir; returns the unpacked build dir. */
export async function buildExtension(
  email: string,
): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const out = await mkdtemp(path.join(tmpdir(), 'clavis-p11-build-'));
  await run('npx', ['wxt', 'build'], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      CLAVIS_FORCE_FEATURES: '1',
      WXT_CLAVIS_API_ORIGIN: API_ORIGIN,
      WXT_CLAVIS_GOOGLE_AUTH_URL: `${GOOGLE_ORIGIN}/authorize`,
      WXT_CLAVIS_GOOGLE_CLIENT_ID: 'fake-client.apps.googleusercontent.com',
      WXT_CLAVIS_GOOGLE_LOGIN_HINT: email,
      WXT_OUT_DIR: out,
    },
  });
  return {
    dir: path.join(out, 'chrome-mv3'),
    cleanup: () => rm(out, { recursive: true, force: true }).then(() => undefined),
  };
}

/** Names of the clavis_e2e_* databases still on the dev Postgres (should be none after a run). */
export async function leftoverDatabases(): Promise<string[]> {
  const pg = loadPg();
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'clavis_e2e_%'`,
    );
    return (r.rows as { datname: string }[]).map((x) => x.datname);
  } finally {
    await client.end();
  }
}
