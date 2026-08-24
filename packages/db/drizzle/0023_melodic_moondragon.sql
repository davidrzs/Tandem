CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "documents_title_trgm_idx" ON "documents" USING gin (lower("title") gin_trgm_ops) WHERE "documents"."deleted_at" IS NULL AND "documents"."archived_at" IS NULL;
