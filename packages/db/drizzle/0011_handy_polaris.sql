CREATE TABLE "document_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"ydoc_state" "bytea" NOT NULL,
	"authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kind" text DEFAULT 'auto' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_snapshots" ADD CONSTRAINT "document_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_snapshots" ADD CONSTRAINT "document_snapshots_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_snapshots_doc_idx" ON "document_snapshots" USING btree ("document_id","created_at");--> statement-breakpoint
-- RLS: readable to members of a readable document; writes are system-only
-- (no INSERT/UPDATE/DELETE grant), so snapshots can't be forged or edited
-- through any client path.
GRANT SELECT ON "document_snapshots" TO app_user;--> statement-breakpoint
ALTER TABLE "document_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "document_snapshots_select" ON "document_snapshots" FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = "document_snapshots"."document_id"
      AND d.deleted_at IS NULL
      AND d.collection_id IN (SELECT app_readable_collections())
  )
);