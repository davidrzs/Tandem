CREATE TABLE "images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"uploaded_by" text NOT NULL,
	"mime" text NOT NULL,
	"size" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "images_workspace_idx" ON "images" USING btree ("workspace_id");--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "images" TO app_user;--> statement-breakpoint
ALTER TABLE "images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "images_select" ON "images" FOR SELECT USING ("workspace_id" IN (SELECT app_current_workspaces()));--> statement-breakpoint
CREATE POLICY "images_insert" ON "images" FOR INSERT WITH CHECK ("workspace_id" IN (SELECT app_current_workspaces()));--> statement-breakpoint
CREATE POLICY "images_delete" ON "images" FOR DELETE USING ("workspace_id" IN (SELECT app_current_workspaces()));
