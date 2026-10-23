CREATE TABLE "tasks" (
	"document_id" uuid NOT NULL,
	"block_id" text NOT NULL,
	"text" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"handles" text[] DEFAULT '{}' NOT NULL,
	"position" integer NOT NULL,
	"created_by" text,
	"ai" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "tasks_document_id_block_id_pk" PRIMARY KEY("document_id","block_id")
);
--> statement-breakpoint
DROP INDEX "documents_task_assignees_idx";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_handles_idx" ON "tasks" USING gin ("handles");--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "task_assignees";--> statement-breakpoint
-- Task rows follow their page: readable with a readable page, written by the
-- save of a writable one. Pages saved before this migration get their rows
-- from the server's backfill at boot.
GRANT SELECT, INSERT, UPDATE, DELETE ON "tasks" TO app_user;--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tasks_select" ON "tasks" FOR SELECT USING (
  EXISTS (SELECT 1 FROM documents d WHERE d.id = "tasks"."document_id" AND d.collection_id IN (SELECT app_readable_collections()))
);--> statement-breakpoint
CREATE POLICY "tasks_insert" ON "tasks" FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM documents d WHERE d.id = "tasks"."document_id" AND d.collection_id IN (SELECT app_writable_collections()))
);--> statement-breakpoint
CREATE POLICY "tasks_update" ON "tasks" FOR UPDATE USING (
  EXISTS (SELECT 1 FROM documents d WHERE d.id = "tasks"."document_id" AND d.collection_id IN (SELECT app_writable_collections()))
) WITH CHECK (
  EXISTS (SELECT 1 FROM documents d WHERE d.id = "tasks"."document_id" AND d.collection_id IN (SELECT app_writable_collections()))
);--> statement-breakpoint
CREATE POLICY "tasks_delete" ON "tasks" FOR DELETE USING (
  EXISTS (SELECT 1 FROM documents d WHERE d.id = "tasks"."document_id" AND d.collection_id IN (SELECT app_writable_collections()))
);
