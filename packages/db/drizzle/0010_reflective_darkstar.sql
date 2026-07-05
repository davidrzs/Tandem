ALTER TABLE "documents" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX "documents_tags_idx" ON "documents" USING gin ("tags");