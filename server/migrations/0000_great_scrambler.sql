CREATE TABLE "documents" (
	"user_id" uuid NOT NULL,
	"fingerprint" char(64) NOT NULL,
	"title" text,
	"page_count" integer,
	"last_page" integer,
	"page_offset" real,
	"file_bytes" bigint,
	"client_modified_at" timestamp with time zone NOT NULL,
	"server_modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"storage_state" text DEFAULT 'none' NOT NULL,
	"object_key" text,
	"stored_bytes" bigint,
	"stored_at" timestamp with time zone,
	CONSTRAINT "documents_user_id_fingerprint_pk" PRIMARY KEY("user_id","fingerprint"),
	CONSTRAINT "documents_fingerprint_hex" CHECK ("documents"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "documents_title_len" CHECK (length("documents"."title") <= 300),
	CONSTRAINT "documents_page_count_range" CHECK ("documents"."page_count" BETWEEN 1 AND 5000),
	CONSTRAINT "documents_last_page_range" CHECK ("documents"."last_page" BETWEEN 1 AND 5000),
	CONSTRAINT "documents_page_offset_range" CHECK ("documents"."page_offset" >= 0 AND "documents"."page_offset" <= 1),
	CONSTRAINT "documents_file_bytes_pos" CHECK ("documents"."file_bytes" > 0),
	CONSTRAINT "documents_storage_state" CHECK ("documents"."storage_state" IN ('none','stored')),
	CONSTRAINT "documents_stored_bytes_range" CHECK ("documents"."stored_bytes" BETWEEN 1 AND 15728640),
	CONSTRAINT "documents_storage_consistent" CHECK (("documents"."storage_state" = 'stored') = ("documents"."object_key" IS NOT NULL AND "documents"."stored_bytes" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "highlights" (
	"user_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"fingerprint" char(64) NOT NULL,
	"page" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"client_modified_at" timestamp with time zone NOT NULL,
	"server_modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "highlights_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "highlights_page_range" CHECK ("highlights"."page" BETWEEN 1 AND 5000),
	CONSTRAINT "highlights_start_range" CHECK ("highlights"."start_offset" BETWEEN 0 AND 10000000),
	CONSTRAINT "highlights_end_range" CHECK ("highlights"."end_offset" BETWEEN 1 AND 10000000),
	CONSTRAINT "highlights_color" CHECK ("highlights"."color" IN ('yellow','green','blue','pink')),
	CONSTRAINT "highlights_end_after_start" CHECK ("highlights"."end_offset" > "highlights"."start_offset")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"user_id" uuid NOT NULL,
	"key" uuid NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "object_deletions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"object_key" text,
	"object_prefix" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "object_deletions_key_xor_prefix" CHECK (("object_deletions"."object_key" IS NULL) <> ("object_deletions"."object_prefix" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"family_expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "refresh_tokens_revoked_reason" CHECK ("refresh_tokens"."revoked_reason" IN ('logout','logout_all','reuse','expired'))
);
--> statement-breakpoint
CREATE TABLE "saved_words" (
	"user_id" uuid NOT NULL,
	"word_key" char(64) NOT NULL,
	"text" text NOT NULL,
	"language" text,
	"meaning" jsonb NOT NULL,
	"context_before" text,
	"context_after" text,
	"source_kind" text NOT NULL,
	"source_url" text,
	"source_title" text,
	"pdf_fingerprint" char(64),
	"pdf_page" integer,
	"created_at" timestamp with time zone NOT NULL,
	"client_modified_at" timestamp with time zone NOT NULL,
	"server_modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "saved_words_user_id_word_key_pk" PRIMARY KEY("user_id","word_key"),
	CONSTRAINT "saved_words_word_key_hex" CHECK ("saved_words"."word_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "saved_words_text_len" CHECK (length("saved_words"."text") BETWEEN 1 AND 200),
	CONSTRAINT "saved_words_language_len" CHECK (length("saved_words"."language") <= 35),
	CONSTRAINT "saved_words_meaning_size" CHECK (octet_length("saved_words"."meaning"::text) <= 16384),
	CONSTRAINT "saved_words_context_before_len" CHECK (length("saved_words"."context_before") <= 1000),
	CONSTRAINT "saved_words_context_after_len" CHECK (length("saved_words"."context_after") <= 1000),
	CONSTRAINT "saved_words_source_kind" CHECK ("saved_words"."source_kind" IN ('webpage','pdf')),
	CONSTRAINT "saved_words_source_url_len" CHECK (length("saved_words"."source_url") <= 2048),
	CONSTRAINT "saved_words_source_title_len" CHECK (length("saved_words"."source_title") <= 300),
	CONSTRAINT "saved_words_pdf_fingerprint_hex" CHECK ("saved_words"."pdf_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "saved_words_pdf_page_range" CHECK ("saved_words"."pdf_page" BETWEEN 1 AND 5000),
	CONSTRAINT "saved_words_pdf_fields_only_for_pdf" CHECK ("saved_words"."source_kind" = 'pdf' OR ("saved_words"."pdf_fingerprint" IS NULL AND "saved_words"."pdf_page" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"fingerprint" char(64) NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"object_key" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "uploads_reserved_bytes_range" CHECK ("uploads"."reserved_bytes" BETWEEN 1 AND 15728640),
	CONSTRAINT "uploads_status" CHECK ("uploads"."status" IN ('pending','completed','aborted','expired')),
	CONSTRAINT "uploads_fingerprint_hex" CHECK ("uploads"."fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"google_sub" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"change_seq" bigint DEFAULT 0 NOT NULL,
	"tombstone_floor_seq" bigint DEFAULT 0 NOT NULL,
	"storage_quota_bytes" bigint DEFAULT 104857600 NOT NULL,
	"storage_used_bytes" bigint DEFAULT 0 NOT NULL,
	"storage_reserved_bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub"),
	CONSTRAINT "users_google_sub_len" CHECK (length("users"."google_sub") BETWEEN 1 AND 255),
	CONSTRAINT "users_email_len" CHECK (length("users"."email") <= 320),
	CONSTRAINT "users_display_name_len" CHECK (length("users"."display_name") <= 200),
	CONSTRAINT "storage_nonneg" CHECK ("users"."storage_used_bytes" >= 0 AND "users"."storage_reserved_bytes" >= 0),
	CONSTRAINT "storage_within_quota" CHECK ("users"."storage_used_bytes" + "users"."storage_reserved_bytes" <= "users"."storage_quota_bytes")
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_hash" "bytea" NOT NULL,
	"csrf_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "web_sessions_session_hash_unique" UNIQUE("session_hash")
);
--> statement-breakpoint
CREATE TABLE "word_chat_messages" (
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"word_key" char(64) NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone NOT NULL,
	"seq" bigint NOT NULL,
	CONSTRAINT "word_chat_messages_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "word_chat_role" CHECK ("word_chat_messages"."role" IN ('user','assistant')),
	CONSTRAINT "word_chat_content_len" CHECK (length("word_chat_messages"."content") BETWEEN 1 AND 4000),
	CONSTRAINT "word_chat_model_len" CHECK (length("word_chat_messages"."model") <= 128),
	CONSTRAINT "word_chat_user_content_len" CHECK ("word_chat_messages"."role" <> 'user' OR length("word_chat_messages"."content") <= 2000),
	CONSTRAINT "word_chat_model_iff_assistant" CHECK (("word_chat_messages"."role" = 'assistant') = ("word_chat_messages"."model" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_document_fk" FOREIGN KEY ("user_id","fingerprint") REFERENCES "public"."documents"("user_id","fingerprint") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_words" ADD CONSTRAINT "saved_words_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "word_chat_messages" ADD CONSTRAINT "word_chat_messages_word_fk" FOREIGN KEY ("user_id","word_key") REFERENCES "public"."saved_words"("user_id","word_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_seq" ON "documents" USING btree ("user_id","seq");--> statement-breakpoint
CREATE INDEX "documents_recent" ON "documents" USING btree ("user_id","client_modified_at" DESC NULLS LAST) WHERE "documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "highlights_seq" ON "highlights" USING btree ("user_id","seq");--> statement-breakpoint
CREATE INDEX "highlights_doc" ON "highlights" USING btree ("user_id","fingerprint") WHERE "highlights"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idempotency_keys_created" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "object_deletions_due" ON "object_deletions" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "saved_words_seq" ON "saved_words" USING btree ("user_id","seq");--> statement-breakpoint
CREATE INDEX "saved_words_list" ON "saved_words" USING btree ("user_id","created_at" DESC NULLS LAST,"word_key") WHERE "saved_words"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uploads_one_pending" ON "uploads" USING btree ("user_id","fingerprint") WHERE "uploads"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "uploads_expiry" ON "uploads" USING btree ("expires_at") WHERE "uploads"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "web_sessions_user" ON "web_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_by_word" ON "word_chat_messages" USING btree ("user_id","word_key","created_at","id");--> statement-breakpoint
CREATE INDEX "chat_seq" ON "word_chat_messages" USING btree ("user_id","seq");