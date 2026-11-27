// One-command local end-to-end stack: fake Google + the API against a FRESH throwaway database.
//   node scripts/e2e-up.mjs            (npm run e2e:up)
// Needs the dev Postgres (docker compose -f docker-compose.dev.yml up -d). Prints the URLs, then keeps running;
// Ctrl-C (SIGINT/SIGTERM) stops both and drops the database. Development credentials only.
//
// Env (all optional): E2E_ADMIN_DATABASE_URL (default the compose Postgres on 127.0.0.1:5433),
// E2E_API_PORT (8787), FAKE_GOOGLE_PORT (8788), E2E_EXTENSION_IDS (comma list, default the dev extension ID),
// E2E_KEEP_DB=1 (do not drop the database on exit).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { startFakeGoogle } from './fake-google.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminUrl =
  process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://clavis:clavis-dev-only@127.0.0.1:5433/postgres';
const apiPort = Number(process.env.E2E_API_PORT ?? 8787);
const googlePort = Number(process.env.FAKE_GOOGLE_PORT ?? 8788);
const extIds = process.env.E2E_EXTENSION_IDS ?? 'ebfpdncfkebjagolnbmfdhikaipiflbl';
const fakeSecret = (label) =>
  Buffer.from(`clavis-e2e-FAKE-${label}-not-a-real-secret`).toString('base64');

const dbName = `clavis_e2e_${randomBytes(5).toString('hex')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;

const admin = async (sql) => {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
};

await admin(`CREATE DATABASE ${dbName}`);
const pool = new pg.Pool({ connectionString: dbUrl.toString(), max: 1 });
try {
  await migrate(drizzle(pool), { migrationsFolder: path.join(root, 'migrations') });
} finally {
  await pool.end();
}

const google = await startFakeGoogle({ port: googlePort });
const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(apiPort),
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  PUBLIC_ORIGIN: `http://localhost:${apiPort}`,
  DATABASE_URL: dbUrl.toString(),
  GOOGLE_CLIENT_ID: 'fake-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'fake-client-secret',
  GOOGLE_AUTH_URL: `${google.url}/authorize`,
  GOOGLE_TOKEN_URL: `${google.url}/token`,
  GOOGLE_JWKS_URL: `${google.url}/jwks`,
  GOOGLE_ISSUER: google.issuer,
  ALLOWED_EXTENSION_IDS: extIds,
  TOKEN_SIGNING_SECRET: fakeSecret('signing'),
  STATE_COOKIE_SECRET: fakeSecret('state'),
  JOBS_ENABLED: '0',
};
const api = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: root,
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
});

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  api.kill('SIGTERM');
  await google.close();
  if (process.env.E2E_KEEP_DB !== '1')
    await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
  process.exit(code);
}
api.on('exit', (c) => void stop(c ?? 1));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void stop(0));

for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${apiPort}/healthz`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`\nE2E stack ready
  API          http://localhost:${apiPort}   (database ${dbName})
  Fake Google  ${google.url}   authorize ${google.url}/authorize  (pick identity with login_hint=<email>)
  Extension IDs ${extIds}
  Stop with Ctrl-C (drops the database unless E2E_KEEP_DB=1).`);
