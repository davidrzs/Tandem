CREATE TABLE "document_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_key_aliases" (
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"field_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_key_aliases_field_id_key_pk" PRIMARY KEY("field_id","key")
);
--> statement-breakpoint
CREATE TABLE "type_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type_id" uuid,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retired_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "type_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "properties" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "property_issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "properties_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Property text joins search: the generated column is rebuilt over it.
ALTER TABLE "documents" drop column "search_vector";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(content_md, '')), 'B') || setweight(to_tsvector('simple', coalesce(properties_text, '')), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "documents_search_idx" ON "documents" USING gin ("search_vector");--> statement-breakpoint
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_key_aliases" ADD CONSTRAINT "field_key_aliases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_key_aliases" ADD CONSTRAINT "field_key_aliases_field_id_type_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."type_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "type_fields" ADD CONSTRAINT "type_fields_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "type_fields" ADD CONSTRAINT "type_fields_type_id_document_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."document_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_types_name_unique" ON "document_types" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "field_key_aliases_workspace_idx" ON "field_key_aliases" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "type_fields_workspace_idx" ON "type_fields" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "type_fields_live_key_unique" ON "type_fields" USING btree ("workspace_id",coalesce("type_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("key")) WHERE "type_fields"."retired_at" IS NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_type_id_document_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."document_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Types, fields and aliases are visible to every workspace member; only an
-- owner or admin defines them. Fields are retired, never deleted, and
-- aliases are append-only.
GRANT SELECT, INSERT, UPDATE, DELETE ON "document_types" TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "type_fields" TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT ON "field_key_aliases" TO app_user;--> statement-breakpoint
ALTER TABLE "document_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "type_fields" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "field_key_aliases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "document_types_select" ON "document_types" FOR SELECT USING ("workspace_id" IN (SELECT app_current_workspaces()));--> statement-breakpoint
CREATE POLICY "document_types_insert" ON "document_types" FOR INSERT WITH CHECK ("workspace_id" IN (SELECT app_admin_workspaces()) AND "created_by" = current_setting('app.user_id', true));--> statement-breakpoint
CREATE POLICY "document_types_update" ON "document_types" FOR UPDATE USING ("workspace_id" IN (SELECT app_admin_workspaces())) WITH CHECK ("workspace_id" IN (SELECT app_admin_workspaces()));--> statement-breakpoint
CREATE POLICY "document_types_delete" ON "document_types" FOR DELETE USING ("workspace_id" IN (SELECT app_admin_workspaces()));--> statement-breakpoint
CREATE POLICY "type_fields_select" ON "type_fields" FOR SELECT USING ("workspace_id" IN (SELECT app_current_workspaces()));--> statement-breakpoint
CREATE POLICY "type_fields_insert" ON "type_fields" FOR INSERT WITH CHECK ("workspace_id" IN (SELECT app_admin_workspaces()) AND "created_by" = current_setting('app.user_id', true) AND ("type_id" IS NULL OR EXISTS (SELECT 1 FROM document_types t WHERE t.id = "type_fields"."type_id" AND t.workspace_id = "type_fields"."workspace_id")));--> statement-breakpoint
CREATE POLICY "type_fields_update" ON "type_fields" FOR UPDATE USING ("workspace_id" IN (SELECT app_admin_workspaces())) WITH CHECK ("workspace_id" IN (SELECT app_admin_workspaces()) AND ("type_id" IS NULL OR EXISTS (SELECT 1 FROM document_types t WHERE t.id = "type_fields"."type_id" AND t.workspace_id = "type_fields"."workspace_id")));--> statement-breakpoint
CREATE POLICY "field_key_aliases_select" ON "field_key_aliases" FOR SELECT USING ("workspace_id" IN (SELECT app_current_workspaces()));--> statement-breakpoint
CREATE POLICY "field_key_aliases_insert" ON "field_key_aliases" FOR INSERT WITH CHECK ("workspace_id" IN (SELECT app_admin_workspaces()) AND EXISTS (SELECT 1 FROM type_fields f WHERE f.id = "field_key_aliases"."field_id" AND f.workspace_id = "field_key_aliases"."workspace_id"));
