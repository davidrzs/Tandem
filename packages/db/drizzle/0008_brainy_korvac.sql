CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"parent_id" uuid,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"anchor" text,
	"head" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_document_idx" ON "comments" USING btree ("document_id");--> statement-breakpoint
-- Comments follow document visibility: read a doc -> read/write its threads.
-- author_id is pinned to the acting user on INSERT; only resolved_at is
-- updatable (no comment editing); deleting is the author's alone.
GRANT SELECT, INSERT, DELETE ON "comments" TO app_user;--> statement-breakpoint
GRANT UPDATE (resolved_at) ON "comments" TO app_user;--> statement-breakpoint
ALTER TABLE "comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "comments_select" ON "comments" FOR SELECT USING (
  EXISTS (SELECT 1 FROM documents d WHERE d.id = "comments"."document_id" AND d.deleted_at IS NULL AND d.collection_id IN (SELECT app_readable_collections()))
);--> statement-breakpoint
CREATE POLICY "comments_insert" ON "comments" FOR INSERT WITH CHECK (
  "author_id" = current_setting('app.user_id', true)
  AND EXISTS (SELECT 1 FROM documents d WHERE d.id = "comments"."document_id" AND d.deleted_at IS NULL AND d.workspace_id = "comments"."workspace_id" AND d.collection_id IN (SELECT app_readable_collections()))
);--> statement-breakpoint
CREATE POLICY "comments_update" ON "comments" FOR UPDATE USING (
  "author_id" = current_setting('app.user_id', true)
  OR EXISTS (SELECT 1 FROM documents d WHERE d.id = "comments"."document_id" AND d.collection_id IN (SELECT app_writable_collections()))
);--> statement-breakpoint
CREATE POLICY "comments_delete" ON "comments" FOR DELETE USING ("author_id" = current_setting('app.user_id', true));
