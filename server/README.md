# Clavis Sync API

Hono on Node 24. Design: [../docs/clavis-sync-design.md](../docs/clavis-sync-design.md). Not an npm workspace:
install and run from this folder (`npm ci`).

## Local development

```sh
docker compose -f server/docker-compose.dev.yml up -d   # Postgres 17 on :5433, MinIO S3 on :9000 (console :9001)
cp server/.env.example server/.env                       # fill in values; DATABASE_URL=postgres://clavis:...@localhost:5433/clavis
npm run dev --prefix server                              # tsx watch on :8787
```

Postgres is published on host port **5433** because 5432 is commonly occupied by another local Postgres. The compose
credentials are development-only (see `docker-compose.dev.yml`). MinIO bucket: `clavis-dev`.

## Scripts

`npm run ci` = typecheck, lint, test, build. `npm run build` bundles `dist/index.js` and `dist/migrate.js` (esbuild).

## Database conventions

- Schema: `src/db/schema.ts` (Drizzle). Config: `drizzle.config.ts`. Migrations: `migrations/` (forward-only, reviewed, committed).
- Add a migration: edit the schema, run `DATABASE_URL=... npm run db:generate`, review the SQL, commit `migrations/`.
- `node dist/migrate.js` applies them (Railway pre-deploy). It is a no-op until `migrations/meta/_journal.json` exists.
- DB client: `createDb(url, logger)` in `src/db/client.ts` returns `{ pool, db, ping, close }`.
- Integration tests read `TEST_DATABASE_URL` and skip when it is unset. They must only touch a throwaway database.

## Authentication (design §2)

- Routes: `POST /v1/auth/extension/{google,refresh,logout}`, `GET /auth/google/{start,callback}`, `POST /auth/logout`,
  `GET /v1/session`, `GET /v1/account`, `POST /v1/account/logout-all`, `GET /v1/meta`.
- Code: `src/auth/` (Google client, tokens, store, middleware, routes), `src/http/` (errors, CORS, CSRF, rate limiter),
  `src/account/` (account and meta routes).
- Required in production (config fails fast, naming variables only): `DATABASE_URL`, `PUBLIC_ORIGIN` (https),
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EXTENSION_IDS`, `TOKEN_SIGNING_SECRET`, `STATE_COOKIE_SECRET`
  (the two secrets must differ). Outside production a missing variable makes the auth routes answer `503 UNAVAILABLE`.
- Plain-http dev origins use cookie names without the `__Host-` prefix and without `Secure`.
- Tests mock Google's token endpoint and JWKS (`test/auth/harness.ts`); integration tests need `TEST_DATABASE_URL`.
