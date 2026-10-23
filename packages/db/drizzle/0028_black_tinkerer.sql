ALTER TABLE "templates" ADD COLUMN "defaults" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_default_type_id_document_types_id_fk" FOREIGN KEY ("default_type_id") REFERENCES "public"."document_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Only an owner or admin sets a template's type and defaults; the service
-- checks the role, the policies keep the type inside the template's workspace.
GRANT UPDATE (default_type_id, defaults) ON "templates" TO app_user;--> statement-breakpoint
DROP POLICY "templates_insert" ON "templates";--> statement-breakpoint
CREATE POLICY "templates_insert" ON "templates" FOR INSERT WITH CHECK (
  "created_by" = current_setting('app.user_id', true)
  AND EXISTS (SELECT 1 FROM documents d WHERE d.id = "templates"."document_id" AND d.deleted_at IS NULL AND d.workspace_id = "templates"."workspace_id" AND d.collection_id IN (SELECT app_writable_collections()))
  AND ("default_type_id" IS NULL OR EXISTS (SELECT 1 FROM document_types t WHERE t.id = "templates"."default_type_id" AND t.workspace_id = "templates"."workspace_id"))
);--> statement-breakpoint
DROP POLICY "templates_update" ON "templates";--> statement-breakpoint
CREATE POLICY "templates_update" ON "templates" FOR UPDATE USING (
  EXISTS (SELECT 1 FROM documents d WHERE d.id = "templates"."document_id" AND d.collection_id IN (SELECT app_writable_collections()))
) WITH CHECK (
  EXISTS (SELECT 1 FROM documents d WHERE d.id = "templates"."document_id" AND d.collection_id IN (SELECT app_writable_collections()))
  AND ("default_type_id" IS NULL OR EXISTS (SELECT 1 FROM document_types t WHERE t.id = "templates"."default_type_id" AND t.workspace_id = "templates"."workspace_id"))
);
