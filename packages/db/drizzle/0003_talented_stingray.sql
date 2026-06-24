CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_unique" UNIQUE("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "collections" DROP CONSTRAINT "collections_slug_unique";--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "workspace_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "workspace_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collections_workspace_idx" ON "collections" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_workspace_slug_unique" UNIQUE("workspace_id","slug");--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user NOLOGIN; END IF; END $$;--> statement-breakpoint
GRANT app_user TO current_user;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspaces", "workspace_members", "collections", "documents" TO app_user;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_workspaces() RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$ SELECT workspace_id FROM workspace_members WHERE user_id = current_setting('app.user_id', true) $$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_workspaces() TO app_user;--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "collections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workspaces_member_read" ON "workspaces" FOR SELECT USING ("id" IN (SELECT app_current_workspaces()));--> statement-breakpoint
CREATE POLICY "workspace_members_read" ON "workspace_members" FOR SELECT USING ("workspace_id" IN (SELECT app_current_workspaces()));--> statement-breakpoint
CREATE POLICY "collections_member_all" ON "collections" FOR ALL USING ("workspace_id" IN (SELECT app_current_workspaces())) WITH CHECK ("workspace_id" IN (SELECT app_current_workspaces()));--> statement-breakpoint
CREATE POLICY "documents_member_all" ON "documents" FOR ALL USING ("workspace_id" IN (SELECT app_current_workspaces())) WITH CHECK ("workspace_id" IN (SELECT app_current_workspaces()));
