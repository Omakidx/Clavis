// Clavis Sync Postgres schema (docs/clavis-sync-design.md §3). Source of truth for typed queries AND for the
// generated migration: every CHECK and partial index is declared here, so `drizzle-kit generate` stays drift-free.
//
// Conventions
// - Every user-owned row carries `user_id` (first key column) with ON DELETE CASCADE. word_chat_messages and
//   highlights reach users through composite FKs (saved_words / documents) that cascade (§8.5 account delete).
// - `seq` (bigint) is allocated per user under the user row lock (§4.2); see src/db/queries/sync.ts.
// - Counts of live rows (§3.2: 5,000 words, 200 messages/word, 2,000 documents, 200 highlights/document) are
//   application-enforced inside the push transaction that holds the user row lock; they are not CHECKs.
// - Never take `user_id` from a client.
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const seqCol = () => bigint('seq', { mode: 'bigint' }).notNull();

/** 15 MiB per stored file, 100 MiB per account (S-06, shared/api-contract/limits.ts). */
export const MAX_FILE_BYTES = 15_728_640;
export const DEFAULT_QUOTA_BYTES = 104_857_600;

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    googleSub: text('google_sub').notNull().unique(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    /** Per-user sync sequence (§4.2): only advanced while holding this row's FOR UPDATE lock. */
    changeSeq: bigint('change_seq', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** Highest seq of a purged tombstone (§3.3). Pulls with 0 < cursor < floor get 410 CURSOR_EXPIRED. */
    tombstoneFloorSeq: bigint('tombstone_floor_seq', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'bigint' })
      .notNull()
      .default(sql`104857600`),
    storageUsedBytes: bigint('storage_used_bytes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    storageReservedBytes: bigint('storage_reserved_bytes', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
  },
  (t) => [
    check('users_google_sub_len', sql`length(${t.googleSub}) BETWEEN 1 AND 255`),
    check('users_email_len', sql`length(${t.email}) <= 320`),
    check('users_display_name_len', sql`length(${t.displayName}) <= 200`),
    check('storage_nonneg', sql`${t.storageUsedBytes} >= 0 AND ${t.storageReservedBytes} >= 0`),
    check(
      'storage_within_quota',
      sql`${t.storageUsedBytes} + ${t.storageReservedBytes} <= ${t.storageQuotaBytes}`,
    ),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    /** SHA-256 of the opaque token. */
    tokenHash: bytea('token_hash').notNull().unique(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    /** Sliding 30 d. */
    expiresAt: tstz('expires_at').notNull(),
    /** Absolute 180 d. */
    familyExpiresAt: tstz('family_expires_at').notNull(),
    usedAt: tstz('used_at'),
    revokedAt: tstz('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    check(
      'refresh_tokens_revoked_reason',
      sql`${t.revokedReason} IN ('logout','logout_all','reuse','expired')`,
    ),
    index('refresh_tokens_family').on(t.familyId),
    index('refresh_tokens_user').on(t.userId),
  ],
);

export const webSessions = pgTable(
  'web_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionHash: bytea('session_hash').notNull().unique(),
    /** Random; not a credential on its own. */
    csrfToken: text('csrf_token').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    /** Last Google login (re-auth window). */
    authenticatedAt: tstz('authenticated_at').notNull(),
    /** Absolute 30 d. */
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [index('web_sessions_user').on(t.userId)],
);

export const savedWords = pgTable(
  'saved_words',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** hex SHA-256(normalize(text)) (§4.5). */
    wordKey: char('word_key', { length: 64 }).notNull(),
    text: text('text').notNull(),
    language: text('language'),
    /** SavedMeaning (§5.2). */
    meaning: jsonb('meaning').notNull(),
    contextBefore: text('context_before'),
    contextAfter: text('context_after'),
    sourceKind: text('source_kind').notNull(),
    /** origin + path only, no query/fragment. */
    sourceUrl: text('source_url'),
    sourceTitle: text('source_title'),
    pdfFingerprint: char('pdf_fingerprint', { length: 64 }),
    pdfPage: integer('pdf_page'),
    createdAt: tstz('created_at').notNull(),
    /** LWW key (§4.4). */
    clientModifiedAt: tstz('client_modified_at').notNull(),
    serverModifiedAt: tstz('server_modified_at').notNull().defaultNow(),
    seq: seqCol(),
    deletedAt: tstz('deleted_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.wordKey] }),
    check('saved_words_word_key_hex', sql`${t.wordKey} ~ '^[0-9a-f]{64}$'`),
    check('saved_words_text_len', sql`length(${t.text}) BETWEEN 1 AND 200`),
    check('saved_words_language_len', sql`length(${t.language}) <= 35`),
    check('saved_words_meaning_size', sql`octet_length(${t.meaning}::text) <= 16384`),
    check('saved_words_context_before_len', sql`length(${t.contextBefore}) <= 1000`),
    check('saved_words_context_after_len', sql`length(${t.contextAfter}) <= 1000`),
    check('saved_words_source_kind', sql`${t.sourceKind} IN ('webpage','pdf')`),
    check('saved_words_source_url_len', sql`length(${t.sourceUrl}) <= 2048`),
    check('saved_words_source_title_len', sql`length(${t.sourceTitle}) <= 300`),
    check('saved_words_pdf_fingerprint_hex', sql`${t.pdfFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('saved_words_pdf_page_range', sql`${t.pdfPage} BETWEEN 1 AND 5000`),
    check(
      'saved_words_pdf_fields_only_for_pdf',
      sql`${t.sourceKind} = 'pdf' OR (${t.pdfFingerprint} IS NULL AND ${t.pdfPage} IS NULL)`,
    ),
    index('saved_words_seq').on(t.userId, t.seq),
    index('saved_words_list')
      .on(t.userId, t.createdAt.desc(), t.wordKey)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

// Messages are immutable. Deleting a word hard-deletes its messages in the same transaction
// (the composite FK cascade also covers tombstone purge and account delete).
export const wordChatMessages = pgTable(
  'word_chat_messages',
  {
    /** Client-generated UUIDv4. */
    id: uuid('id').notNull(),
    userId: uuid('user_id').notNull(),
    wordKey: char('word_key', { length: 64 }).notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    /** Assistant only. */
    model: text('model'),
    /** Client time; ordering within a word. */
    createdAt: tstz('created_at').notNull(),
    seq: seqCol(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.wordKey],
      foreignColumns: [savedWords.userId, savedWords.wordKey],
      name: 'word_chat_messages_word_fk',
    }).onDelete('cascade'),
    check('word_chat_role', sql`${t.role} IN ('user','assistant')`),
    check('word_chat_content_len', sql`length(${t.content}) BETWEEN 1 AND 4000`),
    check('word_chat_model_len', sql`length(${t.model}) <= 128`),
    // Contract (shared/api-contract/records.ts ChatData): user messages <= 2000 chars, no model; assistant has one.
    check('word_chat_user_content_len', sql`${t.role} <> 'user' OR length(${t.content}) <= 2000`),
    check(
      'word_chat_model_iff_assistant',
      sql`(${t.role} = 'assistant') = (${t.model} IS NOT NULL)`,
    ),
    index('chat_by_word').on(t.userId, t.wordKey, t.createdAt, t.id),
    index('chat_seq').on(t.userId, t.seq),
  ],
);

export const documents = pgTable(
  'documents',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the file bytes. */
    fingerprint: char('fingerprint', { length: 64 }).notNull(),
    title: text('title'),
    pageCount: integer('page_count'),
    lastPage: integer('last_page'),
    pageOffset: real('page_offset'),
    /** Client-reported size of the local file (informational). */
    fileBytes: bigint('file_bytes', { mode: 'bigint' }),
    clientModifiedAt: tstz('client_modified_at').notNull(),
    serverModifiedAt: tstz('server_modified_at').notNull().defaultNow(),
    seq: seqCol(),
    deletedAt: tstz('deleted_at'),
    // Server-owned storage fields (never accepted from sync push).
    storageState: text('storage_state').notNull().default('none'),
    objectKey: text('object_key'),
    storedBytes: bigint('stored_bytes', { mode: 'bigint' }),
    storedAt: tstz('stored_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.fingerprint] }),
    check('documents_fingerprint_hex', sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check('documents_title_len', sql`length(${t.title}) <= 300`),
    check('documents_page_count_range', sql`${t.pageCount} BETWEEN 1 AND 5000`),
    check('documents_last_page_range', sql`${t.lastPage} BETWEEN 1 AND 5000`),
    check('documents_page_offset_range', sql`${t.pageOffset} >= 0 AND ${t.pageOffset} <= 1`),
    check('documents_file_bytes_pos', sql`${t.fileBytes} > 0`),
    check('documents_storage_state', sql`${t.storageState} IN ('none','stored')`),
    check('documents_stored_bytes_range', sql`${t.storedBytes} BETWEEN 1 AND 15728640`),
    check(
      'documents_storage_consistent',
      sql`(${t.storageState} = 'stored') = (${t.objectKey} IS NOT NULL AND ${t.storedBytes} IS NOT NULL)`,
    ),
    index('documents_seq').on(t.userId, t.seq),
    index('documents_recent')
      .on(t.userId, t.clientModifiedAt.desc())
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const highlights = pgTable(
  'highlights',
  {
    userId: uuid('user_id').notNull(),
    /** The existing ReaderHighlight.id. */
    id: uuid('id').notNull(),
    fingerprint: char('fingerprint', { length: 64 }).notNull(),
    page: integer('page').notNull(),
    startOffset: integer('start_offset').notNull(),
    endOffset: integer('end_offset').notNull(),
    color: text('color').notNull(),
    createdAt: tstz('created_at').notNull(),
    clientModifiedAt: tstz('client_modified_at').notNull(),
    serverModifiedAt: tstz('server_modified_at').notNull().defaultNow(),
    seq: seqCol(),
    deletedAt: tstz('deleted_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.fingerprint],
      foreignColumns: [documents.userId, documents.fingerprint],
      name: 'highlights_document_fk',
    }).onDelete('cascade'),
    check('highlights_page_range', sql`${t.page} BETWEEN 1 AND 5000`),
    check('highlights_start_range', sql`${t.startOffset} BETWEEN 0 AND 10000000`),
    check('highlights_end_range', sql`${t.endOffset} BETWEEN 1 AND 10000000`),
    check('highlights_color', sql`${t.color} IN ('yellow','green','blue','pink')`),
    check('highlights_end_after_start', sql`${t.endOffset} > ${t.startOffset}`),
    index('highlights_seq').on(t.userId, t.seq),
    index('highlights_doc')
      .on(t.userId, t.fingerprint)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/** Quota reservations (§6.2). */
export const uploads = pgTable(
  'uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fingerprint: char('fingerprint', { length: 64 }).notNull(),
    reservedBytes: bigint('reserved_bytes', { mode: 'bigint' }).notNull(),
    objectKey: text('object_key').notNull(),
    status: text('status').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    /** created_at + 15 min. */
    expiresAt: tstz('expires_at').notNull(),
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    check('uploads_reserved_bytes_range', sql`${t.reservedBytes} BETWEEN 1 AND 15728640`),
    check('uploads_status', sql`${t.status} IN ('pending','completed','aborted','expired')`),
    check('uploads_fingerprint_hex', sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`),
    uniqueIndex('uploads_one_pending')
      .on(t.userId, t.fingerprint)
      .where(sql`${t.status} = 'pending'`),
    index('uploads_expiry')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/** Durable bucket-delete jobs (§6.4). No FK: rows must outlive the user (account delete enqueues a prefix). */
export const objectDeletions = pgTable(
  'object_deletions',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    /** Exactly one of object_key / object_prefix. */
    objectKey: text('object_key'),
    objectPrefix: text('object_prefix'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: tstz('next_attempt_at').notNull().defaultNow(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'object_deletions_key_xor_prefix',
      sql`(${t.objectKey} IS NULL) <> (${t.objectPrefix} IS NULL)`,
    ),
    index('object_deletions_due').on(t.nextAttemptAt),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: uuid('key').notNull(),
    /** SHA-256 of the canonical request body. */
    requestHash: bytea('request_hash').notNull(),
    response: jsonb('response').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.key] }),
    // Purge of keys older than 24 h (§3.3).
    index('idempotency_keys_created').on(t.createdAt),
  ],
);
