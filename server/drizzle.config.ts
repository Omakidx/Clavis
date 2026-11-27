import { defineConfig } from 'drizzle-kit';

// `npm run db:generate` writes reviewed, forward-only SQL into ./migrations.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env['DATABASE_URL'] ?? '' },
  strict: true,
  verbose: true,
});
