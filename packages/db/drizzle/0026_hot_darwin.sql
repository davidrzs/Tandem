CREATE TABLE "templates" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"default_type_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "default_template_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "default_template_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "origin" jsonb;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "templates_workspace_idx" ON "templates" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_default_template_id_templates_document_id_fk" FOREIGN KEY ("default_template_id") REFERENCES "public"."templates"("document_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_default_template_id_templates_document_id_fk" FOREIGN KEY ("default_template_id") REFERENCES "public"."templates"("document_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- A template follows its document: read the document -> see the template;
-- write it -> mark, rename or unmark it. created_by is pinned to the actor.
GRANT SELECT, INSERT, DELETE ON "templates" TO app_user;--> statement-breakpoint
GRANT UPDATE (name, updated_at) ON "templates" TO app_user;--> statement-breakpoint
ALTER TABLE "templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "templates_select" ON "templates" FOR SELECT USING (
  EXISTS (SELECT 1 FROM documents d WHERE d.id = "templates"."document_id" AND d.collection_id IN (SELECT app_readable_collections()))
);--> statement-breakpoint
CREATE POLICY "templates_insert" ON "templates" FOR INSERT WITH CHECK (
  "created_by" = current_setting('app.user_id', true)
  AND EXISTS (SELECT 1 FROM documents d WHERE d.id = "templates"."document_id" AND d.deleted_at IS NULL AND d.workspace_id = "templates"."workspace_id" AND d.collection_id IN (SELECT app_writable_collections()))
);--> statement-breakpoint
CREATE POLICY "templates_update" ON "templates" FOR UPDATE USING (
  EXISTS (SELECT 1 FROM documents d WHERE d.id = "templates"."document_id" AND d.collection_id IN (SELECT app_writable_collections()))
);--> statement-breakpoint
CREATE POLICY "templates_delete" ON "templates" FOR DELETE USING (
  EXISTS (SELECT 1 FROM documents d WHERE d.id = "templates"."document_id" AND d.collection_id IN (SELECT app_writable_collections()))
);