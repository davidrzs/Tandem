CREATE TABLE "collection_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_permissions_unique" UNIQUE("collection_id","principal_type","principal_id")
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN "default_role" text DEFAULT 'read_write' NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_permissions" ADD CONSTRAINT "collection_permissions_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_permissions_collection_idx" ON "collection_permissions" USING btree ("collection_id");--> statement-breakpoint
CREATE INDEX "group_members_user_idx" ON "group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "groups_workspace_idx" ON "groups" USING btree ("workspace_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_readable_collections() RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT c.id FROM collections c
  WHERE c.workspace_id IN (SELECT app_current_workspaces())
    AND (
      EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = c.workspace_id AND m.user_id = current_setting('app.user_id', true) AND m.role IN ('owner','admin'))
      OR c.default_role IN ('read','read_write')
      OR EXISTS (SELECT 1 FROM collection_permissions p WHERE p.collection_id = c.id AND p.role IN ('read','read_write') AND (
            (p.principal_type = 'user' AND p.principal_id = current_setting('app.user_id', true))
         OR (p.principal_type = 'group' AND p.principal_id IN (SELECT group_id::text FROM group_members WHERE user_id = current_setting('app.user_id', true)))
      ))
    )
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_writable_collections() RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT c.id FROM collections c
  WHERE c.workspace_id IN (SELECT app_current_workspaces())
    AND (
      EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = c.workspace_id AND m.user_id = current_setting('app.user_id', true) AND m.role IN ('owner','admin'))
      OR c.default_role = 'read_write'
      OR EXISTS (SELECT 1 FROM collection_permissions p WHERE p.collection_id = c.id AND p.role = 'read_write' AND (
            (p.principal_type = 'user' AND p.principal_id = current_setting('app.user_id', true))
         OR (p.principal_type = 'group' AND p.principal_id IN (SELECT group_id::text FROM group_members WHERE user_id = current_setting('app.user_id', true)))
      ))
    )
$$;--> statement-breakpoint
-- Row-argument variants for the COLLECTIONS policies. They take the row's own
-- columns (no re-query of `collections`), so INSERT ... RETURNING works (a
-- STABLE function can't see the in-flight row if it re-queries the table).
CREATE OR REPLACE FUNCTION app_can_read_collection(cid uuid, wsid uuid, droll text) RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT wsid IN (SELECT app_current_workspaces()) AND (
    EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = wsid AND m.user_id = current_setting('app.user_id', true) AND m.role IN ('owner','admin'))
    OR droll IN ('read','read_write')
    OR EXISTS (SELECT 1 FROM collection_permissions p WHERE p.collection_id = cid AND p.role IN ('read','read_write') AND (
          (p.principal_type = 'user' AND p.principal_id = current_setting('app.user_id', true))
       OR (p.principal_type = 'group' AND p.principal_id IN (SELECT group_id::text FROM group_members WHERE user_id = current_setting('app.user_id', true)))
    ))
  )
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_can_write_collection(cid uuid, wsid uuid, droll text) RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT wsid IN (SELECT app_current_workspaces()) AND (
    EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = wsid AND m.user_id = current_setting('app.user_id', true) AND m.role IN ('owner','admin'))
    OR droll = 'read_write'
    OR EXISTS (SELECT 1 FROM collection_permissions p WHERE p.collection_id = cid AND p.role = 'read_write' AND (
          (p.principal_type = 'user' AND p.principal_id = current_setting('app.user_id', true))
       OR (p.principal_type = 'group' AND p.principal_id IN (SELECT group_id::text FROM group_members WHERE user_id = current_setting('app.user_id', true)))
    ))
  )
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_readable_collections() TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_writable_collections() TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_can_read_collection(uuid, uuid, text) TO app_user;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_can_write_collection(uuid, uuid, text) TO app_user;--> statement-breakpoint
DROP POLICY "collections_member_all" ON "collections";--> statement-breakpoint
DROP POLICY "documents_member_all" ON "documents";--> statement-breakpoint
CREATE POLICY "collections_read" ON "collections" FOR SELECT USING (app_can_read_collection("id", "workspace_id", "default_role"));--> statement-breakpoint
CREATE POLICY "collections_insert" ON "collections" FOR INSERT WITH CHECK ("workspace_id" IN (SELECT app_current_workspaces()));--> statement-breakpoint
CREATE POLICY "collections_update" ON "collections" FOR UPDATE USING (app_can_write_collection("id", "workspace_id", "default_role")) WITH CHECK (app_can_write_collection("id", "workspace_id", "default_role"));--> statement-breakpoint
CREATE POLICY "collections_delete" ON "collections" FOR DELETE USING (app_can_write_collection("id", "workspace_id", "default_role"));--> statement-breakpoint
CREATE POLICY "documents_read" ON "documents" FOR SELECT USING ("collection_id" IN (SELECT app_readable_collections()));--> statement-breakpoint
CREATE POLICY "documents_insert" ON "documents" FOR INSERT WITH CHECK ("collection_id" IN (SELECT app_writable_collections()));--> statement-breakpoint
CREATE POLICY "documents_update" ON "documents" FOR UPDATE USING ("collection_id" IN (SELECT app_writable_collections())) WITH CHECK ("collection_id" IN (SELECT app_writable_collections()));--> statement-breakpoint
CREATE POLICY "documents_delete" ON "documents" FOR DELETE USING ("collection_id" IN (SELECT app_writable_collections()));
