import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminUrl,
  createTestDb,
  hex64,
  insertDocument,
  insertUser,
  insertWord,
  migrationsFolder,
  pgError,
  type TestDb,
} from './helpers';

// Real Postgres 17. Each file creates and drops its own throwaway database; skipped without TEST_DATABASE_URL.
describe.skipIf(!adminUrl)('schema constraints (real Postgres)', () => {
  let t: TestDb;
  const exec = (q: ReturnType<typeof sql>) => t.handle.db.execute(q);
  const count = async (table: string) =>
    Number((await exec(sql.raw(`SELECT count(*)::int AS n FROM ${table}`))).rows[0]?.['n']);

  beforeAll(async () => {
    t = await createTestDb(5);
  });
  afterAll(async () => {
    await t.drop();
  });

  it('migrations applied to an empty database: every §3.1 table exists', async () => {
    const r = await exec(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    );
    expect(r.rows.map((x) => x['table_name'])).toEqual([
      'documents',
      'highlights',
      'idempotency_keys',
      'object_deletions',
      'refresh_tokens',
      'saved_words',
      'uploads',
      'users',
      'web_sessions',
      'word_chat_messages',
    ]);
    const v = await exec(sql`SHOW server_version_num`);
    expect(Number(v.rows[0]?.['server_version_num'])).toBeGreaterThanOrEqual(170000);
  });

  it('applying the migrations again is a no-op', async () => {
    await migrate(t.handle.db, { migrationsFolder });
    expect(await count('users')).toBe(0);
  });

  it('deleting a user cascades to every user-owned row (and keeps object_deletions)', async () => {
    const u = await insertUser(t.handle);
    const other = await insertUser(t.handle);
    const key = await insertWord(t.handle, u, 1n);
    const fp = await insertDocument(t.handle, u, 2n);
    await insertWord(t.handle, other, 1n);
    await exec(sql`INSERT INTO word_chat_messages (id, user_id, word_key, role, content, created_at, seq)
      VALUES (gen_random_uuid(), ${u}, ${key}, 'user', 'hi', now(), 3)`);
    await exec(sql`INSERT INTO highlights (user_id, id, fingerprint, page, start_offset, end_offset, color, created_at, client_modified_at, seq)
      VALUES (${u}, gen_random_uuid(), ${fp}, 1, 0, 5, 'yellow', now(), now(), 4)`);
    await exec(sql`INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, family_expires_at)
      VALUES (${u}, gen_random_uuid(), sha256(gen_random_uuid()::text::bytea), now(), now())`);
    await exec(sql`INSERT INTO web_sessions (user_id, session_hash, csrf_token, authenticated_at, expires_at)
      VALUES (${u}, sha256(gen_random_uuid()::text::bytea), 'c', now(), now())`);
    await exec(sql`INSERT INTO uploads (user_id, fingerprint, reserved_bytes, object_key, status, expires_at)
      VALUES (${u}, ${hex64('b')}, 10, 'k', 'completed', now())`);
    await exec(sql`INSERT INTO idempotency_keys (user_id, key, request_hash, response)
      VALUES (${u}, gen_random_uuid(), sha256(gen_random_uuid()::text::bytea), '{}'::jsonb)`);
    await exec(sql`INSERT INTO object_deletions (object_prefix) VALUES (${`u/${u}/`})`);

    await exec(sql`DELETE FROM users WHERE id = ${u}`);

    for (const table of [
      'saved_words',
      'word_chat_messages',
      'documents',
      'highlights',
      'refresh_tokens',
      'web_sessions',
      'uploads',
      'idempotency_keys',
    ]) {
      const n = Number(
        (await exec(sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = '${u}'`)))
          .rows[0]?.['n'],
      );
      expect(n, table).toBe(0);
    }
    expect(await count('object_deletions')).toBeGreaterThanOrEqual(1);
    // Other users' rows survive.
    const kept = await exec(
      sql`SELECT count(*)::int AS n FROM saved_words WHERE user_id = ${other}`,
    );
    expect(kept.rows[0]?.['n']).toBe(1);
  });

  it('storage CHECKs reject overflow and negatives', async () => {
    const u = await insertUser(t.handle, { quota: 1000n });
    expect(
      await pgError(exec(sql`UPDATE users SET storage_reserved_bytes = 1001 WHERE id = ${u}`)),
    ).toMatchObject({ code: '23514', constraint: 'storage_within_quota' });
    expect(
      await pgError(
        exec(
          sql`UPDATE users SET storage_used_bytes = 600, storage_reserved_bytes = 401 WHERE id = ${u}`,
        ),
      ),
    ).toMatchObject({ constraint: 'storage_within_quota' });
    expect(
      await pgError(exec(sql`UPDATE users SET storage_used_bytes = -1 WHERE id = ${u}`)),
    ).toMatchObject({ constraint: 'storage_nonneg' });
    await exec(
      sql`UPDATE users SET storage_used_bytes = 600, storage_reserved_bytes = 400 WHERE id = ${u}`,
    );
  });

  it('users column checks', async () => {
    expect(
      await pgError(exec(sql`INSERT INTO users (google_sub, email) VALUES ('', 'a@b.c')`)),
    ).toMatchObject({ constraint: 'users_google_sub_len' });
    expect(
      await pgError(
        exec(sql`INSERT INTO users (google_sub, email) VALUES ('x', ${'e'.repeat(321)})`),
      ),
    ).toMatchObject({ constraint: 'users_email_len' });
    const sub = `dup-${Date.now()}`;
    await insertUser(t.handle, { sub });
    expect(await pgError(insertUser(t.handle, { sub }))).toMatchObject({ code: '23505' });
  });

  describe('saved_words', () => {
    let u: string;
    const base = (over: Record<string, string | number | null> = {}) => {
      const row: Record<string, string | number | null> = {
        word_key: hex64('c'),
        text: 'word',
        meaning: '{"title":"t"}',
        source_kind: 'webpage',
        ...over,
      };
      return exec(sql`
        INSERT INTO saved_words (user_id, word_key, text, meaning, source_kind, source_url, pdf_fingerprint, pdf_page,
          context_before, language, created_at, client_modified_at, seq)
        VALUES (${u}, ${row['word_key']}, ${row['text']}, ${row['meaning']}::jsonb, ${row['source_kind']},
          ${row['source_url'] ?? null}, ${row['pdf_fingerprint'] ?? null}, ${row['pdf_page'] ?? null},
          ${row['context_before'] ?? null}, ${row['language'] ?? null}, now(), now(), 1)`);
    };
    beforeAll(async () => {
      u = await insertUser(t.handle);
    });

    it('rejects oversize and malformed values', async () => {
      const bad = async (over: Record<string, string | number | null>, constraint: string) =>
        expect(await pgError(base({ word_key: hex64('d'), ...over })), constraint).toMatchObject({
          code: '23514',
          constraint,
        });
      await bad({ text: 'x'.repeat(201) }, 'saved_words_text_len');
      await bad({ text: '' }, 'saved_words_text_len');
      await bad({ language: 'x'.repeat(36) }, 'saved_words_language_len');
      await bad({ context_before: 'x'.repeat(1001) }, 'saved_words_context_before_len');
      await bad({ source_url: 'x'.repeat(2049) }, 'saved_words_source_url_len');
      await bad({ source_kind: 'epub' }, 'saved_words_source_kind');
      await bad({ meaning: JSON.stringify({ a: 'x'.repeat(16400) }) }, 'saved_words_meaning_size');
      await bad({ word_key: 'A'.repeat(64) }, 'saved_words_word_key_hex');
      await bad({ pdf_page: 3 }, 'saved_words_pdf_fields_only_for_pdf');
      await bad({ source_kind: 'pdf', pdf_page: 5001 }, 'saved_words_pdf_page_range');
      await bad(
        { source_kind: 'pdf', pdf_page: 1, pdf_fingerprint: 'zz'.repeat(32) },
        'saved_words_pdf_fingerprint_hex',
      );
    });

    it('accepts boundary values', async () => {
      await base({ word_key: hex64('e'), text: 'x'.repeat(200), source_url: 'x'.repeat(2048) });
      await base({
        word_key: hex64('f'),
        source_kind: 'pdf',
        pdf_page: 5000,
        pdf_fingerprint: hex64('1'),
      });
    });

    it('PRIMARY KEY (user_id, word_key) is unique per user, not global', async () => {
      await base({ word_key: hex64('2') });
      expect(await pgError(base({ word_key: hex64('2') }))).toMatchObject({ code: '23505' });
      const v = await insertUser(t.handle);
      await insertWord(t.handle, v, 1n, { key: hex64('2') });
    });
  });

  it('word_chat_messages: FK to saved_words, role/model/length checks', async () => {
    const u = await insertUser(t.handle);
    const key = await insertWord(t.handle, u, 1n);
    const ins = (over: { word?: string; role?: string; content?: string; model?: string | null }) =>
      exec(sql`INSERT INTO word_chat_messages (id, user_id, word_key, role, content, model, created_at, seq)
        VALUES (gen_random_uuid(), ${u}, ${over.word ?? key}, ${over.role ?? 'user'}, ${over.content ?? 'hi'},
          ${over.model ?? null}, now(), 2)`);
    expect(await pgError(ins({ word: hex64('9') }))).toMatchObject({ code: '23503' });
    expect(await pgError(ins({ role: 'system' }))).toMatchObject({ constraint: 'word_chat_role' });
    expect(await pgError(ins({ content: '' }))).toMatchObject({
      constraint: 'word_chat_content_len',
    });
    expect(await pgError(ins({ content: 'x'.repeat(2001) }))).toMatchObject({
      constraint: 'word_chat_user_content_len',
    });
    expect(
      await pgError(ins({ role: 'assistant', content: 'x'.repeat(4001), model: 'm' })),
    ).toMatchObject({
      constraint: 'word_chat_content_len',
    });
    expect(await pgError(ins({ role: 'assistant' }))).toMatchObject({
      constraint: 'word_chat_model_iff_assistant',
    });
    expect(await pgError(ins({ role: 'user', model: 'm' }))).toMatchObject({
      constraint: 'word_chat_model_iff_assistant',
    });
    await ins({ role: 'assistant', content: 'x'.repeat(4000), model: 'm' });
    // Deleting the word removes its messages.
    await exec(sql`DELETE FROM saved_words WHERE user_id = ${u} AND word_key = ${key}`);
    expect(
      (await exec(sql`SELECT count(*)::int AS n FROM word_chat_messages WHERE user_id = ${u}`))
        .rows[0]?.['n'],
    ).toBe(0);
  });

  it('documents: ranges, storage consistency, 15 MiB per-file cap', async () => {
    const u = await insertUser(t.handle);
    const ins = (cols: string, vals: ReturnType<typeof sql>) =>
      exec(sql`INSERT INTO documents (user_id, fingerprint, client_modified_at, seq, ${sql.raw(cols)})
        VALUES (${u}, ${hex64('a')}, now(), 1, ${vals})`);
    expect(await pgError(ins('page_count', sql`0`))).toMatchObject({
      constraint: 'documents_page_count_range',
    });
    expect(await pgError(ins('page_offset', sql`1.5`))).toMatchObject({
      constraint: 'documents_page_offset_range',
    });
    expect(await pgError(ins('file_bytes', sql`0`))).toMatchObject({
      constraint: 'documents_file_bytes_pos',
    });
    expect(await pgError(ins('title', sql`${'t'.repeat(301)}`))).toMatchObject({
      constraint: 'documents_title_len',
    });
    expect(await pgError(ins('stored_bytes', sql`15728641`))).toMatchObject({
      constraint: 'documents_stored_bytes_range',
    });
    // state 'stored' needs both object_key and stored_bytes.
    expect(await pgError(ins('storage_state', sql`'stored'`))).toMatchObject({
      constraint: 'documents_storage_consistent',
    });
    expect(
      await pgError(
        exec(sql`INSERT INTO documents (user_id, fingerprint, client_modified_at, seq, storage_state, object_key)
          VALUES (${u}, ${hex64('a')}, now(), 1, 'stored', 'k')`),
      ),
    ).toMatchObject({ constraint: 'documents_storage_consistent' });
    expect(await pgError(ins('storage_state', sql`'weird'`))).toMatchObject({
      constraint: 'documents_storage_state',
    });
    await exec(sql`INSERT INTO documents (user_id, fingerprint, client_modified_at, seq, storage_state, object_key, stored_bytes)
      VALUES (${u}, ${hex64('a')}, now(), 1, 'stored', 'u/x/y.pdf', 15728640)`);
    expect(
      await pgError(
        exec(
          sql`INSERT INTO documents (user_id, fingerprint, client_modified_at, seq) VALUES (${u}, ${hex64('a')}, now(), 2)`,
        ),
      ),
    ).toMatchObject({ code: '23505' });
  });

  it('highlights: FK to documents, offset and colour checks', async () => {
    const u = await insertUser(t.handle);
    const fp = await insertDocument(t.handle, u, 1n);
    const ins = (o: { fp?: string; s?: number; e?: number; color?: string; page?: number }) =>
      exec(sql`INSERT INTO highlights (user_id, id, fingerprint, page, start_offset, end_offset, color, created_at, client_modified_at, seq)
        VALUES (${u}, gen_random_uuid(), ${o.fp ?? fp}, ${o.page ?? 1}, ${o.s ?? 0}, ${o.e ?? 5}, ${o.color ?? 'blue'}, now(), now(), 2)`);
    expect(await pgError(ins({ fp: hex64('7') }))).toMatchObject({ code: '23503' });
    expect(await pgError(ins({ s: 5, e: 5 }))).toMatchObject({
      constraint: 'highlights_end_after_start',
    });
    expect(await pgError(ins({ color: 'red' }))).toMatchObject({ constraint: 'highlights_color' });
    expect(await pgError(ins({ page: 5001 }))).toMatchObject({
      constraint: 'highlights_page_range',
    });
    expect(await pgError(ins({ e: 10_000_001 }))).toMatchObject({
      constraint: 'highlights_end_range',
    });
    await ins({ s: 0, e: 10_000_000 });
    await exec(sql`DELETE FROM documents WHERE user_id = ${u}`);
    expect(
      (await exec(sql`SELECT count(*)::int AS n FROM highlights WHERE user_id = ${u}`)).rows[0]?.[
        'n'
      ],
    ).toBe(0);
  });

  it('uploads and object_deletions constraints', async () => {
    const u = await insertUser(t.handle);
    const up = (bytes: number, status = 'pending', fp = hex64('a')) =>
      exec(sql`INSERT INTO uploads (user_id, fingerprint, reserved_bytes, object_key, status, expires_at)
        VALUES (${u}, ${fp}, ${bytes}, 'k', ${status}, now() + interval '15 minutes')`);
    expect(await pgError(up(15728641))).toMatchObject({
      constraint: 'uploads_reserved_bytes_range',
    });
    expect(await pgError(up(0))).toMatchObject({ constraint: 'uploads_reserved_bytes_range' });
    expect(await pgError(up(1, 'bogus'))).toMatchObject({ constraint: 'uploads_status' });
    await up(15728640);
    // Only one pending upload per (user, fingerprint); a finished one does not block.
    expect(await pgError(up(1))).toMatchObject({
      code: '23505',
      constraint: 'uploads_one_pending',
    });
    await up(1, 'aborted');
    await up(1, 'pending', hex64('b'));

    expect(await pgError(exec(sql`INSERT INTO object_deletions DEFAULT VALUES`))).toMatchObject({
      constraint: 'object_deletions_key_xor_prefix',
    });
    expect(
      await pgError(
        exec(sql`INSERT INTO object_deletions (object_key, object_prefix) VALUES ('a', 'b')`),
      ),
    ).toMatchObject({ constraint: 'object_deletions_key_xor_prefix' });
    await exec(sql`INSERT INTO object_deletions (object_key) VALUES ('a')`);
  });

  it('refresh_tokens: revoked_reason is constrained, token_hash unique', async () => {
    const u = await insertUser(t.handle);
    const ins = (reason: string | null, hash = 'aa') =>
      exec(sql`INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, family_expires_at, revoked_reason)
        VALUES (${u}, gen_random_uuid(), decode(${hash}, 'hex'), now(), now(), ${reason})`);
    expect(await pgError(ins('whatever'))).toMatchObject({
      constraint: 'refresh_tokens_revoked_reason',
    });
    await ins('reuse');
    expect(await pgError(ins(null))).toMatchObject({ code: '23505' });
  });
});
